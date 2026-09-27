'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { connectTargetPage } = require('./edge');
const { ROOT, VIDEO_DIR, atomicWrite, saveTask, appendLog } = require('./task-store');

const PERIODS = new Map([['实时', 'realTime'], ['近1天', 'one'], ['近7天', 'seven'], ['近30天', 'thirty']]);
const BRANDS = ['不限', '知名品牌', '非知名品牌'];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

async function retryOnce(operation) {
  try { return await operation(); }
  catch {
    await pause(600);
    return operation();
  }
}

async function readPageOptions(page) {
  const periods = await page.evaluate((known) => Array.from(document.querySelectorAll('[role="tab"]')).flatMap((tab) => {
    if (!(tab.offsetWidth || tab.offsetHeight || tab.getClientRects().length)) return [];
    const label = (tab.innerText || tab.textContent || '').replace(/\s+/g, ' ').trim();
    if (!known.includes(label)) return [];
    return [{ label, value: ({ '实时': 'realTime', '近1天': 'one', '近7天': 'seven', '近30天': 'thirty' })[label], disabled: tab.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(tab.className)) }];
  }), [...PERIODS.keys()]);
  const brands = await page.evaluate((values) => {
    const label = Array.from(document.querySelectorAll('label')).find((item) => item.getAttribute('title') === '品牌类型');
    const row = label?.parentElement?.parentElement?.parentElement;
    return Array.from(row?.querySelectorAll('[data-btm]') || []).map((item) => (item.innerText || '').trim()).filter((text) => values.includes(text));
  }, BRANDS);
  const activeCategory = await page.locator('.aurora-cascader:visible, .ecom-cascader:visible').evaluateAll((items) => items.map((item) => item.innerText.trim()));
  return { periods: periods.filter((item) => !item.disabled), brands: [...new Set(brands)], activeCategory };
}

async function openIndustryCascade(page) {
  const control = page.locator('.aurora-cascader:visible, .ecom-cascader:visible').first();
  if (!(await control.count())) throw new Error('未找到行业类目选择器');
  await control.click();
  await page.waitForTimeout(350);
  return control;
}

async function menuState(page, depth) {
  return page.evaluate((index) => Array.from(document.querySelectorAll('.aurora-cascader-menu, .ecom-cascader-menu'))
    .filter((menu) => menu.offsetWidth || menu.offsetHeight || menu.getClientRects().length)
    .map((menu) => Array.from(menu.querySelectorAll(':scope > li')).filter((item) => item.offsetWidth || item.offsetHeight || item.getClientRects().length)
      .map((item) => ({ text: (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim(), expandable: /expand/.test(item.className), disabled: /disabled/.test(item.className) || item.getAttribute('aria-disabled') === 'true' })))[index] || [], depth);
}

async function clickMenuItem(page, depth, label) {
  const menus = page.locator('.aurora-cascader-menu:visible, .ecom-cascader-menu:visible');
  const menu = menus.nth(depth);
  const candidates = menu.locator(':scope > li');
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const item = candidates.nth(index);
    if (cleanText(await item.innerText()) === label) { await item.click(); await pause(220); return; }
  }
  throw new Error(`类目菜单第 ${depth + 1} 层未找到“${label}”`);
}

