'use strict';

const crypto = require('node:crypto');
const RANK_PATH = '/shop/chance/merchandise-product-rank';
const ROWS = 'tr.aurora-table-row:visible, tr.ecom-table-row:visible';
const POPOVER_CARDS = '.aurora-popover:visible [class*=videoItem-], .ecom-popover:visible [class*=videoItem-]';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const changed = message => Object.assign(new Error(message || '当前页面内容已变化，请重新读取并选择视频。'), { code: 'PAGE_CHANGED' });

function accepts(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'compass.jinritemai.com' && parsed.pathname === RANK_PATH; }
  catch { return false; }
}

function publicVideoUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && /^(?:www\.)?douyin\.com$/.test(url.hostname) && /^\/video\/\d+\/?$/.test(url.pathname)) return `https://www.douyin.com${url.pathname.replace(/\/$/, '')}`;
  } catch { /* A media address is not a public page link. */ }
  return null;
}

function identity(card) {
  const publicUrl = publicVideoUrl(card.href);
  const videoId = /^\d+$/.test(card.videoId || '') ? card.videoId : publicUrl?.match(/\/video\/(\d+)/)?.[1];
  let cover = '';
  try { const url = new URL(card.cover); cover = url.origin + url.pathname; } catch { /* no observed cover */ }
  const title = clean(card.title);
  return { ...card, cover, coverUrl: card.cover || '', title, publicUrl, videoId: videoId || null,
    cardKey: hash(videoId ? ['video', videoId] : cover ? ['cover', cover] : ['title', title]), strong: Boolean(videoId || publicUrl), observable: Boolean(videoId || publicUrl || title || cover) };
}

// This function is serialized into the leased page; it only reads visible DOM.
function readCard(element) {
  const text = element.querySelector('[class*=videoName-]')?.textContent || element.getAttribute('title') || element.querySelector('img')?.alt || '';
  const link = element.matches('a[href]') ? element : element.querySelector('a[href]');
  return { title: text.trim(), videoId: element.getAttribute('data-video-id') || element.getAttribute('data-aweme-id') || '',
    href: link?.href || '', cover: element.querySelector('img')?.currentSrc || element.querySelector('img')?.src || '' };
}

async function pageIdentity(page) {
  return page.evaluate(() => {
    const visible = node => node.offsetWidth || node.offsetHeight || node.getClientRects().length;
    const rows = Array.from(document.querySelectorAll('tr.aurora-table-row, tr.ecom-table-row')).filter(visible);
    const products = rows.map(row => {
      const cells = row.querySelectorAll(':scope > td');
      return { productId: row.getAttribute('data-product-id') || '', productName: (cells[1]?.querySelector('[class*=name-]')?.innerText || cells[1]?.innerText || '').split(/\n价格带/)[0].trim(),
        shopName: (cells[3]?.querySelector('[class*=name-]')?.innerText || cells[3]?.innerText || '').trim() };
    });
    const pager = document.querySelector('.aurora-pagination-item-active, .ecom-pagination-item-active');
    const category = Array.from(document.querySelectorAll('.aurora-cascader, .ecom-cascader')).filter(visible).map(node => node.innerText.trim()).join(' / ');
    const tabs = Array.from(document.querySelectorAll('[role=tab][aria-selected=true]')).filter(visible).map(node => node.innerText.trim());
    const brands = Array.from(document.querySelectorAll('[class*=activeItem]')).filter(visible).map(node => node.innerText.trim());
    const player = Array.from(document.querySelectorAll('.auxo-dorami-video-container, .ecom-dorami-video-container')).filter(visible).at(-1);
    const video = player?.querySelector('video');
    return { products, page: pager?.innerText.trim() || '1', category, tabs, brands,
      player: { videoId: video?.getAttribute?.('data-video-id') || player?.getAttribute('data-video-id') || '', url: video?.currentSrc || '' } };
  });
}