async function discoverCategories(page, log = () => {}) {
  await openIndustryCascade(page);
  const results = [];
  let visited = 0;
  async function walk(depth, prefix) {
    const items = await menuState(page, depth);
    for (const item of items) {
      if (!item.text || item.disabled) continue;
      visited += 1;
      if (visited > 3000) throw new Error('类目节点超过安全上限，已停止读取');
      if (item.text === '全部') {
        if (prefix.length) results.push(prefix.join(' / '));
        continue;
      }
      const next = [...prefix, item.text];
      if (!item.expandable) { results.push(next.join(' / ')); continue; }
      await clickMenuItem(page, depth, item.text);
      await walk(depth + 1, next);
    }
  }
  try { await walk(0, []); } finally { await page.keyboard.press('Escape').catch(() => {}); }
  const categories = [...new Set(results)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (!categories.length) throw new Error('没有读取到可选行业类目');
  log(`已读取 ${categories.length} 个行业类目`);
  return categories;
}

async function discoverOptions(log = () => {}) {
  const { page } = await connectTargetPage();
  const original = await readPageOptions(page);
  let categories;
  try { categories = await discoverCategories(page, log); }
  finally {
    const originalCategory = original.activeCategory[0];
    if (originalCategory) await selectCategory(page, originalCategory);
  }
  const state = await readPageOptions(page);
  if (!state.periods.length) throw new Error('没有读取到页面可用的榜单周期');
  if (!state.brands.length) throw new Error('没有读取到页面可用的品牌类型');
  return { categories, brandTypes: state.brands, periods: state.periods, currentCategory: original.activeCategory[0] || '' };
}

async function selectCategory(page, value) {
  const category = page.locator('.aurora-cascader:visible, .ecom-cascader:visible').first();
  await category.click();
  await page.waitForTimeout(200);
  const segments = value.split(' / ');
  for (let depth = 0; depth < segments.length; depth += 1) await clickMenuItem(page, depth, segments[depth]);
  const finalMenu = await menuState(page, segments.length);
  if (finalMenu.some((item) => item.text === '全部' && !item.disabled)) await clickMenuItem(page, segments.length, '全部');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  const selected = cleanText(await category.innerText());
  if (selected !== value && selected !== `${value} / 全部`) throw new Error(`行业类目切换未生效：${selected}`);
}

async function applyOptions(page, parameters) {
  await selectCategory(page, parameters.category);

  const brandLabel = page.locator('label[title="品牌类型"]');
  const brandRow = brandLabel.locator('xpath=../../..');
  const brand = brandRow.getByText(parameters.brandType, { exact: true }).first();
  if (!(await brand.count())) throw new Error(`页面找不到品牌选项“${parameters.brandType}”`);
  if (!/activeItem/.test((await brand.getAttribute('class')) || '')) await brand.click();

  const period = page.getByRole('tab', { name: parameters.period, exact: true });
  if (!(await period.count())) throw new Error(`页面没有“${parameters.period}”周期选项`);
  await period.click();
  await page.waitForTimeout(1800);
  const firstPage = page.locator('.aurora-pagination-item-1, .ecom-pagination-item-1').first();
  if (await firstPage.count()) await firstPage.click().catch(() => {});
  const activePeriod = await period.getAttribute('aria-selected');
  if (activePeriod !== 'true') throw new Error(`周期“${parameters.period}”未成功激活`);
  const selectedBrand = await brand.getAttribute('class');
  if (!/activeItem/.test(selectedBrand || '')) throw new Error(`品牌类型“${parameters.brandType}”未成功激活`);
  const state = await waitForStableTable(page);
  if (!state.hasVideoTable || (!state.rows.length && state.total > 0)) throw new Error('筛选后短视频榜表格没有加载');
  return state;
}

async function tableState(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.aurora-table-row, tr.ecom-table-row'))
      .filter((row) => row.offsetWidth || row.offsetHeight || row.getClientRects().length);
    const parsed = rows.map((row, index) => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      const trendCell = cells[0];
      const trendValue = trendCell?.querySelector('.cp-change-ratio-value, [class*=tagItem-]');
      const trendText = (trendValue?.innerText || trendCell?.innerText || '').replace(/\s+/g, ' ').trim();
      const trendClasses = Array.from(trendCell?.querySelectorAll('*') || []).map((item) => String(item.className || '')).join(' ').toLowerCase();
      let trend = 'unparseable';
      if (/首次上榜/.test(trendText)) trend = 'first';
      else if (/(^|[-_\s])up([-_\s]|$)|upidentify/.test(trendClasses) || /上升|↑|↗/.test(trendText)) trend = /\d/.test(trendText) ? 'up' : 'unparseable';
      else if (/(^|[-_\s])down([-_\s]|$)|downidentify|equal/.test(trendClasses) || /下降|持平|横线/.test(trendText) || !trendText || /^[-—–]$/.test(trendText)) trend = 'other';
      const info = (cells[1]?.innerText || '').split(/\n价格带/)[0].trim();
      const nameNode = cells[1]?.querySelector('[class*=name-]');
      const productName = (nameNode?.innerText || info).trim();
      const shopNode = cells[3]?.querySelector('[class*=name-]');
      const shopName = (shopNode?.innerText || cells[3]?.innerText || '').trim();
      const videoCell = cells[2];
      const cards = Array.from(videoCell?.querySelectorAll('[class*=videoWrapper-]') || [])
        .filter((card) => card.offsetWidth || card.offsetHeight || card.getClientRects().length)
        .filter((card) => !/more|expand/i.test(String(card.className)) && !/^\s*\+\d+\s*$/.test(card.innerText || ''));
      return { trendText, trend, productName, shopName, videoCount: Math.min(cards.length, 4), rowIndex: index };
    });
    const pager = document.querySelector('.aurora-pagination, .ecom-pagination');
    const pageNumber = Number((pager?.querySelector('.aurora-pagination-item-active, .ecom-pagination-item-active')?.innerText || '1').trim()) || 1;
    const totalText = pager?.querySelector('[class*=pagination-total]')?.innerText || '';
    const total = Number((totalText.match(/[\d,]+/) || ['0'])[0].replace(/,/g, '')) || parsed.length;
    const headers = Array.from(document.querySelectorAll('table thead')).map((head) => head.innerText || '').join(' ');
    const loading = Boolean(document.querySelector('.aurora-spin-spinning, .ecom-spin-spinning, [aria-busy="true"]'));
    return { rows: parsed, page: pageNumber, total, hasVideoTable: headers.includes('带货短视频'), loading };
  });
}

async function blockingIssue(page) {
  return page.evaluate(() => {
    if (!location.pathname.includes('/shop/chance/merchandise-product-rank')) return '罗盘页面已离开短视频榜，可能需要重新登录';
    const visible = (item) => item.offsetWidth || item.offsetHeight || item.getClientRects().length;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .aurora-modal, .ecom-modal')).filter(visible);
    const text = dialogs.map((item) => item.innerText || '').join(' ');
    if (/验证码|滑动验证|请完成验证|人机验证/.test(text) ||
        Array.from(document.querySelectorAll('iframe')).some((frame) => visible(frame) && /captcha|verify/i.test(frame.src))) return '页面出现验证，请在 Edge 中手动完成后续跑';
    if (/访问受限|操作频繁|访问过于频繁|请求过于频繁|登录已失效|请重新登录/.test(text)) return '页面出现访问限制或登录失效，请在 Edge 中恢复后续跑';
    return '';
  });
}

function tableFingerprint(state) {
  return JSON.stringify([state.page, state.total, state.rows.map((row) => [row.productName, row.trendText])]);
}

async function waitForStableTable(page, minimumWait = 1500) {
  await page.waitForTimeout(minimumWait);
  const deadline = Date.now() + 15000;
  let previous = '';
  let matches = 0;
  while (Date.now() < deadline) {
    const issue = await blockingIssue(page);
    if (issue) throw new Error(issue);
    const state = await tableState(page);
    const fingerprint = tableFingerprint(state);
    if ((state.rows.length || state.total === 0) && !state.loading && fingerprint === previous) matches += 1;
    else matches = 0;
    if (matches >= 2) return state;
    previous = fingerprint;
    await page.waitForTimeout(600);
  }
  throw new Error('榜单表格未在限定时间内稳定');
}

async function nextPage(page, current) {
  const next = page.locator('.aurora-pagination-next:not(.aurora-pagination-disabled), .ecom-pagination-next:not(.ecom-pagination-disabled)').first();
  if (!(await next.count())) return false;
  await next.click();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const state = await tableState(page);
    if (state.page === current.page + 1 && state.rows.length && tableFingerprint(state) !== tableFingerprint(current)) {
      const stable = await waitForStableTable(page, 500);
      if (stable.page === current.page + 1 && tableFingerprint(stable) !== tableFingerprint(current)) return true;
    }
  }
  throw new Error(`翻页校验失败：期望从第 ${current.page} 页进入下一页`);
}