async function readProductCards(page, rowIndex, boundary = async () => {}, options = {}) {
  const row = page.locator(ROWS).nth(rowIndex);
  const visible = row.locator('[class*=videoWrapper-]:visible');
  const cards = [];
  const count = await visible.count();
  for (let index = 0; index < count; index += 1) {
    await boundary();
    const card = visible.nth(index);
    let value = await card.evaluate(readCard);
    if (!value.title && options.readTitles !== false && (options.titleBudget === undefined || options.titleBudget > 0)) {
      if (options.titleBudget !== undefined) options.titleBudget -= 1;
      await card.hover({ timeout: 3000 });
      let title = '';
      for (let attempt = 0; attempt < (options.titleAttempts || 5); attempt += 1) {
        await boundary();
        title = await page.evaluate(cover => {
          const canonical = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return ''; } };
          const expected = canonical(cover);
          if (!expected) return '';
          const matches = Array.from(document.querySelectorAll('.aurora-popover, .ecom-popover'))
            .filter(node => node.getClientRects().length && Array.from(node.querySelectorAll('img'))
              .some(image => canonical(image.currentSrc || image.src) === expected));
          return matches.length === 1 ? matches[0].querySelector('[class*=videoName-]')?.textContent?.trim() || '' : '';
        }, value.cover);
        if (title) break;
        await page.waitForTimeout(options.titlePause || 200);
      }
      value = { ...value, title };
    }
    cards.push(identity({ ...value, rowIndex, cardIndex: index, fromPopover: false }));
  }
  const more = row.locator('[class*=moreVideo-]:visible').first();
  if (await more.count()) {
    await boundary();
    await more.hover({ timeout: 3000 });
    await page.waitForTimeout(250);
    const extras = page.locator(POPOVER_CARDS);
    const expanded = [];
    for (let index = 0; index < await extras.count(); index += 1) {
      await boundary();
      expanded.push(identity({ ...await extras.nth(index).evaluate(readCard), rowIndex, cardIndex: index, fromPopover: true }));
    }
    const repeatsVisiblePrefix = cards.length > 0 && expanded.length >= cards.length
      && cards.every((card, index) => card.observable && expanded[index].cardKey === card.cardKey);
    if (repeatsVisiblePrefix) cards.push(...expanded.slice(cards.length));
    else for (const card of expanded) {
      // Without a complete ordered prefix, only deduplicate an observed native identity.
      if (!card.strong || !cards.some(old => old.strong && old.videoId === card.videoId)) cards.push(card);
    }
  }
  return cards;
}

function productKey(product) { return hash([product.productId || '', clean(product.productName), clean(product.shopName)]); }

async function snapshot(page, pageId, boundary, options = {}) {
  const state = await pageIdentity(page);
  const rows = [];
  for (let index = 0; index < state.products.length; index += 1) {
    rows.push({ ...state.products[index], productKey: productKey(state.products[index]), cards: await readProductCards(page, index, boundary, options) });
  }
  const after = await pageIdentity(page);
  const pageKey = value => JSON.stringify([value.products, value.page, value.category, value.tabs, value.brands]);
  if (pageKey(state) !== pageKey(after)) throw changed();
  const key = hash([pageId, state.page, state.category, state.tabs, state.brands,
    rows.map(row => [row.productKey, row.cards.map(card => card.cardKey)])]);
  const pageFingerprint = hash([pageId, state.page, state.category, state.tabs, state.brands, state.products]);
  return { ...state, rows, key, pageKey: pageFingerprint };
}

function captureItems(view, pageId, sourcePage) {
  const items = [];
  for (const row of view.rows) {
    const frequencies = new Map();
    for (const card of row.cards) frequencies.set(card.cardKey, (frequencies.get(card.cardKey) || 0) + 1);
    for (const card of row.cards) {
      if (!card.observable || frequencies.get(card.cardKey) !== 1) continue;
      const videoKey = card.strong ? `video:${card.videoId}` : card.cover ? `page:${view.pageKey || view.key}` : `snapshot:${view.key}`;
      const mediaUrl = view.player?.videoId && view.player.videoId === card.videoId && view.player.url?.startsWith('https://') ? view.player.url : null;
      items.push({ sourceKey: card.strong ? `compass:video:${card.videoId}` : `compass:${row.productKey}:${videoKey}:${card.cardKey}`, sourceKind: 'compass_ranking',
        sourcePage, providerId: card.videoId, title: card.title || '视频标题未读取', publicUrl: card.publicUrl, ...(mediaUrl ? { mediaUrl } : {}),
        details: { productName: row.productName, shopName: row.shopName, coverUrl: card.coverUrl || '', sourceLabel: '罗盘短视频榜',
          titleKnown: Boolean(card.title), videoIndex: row.cards.indexOf(card) + 1 },
        locator: { pageId, productKey: row.productKey, ...(row.productId ? { productId: row.productId } : {}),
          ...(card.videoId ? { videoId: card.videoId } : {}), videoKey, cardKey: card.cardKey, category: view.category, rankingType: 'video' } });
    }
  }
  return items;
}