function allowedTrend(trend, mode) {
  return trend === 'first' || (mode === 'up_and_first' && trend === 'up');
}

function safePart(value, max = 80) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[ .]+$/g, '');
  const result = Array.from(cleaned).slice(0, max).join('').replace(/[ .]+$/g, '') || '视频';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `_${result}` : result;
}

function productKey(product) {
  return crypto.createHash('sha256').update(`${product.productName}\n${product.shopName}`).digest('hex').slice(0, 16);
}

function productDirectoryPath(dirname) {
  if (!dirname || dirname !== safePart(dirname, 150)) throw new Error('商品目录名无效');
  const directory = path.resolve(VIDEO_DIR, dirname);
  if (!directory.startsWith(`${path.resolve(VIDEO_DIR)}${path.sep}`)) throw new Error('商品目录不在视频根目录内');
  return directory;
}

function outputDirectory(task, rank, product) {
  task.checkpoint.productDirs ||= {};
  if (task.checkpoint.productDirs[rank]) return productDirectoryPath(task.checkpoint.productDirs[rank]);
  const id = productKey(product);
  const base = safePart(product.productName || id, 100);
  const indexFile = path.join(ROOT, 'data', 'product-directories.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  if (index[id]) {
    task.checkpoint.productDirs[rank] = index[id];
    return productDirectoryPath(index[id]);
  }
  const used = new Set([...Object.values(index), ...Object.values(task.checkpoint.productDirs)]);
  let dirname = base;
  if (used.has(dirname) || fs.existsSync(path.join(VIDEO_DIR, dirname))) dirname = `${base}_${id.slice(0, 8)}`;
  let suffix = 2;
  while (used.has(dirname) || fs.existsSync(path.join(VIDEO_DIR, dirname))) dirname = `${base}_${id.slice(0, 8)}_${suffix++}`;
  index[id] = dirname;
  atomicWrite(indexFile, index);
  task.checkpoint.productDirs[rank] = dirname;
  return productDirectoryPath(dirname);
}

function uniqueStem(directory, stem) {
  let candidate = stem;
  let suffix = 2;
  while (fs.existsSync(path.join(directory, `${candidate}.mp4`)) || fs.existsSync(path.join(directory, `${candidate}.txt`))) candidate = `${stem}_${suffix++}`;
  return candidate;
}

function isMp4(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(12);
    return fs.readSync(handle, header, 0, header.length, 0) >= 8 && header.toString('ascii', 4, 8) === 'ftyp';
  } finally { fs.closeSync(handle); }
}

async function downloadMedia(url, destination, expectedType) {
  const address = new URL(url);
  if (address.protocol !== 'https:') throw new Error('播放器返回非 HTTPS 媒体地址');
  return retryOnce(async () => {
    try {
      let response;
      try { response = await fetch(address, { signal: AbortSignal.timeout(120000) }); }
      catch (error) { throw new Error(`媒体请求失败：${error.cause?.code || error.message}`); }
      if (response.status !== 200 || !response.body) throw new Error(`媒体下载未返回完整文件：HTTP ${response.status}`);
      const mime = (response.headers.get('content-type') || '').toLowerCase();
      if (!mime.startsWith(expectedType) && !mime.startsWith('application/octet-stream')) throw new Error(`媒体类型无效：${mime || '未知'}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
      if (!fs.statSync(destination).size) throw new Error('下载文件为空');
      return mime;
    } catch (error) {
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      throw error;
    }
  });
}

async function runFfmpeg(args, destination, action) {
  const binary = process.env.FFMPEG_PATH || 'ffmpeg';
  await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-c', 'copy', '-f', 'mp4', destination],
      { windowsHide: true, signal: controller.signal });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 500); });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(error.name === 'AbortError' ? `FFmpeg ${action}超时` : `FFmpeg 无法启动：${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`FFmpeg ${action}失败：${stderr.trim() || `退出码 ${code}`}`));
    });
  });
  if (!fs.existsSync(destination) || !fs.statSync(destination).size) throw new Error(`FFmpeg ${action}文件为空`);
}

const mergeTracks = (video, audio, destination) => runFfmpeg(['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0'], destination, '合并');
const remuxVideo = (video, destination) => runFfmpeg(['-i', video], destination, '封装');

async function closePlayer(page) {
  const close = page.locator('.auxo-dorami-video-header [class*=closeIcon-]').last();
  if (await close.count()) await close.click().catch(() => {});
}

async function saveVideoFromCard(page, rowIndex, videoIndex, rank, product, task) {
  await closePlayer(page);
  const rows = page.locator('tr.aurora-table-row, tr.ecom-table-row');
  const row = rows.nth(rowIndex);
  const card = row.locator('[class*=videoWrapper-]').nth(videoIndex);
  const mediaResponses = [];
  let resolvePopup;
  const popupOpened = new Promise((resolve) => { resolvePopup = resolve; });
  const onPopup = (popup) => {
    popup.close().catch(() => {}).finally(() => resolvePopup('external'));
  };
  const onResponse = (response) => {
    const type = (response.headers()['content-type'] || '').toLowerCase();
    if (response.status() < 400 && (type.startsWith('video/') || type.startsWith('audio/'))) mediaResponses.push({ url: response.url(), type });
  };
  page.on('response', onResponse);
  page.on('popup', onPopup);
  let partial = '';
  let videoPart = '';
  let audioPart = '';
  try {
    const issue = await blockingIssue(page);
    if (issue) throw new Error(issue);
    await card.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    await page.waitForTimeout(180);
    await retryOnce(() => card.hover({ timeout: 3000 }));
    await page.waitForTimeout(300);
    let caption = await page.evaluate(() => Array.from(document.querySelectorAll('.aurora-popover'))
      .filter((popover) => popover.offsetWidth || popover.offsetHeight || popover.getClientRects().length)
      .map((popover) => popover.querySelector('[class*=videoName-]')?.textContent?.trim() || '').filter(Boolean).at(-1) || '');
    await retryOnce(() => card.click({ timeout: 3000 }));
    const playerState = await Promise.race([
      popupOpened,
      page.waitForFunction(() => Array.from(document.querySelectorAll('.auxo-dorami-video-container'))
        .some((container) => container.getClientRects().length && Boolean(container.querySelector('video')?.currentSrc)), null, { timeout: 7000 }).then(() => 'player'),
    ]);
    page.off('popup', onPopup);
    if (playerState === 'external') throw new Error('视频未在罗盘小窗播放，已跳过新开的抖音页面');
    const player = await page.evaluate(() => {
      const container = Array.from(document.querySelectorAll('.auxo-dorami-video-container')).filter((node) => node.offsetWidth || node.offsetHeight).at(-1);
      return { url: container?.querySelector('video')?.currentSrc || '', caption: container?.querySelector('.auxo-dorami-video-title .auxo-dorami-atom-text')?.textContent?.trim() || '' };
    });
    caption ||= player.caption;
    const videoUrl = player.url.startsWith('https://') ? player.url : mediaResponses.find((item) => item.type.startsWith('video/'))?.url;
    if (!videoUrl) throw new Error('正常播放后没有取得视频媒体地址');
    const audioUrl = mediaResponses.find((item) => item.type.startsWith('audio/'))?.url;
    const productDir = outputDirectory(task, rank, product);
    fs.mkdirSync(productDir, { recursive: true });
    const number = String(videoIndex + 1).padStart(2, '0');
    const stem = uniqueStem(productDir, `${number}_${safePart(caption || '视频')}`);
    const target = path.join(productDir, `${stem}.mp4`);
    partial = `${target}.part`;
    if (audioUrl) {
      videoPart = `${target}.video.part`;
      audioPart = `${target}.audio.part`;
      await downloadMedia(videoUrl, videoPart, 'video/');
      await downloadMedia(audioUrl, audioPart, 'audio/');
      await mergeTracks(videoPart, audioPart, partial);
    } else {
      videoPart = `${target}.video.part`;
      await downloadMedia(videoUrl, videoPart, 'video/');
      if (isMp4(videoPart)) fs.renameSync(videoPart, partial);
      else await remuxVideo(videoPart, partial);
    }
    fs.renameSync(partial, target);
    const output = { video: target, caption: null };
    if (caption) {
      const textFile = path.join(productDir, `${stem}.txt`);
      try { fs.writeFileSync(textFile, caption, { encoding: 'utf8', flag: 'wx' }); output.caption = textFile; }
      catch (error) {
        task.progress.captionFailures = (task.progress.captionFailures || 0) + 1;
        appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条文案保存失败，已保留视频：${error.message}`);
      }
    } else {
      task.progress.captionFailures = (task.progress.captionFailures || 0) + 1;
      appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条文案读取失败，已保留视频`);
    }
    task.checkpoint.completedVideos ||= {};
    task.checkpoint.completedVideos[`${rank}:${videoIndex + 1}`] = output;
    task.checkpoint.failedVideos ||= {};
    delete task.checkpoint.failedVideos[`${rank}:${videoIndex + 1}`];
    for (const error of task.errors) {
      if (error.rank === rank && error.videoIndex === videoIndex + 1 && !error.resolvedAt) error.resolvedAt = new Date().toISOString();
    }
    task.progress.videosSaved += 1;
    task.progress.videoFailures = Object.keys(task.checkpoint.failedVideos).length;
    appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条视频已保存：${target}`);
  } catch (error) {
    const issue = await blockingIssue(page).catch(() => 'Edge 页面已断开，请恢复后续跑');
    if (issue) throw new Error(issue);
    const message = /^locator\.hover: Timeout/.test(error.message) ? '悬浮视频卡片超时，页面可能被浮层遮挡'
      : /^locator\.click: Timeout/.test(error.message) ? '点击视频卡片超时，页面可能被浮层遮挡'
        : error.message;
    task.checkpoint.failedVideos ||= {};
    task.checkpoint.failedVideos[`${rank}:${videoIndex + 1}`] = message;
    task.progress.videoFailures = Object.keys(task.checkpoint.failedVideos).length;
    task.errors.push({ rank, productName: product.productName, videoIndex: videoIndex + 1, message, detail: error.message.slice(0, 2000) });
    appendLog(task, `第 ${rank} 名 ${product.productName} 第 ${videoIndex + 1} 条视频失败：${message}`);
  } finally {
    page.off('response', onResponse);
    page.off('popup', onPopup);
    await closePlayer(page).catch(() => {});
    for (const file of [partial, videoPart, audioPart]) {
      if (file && fs.existsSync(file)) {
        try { fs.unlinkSync(file); }
        catch (error) { appendLog(task, `未能清理临时文件 ${file}：${error.message}`); }
      }
    }
  }
}

async function runTask(task, control) {
  const { page } = await connectTargetPage();
  try {
    task.status = 'running';
    saveTask(task);
    const issue = await blockingIssue(page);
    if (issue) throw new Error(issue);
    let state = await applyOptions(page, task.parameters);
    appendLog(task, `开始扫描：${task.parameters.category} / ${task.parameters.period}`);
    if (!state.hasVideoTable) throw new Error('当前页面表格结构不含“带货短视频”，已停止以避免误采集');
    const maxRank = Math.min(200, state.total);
    const pageSize = state.rows.length;
    if (!pageSize && maxRank > 0) throw new Error('榜单表格没有商品行');
    if (task.checkpoint.initialTotal !== null && task.checkpoint.initialTotal !== undefined &&
        (task.checkpoint.initialTotal !== state.total || task.checkpoint.pageSize !== pageSize)) {
      throw new Error('续跑时榜单总数或每页条数已变化，请新建任务以避免商品错位');
    }
    task.checkpoint.initialTotal = state.total;
    task.checkpoint.pageSize = pageSize;
    task.checkpoint.rankProducts ||= {};
    task.checkpoint.eligibleRanks ||= [];
    task.checkpoint.completedVideos ||= {};
    task.checkpoint.failedVideos ||= {};
    task.checkpoint.trendErrors ||= [];
    const failedRanks = Object.keys(task.checkpoint.failedVideos).map((key) => Number(key.split(':')[0])).filter(Number.isFinite);
    const resumeFromRank = Math.min(task.checkpoint.rank || 1, ...failedRanks);
    while (state.page <= Math.ceil(maxRank / pageSize)) {
      await control.waitIfPaused();
      control.throwIfStopped();
      for (const product of state.rows) {
        const rank = (state.page - 1) * pageSize + product.rowIndex + 1;
        if (rank > maxRank) break;
        const currentProductId = productKey(product);
        const savedProductId = task.checkpoint.rankProducts[rank];
        if (savedProductId && savedProductId !== currentProductId) {
          throw new Error(`续跑时第 ${rank} 名商品已变化，请新建任务以避免视频归档错误`);
        }
        if (rank < resumeFromRank) continue;
        task.checkpoint.rankProducts[rank] = currentProductId;
        task.progress.scanned = Math.max(task.progress.scanned, rank);
        task.progress.currentRank = rank;
        task.progress.currentProduct = product.productName;
        task.progress.currentVideo = null;
        task.checkpoint = { ...task.checkpoint, page: state.page, rank, productId: currentProductId, videoIndex: 0 };
        if (product.trend === 'unparseable') {
          if (!task.checkpoint.trendErrors.includes(rank)) {
            task.checkpoint.trendErrors.push(rank);
            task.errors.push({ rank, productName: product.productName, message: `无法识别趋势：${product.trendText}` });
            appendLog(task, `第 ${rank} 名趋势无法识别，跳过`);
          }
          task.checkpoint.rank = rank + 1;
          saveTask(task);
          continue;
        }
        if (!allowedTrend(product.trend, task.parameters.trendMode)) {
          task.checkpoint.rank = rank + 1;
          saveTask(task);
          continue;
        }
        if (!task.checkpoint.eligibleRanks.includes(rank)) task.checkpoint.eligibleRanks.push(rank);
        task.progress.eligible = task.checkpoint.eligibleRanks.length;
        const count = Math.min(product.videoCount, 4);
        appendLog(task, `第 ${rank} 名符合条件：${product.productName}；可见视频 ${count} 条`);
        for (let index = 0; index < count; index += 1) {
          await control.waitIfPaused();
          control.throwIfStopped();
          task.progress.currentVideo = index + 1;
          task.checkpoint.videoIndex = index + 1;
          const completed = task.checkpoint.completedVideos[`${rank}:${index + 1}`];
          if (completed && fs.existsSync(completed.video)) continue;
          await saveVideoFromCard(page, product.rowIndex, index, rank, product, task);
        }
        task.checkpoint.rank = rank + 1;
        saveTask(task);
      }
      if (state.page >= Math.ceil(maxRank / pageSize)) break;
      const old = state;
      if (!(await nextPage(page, old))) throw new Error(`榜单只有 ${state.page} 页，尚未扫描到第 ${maxRank} 名`);
      state = await tableState(page);
    }
    task.progress.currentVideo = null;
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    for (const error of task.errors) if (!error.rank && !error.videoIndex && !error.resolvedAt) error.resolvedAt = task.completedAt;
    appendLog(task, `扫描完成：检查 ${task.progress.scanned} 名，符合条件 ${task.progress.eligible} 件，视频成功 ${task.progress.videosSaved} 条，失败 ${task.progress.videoFailures} 条`);
    return task;
  } catch (error) {
    task.status = error.name === 'StopRequestedError' ? 'stopped' : 'failed';
    if (task.status === 'failed') task.errors.push({ message: error.message, at: new Date().toISOString() });
    appendLog(task, `任务${task.status === 'stopped' ? '已停止' : '失败'}：${error.message}`);
    return task;
  }
}

module.exports = { discoverOptions, runTask, allowedTrend, safePart, tableState, selectCategory, nextPage, saveVideoFromCard };