function locate(view, item) {
  const locator = item.locator;
  if (locator?.category && locator.category !== view.category) throw changed();
  if (!locator || (locator.videoKey?.startsWith('snapshot:') && locator.videoKey !== `snapshot:${view.key}`)) throw changed();
  if (locator.videoKey?.startsWith('page:') && locator.videoKey !== `page:${view.pageKey || view.key}`) throw changed();
  const products = view.rows.filter(row => row.productKey === locator.productKey);
  if (products.length !== 1) throw changed('商品已变化或定位不唯一，请重新读取当前页面。');
  const matches = products[0].cards.filter(card => card.cardKey === locator.cardKey && (!locator.videoId || card.videoId === locator.videoId));
  if (matches.length !== 1) throw changed();
  return matches[0];
}

async function closePlayer(page) {
  const close = page.locator('.auxo-dorami-video-header:visible [class*=closeIcon-], .ecom-dorami-video-header:visible [class*=closeIcon-]').last();
  if (await close.count()) await close.click().catch(() => {});
}

async function playCard(page, card) {
  await closePlayer(page);
  const row = page.locator(ROWS).nth(card.rowIndex);
  if (card.fromPopover) { await row.locator('[class*=moreVideo-]:visible').first().hover({ timeout: 3000 }); await page.waitForTimeout(250); }
  const element = card.fromPopover ? page.locator(POPOVER_CARDS).nth(card.cardIndex) : row.locator('[class*=videoWrapper-]:visible').nth(card.cardIndex);
  const raw = await element.evaluate(readCard);
  const observed = identity({ ...raw, title: raw.title || card.title });
  if (observed.cardKey !== card.cardKey) throw changed();
  const media = [];
  let resolvePopup;
  const popup = new Promise(resolve => { resolvePopup = resolve; });
  const onPopup = opened => { opened.close().catch(() => {}); resolvePopup('external'); };
  const onResponse = response => {
    const type = (response.headers()['content-type'] || '').toLowerCase();
    if (response.status() < 400 && (type.startsWith('video/') || type.startsWith('audio/'))) media.push({ url: response.url(), type });
  };
  page.on('response', onResponse); page.on('popup', onPopup);
  try {
    await element.click({ timeout: 3000 });
    const opened = await Promise.race([popup, page.waitForFunction(() => Array.from(document.querySelectorAll('.auxo-dorami-video-container, .ecom-dorami-video-container'))
      .some(node => { const video = node.querySelector('video'); return node.getClientRects().length && video
        && (video.error || (video.currentSrc && video.readyState >= 2)); }), null, { timeout: 7000 }).then(() => 'player')]);
    if (opened === 'external') throw Object.assign(new Error('此卡片打开了外部页面，请复制公开链接后下载。'), { code: 'UNSUPPORTED_SOURCE' });
    const player = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll('.auxo-dorami-video-container, .ecom-dorami-video-container')).filter(item => item.getClientRects().length).at(-1);
      const video = node?.querySelector('video');
      return { url: video?.currentSrc || '', readyState: video?.readyState || 0, error: video?.error?.code || null, caption: node?.querySelector('.auxo-dorami-video-title .auxo-dorami-atom-text, .ecom-dorami-video-title .ecom-dorami-atom-text')?.textContent?.trim() || '' };
    });
    if (player.error) throw Object.assign(new Error('此视频在平台播放器中无法播放，可跳过或稍后重试。'), { code: 'MEDIA_UNAVAILABLE' });
    if (player.readyState < 2) throw Object.assign(new Error('平台播放器尚未准备好视频，请稍后重试。'), { code: 'MEDIA_UNAVAILABLE' });
    const videoUrl = player.url.startsWith('https://') ? player.url : media.find(item => item.type.startsWith('video/'))?.url;
    if (!videoUrl) throw Object.assign(new Error('正常播放后没有取得可下载媒体地址。'), { code: 'MEDIA_UNAVAILABLE' });
    return { videoUrl, audioUrl: media.find(item => item.type.startsWith('audio/'))?.url || null, caption: clean(player.caption) && !['-', '--'].includes(clean(player.caption)) ? clean(player.caption) : card.title };
  } finally { page.off('response', onResponse); page.off('popup', onPopup); }
}

module.exports = { accepts, publicVideoUrl, identity, productKey, pageIdentity, readProductCards, snapshot, captureItems, locate, playCard, closePlayer, changed };
