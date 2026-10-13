'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright-core');
const compass = require('../compass-page');
const { createCollector } = require('../collector');
const { createAdapter } = require('../../toolbox/node/adapters/manual-video.cjs');

test('actual local DOM switches from total ranking before discovery and applying video filters', { timeout: 30000 }, async () => {
  const executablePath = require('../edge').findEdgePath();
  assert.ok(executablePath, 'Local Edge is required for the DOM fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html><body>
      <div role="tablist"><button id="total" role="tab" aria-selected="true">总榜</button>
      <button id="video" role="tab" aria-selected="false">短视频榜</button></div>
      <button id="category" class="aurora-cascader">食品</button>
      <ul id="menu" class="aurora-cascader-menu" style="display:none"><li>食品</li></ul>
      <div><div><div><label title="品牌类型">品牌类型</label></div></div><button data-btm="brand" class="activeItem">不限</button></div>
      <div role="tablist"><button id="period" role="tab" aria-selected="false" hidden>近1天</button></div>
      <table><thead><tr><th>排名</th><th>商品</th></tr></thead><tbody></tbody></table>
      <script>
        window.sequence = []; window.videoClicks = 0;
        const total = document.getElementById('total'), video = document.getElementById('video');
        const category = document.getElementById('category'), menu = document.getElementById('menu');
        const period = document.getElementById('period'), header = document.querySelector('thead');
        total.onclick = () => {total.setAttribute('aria-selected','true');video.setAttribute('aria-selected','false');period.hidden=true;header.innerHTML='<tr><th>排名</th><th>商品</th></tr>';};
        video.onclick = () => {
          window.sequence.push('短视频榜');window.videoClicks++;
          total.setAttribute('aria-selected','false');video.setAttribute('aria-selected','true');
          setTimeout(() => {period.hidden=false;header.innerHTML='<tr><th>排名</th><th>商品</th><th>带货短视频</th><th>店铺</th></tr>';},30);
        };
        category.onclick = () => {window.sequence.push('类目');menu.style.display='block';};
        menu.firstElementChild.onclick = () => {category.textContent='食品';menu.style.display='none';};
        period.onclick = () => {window.sequence.push('周期');period.setAttribute('aria-selected','true');};
        document.addEventListener('keydown',event => {if(event.key==='Escape')menu.style.display='none';});
      </script></body></html>`);
    const engine = createCollector({ connectTargetPage: async () => ({ page }), blockingIssue: async () => '' });
    const options = await engine.discoverOptions();
    assert.deepEqual(options.categories, ['食品']);
    assert.deepEqual(options.brandTypes, ['不限']);
    assert.equal(options.periods[0].label, '近1天');
    assert.equal(await page.getByRole('tab', { name: '短视频榜', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => window.sequence[0]), '短视频榜');
    await page.getByRole('tab', { name: '总榜', exact: true }).click();
    await page.evaluate(() => {window.sequence=[];});
    const result = await engine.applyOptions(page, { category: '食品', brandType: '不限', period: '近1天' });
    assert.equal(result.hasVideoTable, true);
    assert.equal(await page.evaluate(() => window.sequence[0]), '短视频榜');
    assert.equal(await page.getByRole('tab', { name: '近1天', exact: true }).getAttribute('aria-selected'), 'true');
    await engine.ensureVideoRanking(page);
    assert.equal(await page.evaluate(() => window.videoClicks), 2, 'Already selected video ranking must not be clicked again');
  } finally { await browser.close(); }
});

test('video ranking initialization preserves cancellation and the injectable test boundary', async () => {
  const cancelled = createCollector({ isCancelled: () => true });
  await assert.rejects(cancelled.ensureVideoRanking({ getByRole: () => assert.fail('No page access after cancellation') }), { code: 'CANCELLED' });
  const order = [];
  const page = { locator: () => {order.push('category');throw new Error('fixture-category-boundary');} };
  const engine = createCollector({ ensureVideoRanking: async () => {order.push('video-ranking');} });
  await assert.rejects(engine.applyOptions(page, {}), /fixture-category-boundary/);
  assert.deepEqual(order, ['video-ranking', 'category']);
});

test('actual local player DOM supports exact auxo and ecom containers, titles and close controls', { timeout: 20000 }, async () => {
  const executablePath = require('../edge').findEdgePath();
  assert.ok(executablePath, 'Local Edge is required for the DOM fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    for (const prefix of ['auxo', 'ecom']) {
      const other = prefix === 'auxo' ? 'ecom' : 'auxo';
      await page.setContent(`<!doctype html><html><body>
        <video id="unrelated"></video>
        <table><tbody><tr class="ecom-table-row"><td>首次上榜</td><td><span class="name-fixture">测试商品</span></td>
          <td><button id="card" class="videoWrapper-fixture" data-video-id="123">打开视频</button></td><td>测试店铺</td></tr></tbody></table>
        <section id="player" class="${prefix}-dorami-video-container ${prefix}-dorami-video-container-single react-draggable" hidden>
          <div class="${prefix}-dorami-video-header"><button id="close-player" class="closeIcon-fixture">关闭视频</button></div>
          <div class="${prefix}-dorami-video-title"><span class="${prefix}-dorami-atom-text">${prefix}播放器实际标题</span></div>
          <div class="${prefix}-dorami-video-player-container"><video id="owned-video" data-video-id="123"></video></div>
        </section>
        <section class="${other}-dorami-video-container" hidden><div class="${other}-dorami-video-header"><button class="closeIcon-fixture">隐藏关闭</button></div><video></video></section>
        <script>(() => {
          window.closeCount=0;
          const player=document.getElementById('player');
          Object.defineProperty(document.getElementById('owned-video'),'currentSrc',{configurable:true,value:'https://media.fixture.invalid/${prefix}?signature=private'});
          Object.defineProperty(document.getElementById('owned-video'),'readyState',{configurable:true,value:4});
          Object.defineProperty(document.getElementById('unrelated'),'currentSrc',{value:'https://wrong.fixture.invalid/not-a-card'});
          document.getElementById('card').onclick=()=>{player.hidden=false;};
          document.getElementById('close-player').onclick=()=>{window.closeCount++;player.hidden=true;};
        })();</script></body></html>`);
      const [card] = await compass.readProductCards(page, 0);
      assert.equal(card.videoId, '123');
      assert.equal(card.title, '', 'Read the actual player title when the card has no title');
      const result = await compass.playCard(page, card);
      assert.equal(result.videoUrl, `https://media.fixture.invalid/${prefix}?signature=private`);
      assert.equal(result.caption, `${prefix}播放器实际标题`);
      const state = await compass.pageIdentity(page);
      assert.equal(state.player.videoId, '123');
      assert.equal(state.player.url, result.videoUrl);
      await compass.playCard(page, card);
      assert.equal(await page.evaluate(() => window.closeCount), 1, 'Close an existing player before opening another card');
      await compass.closePlayer(page);
      assert.equal(await page.locator('#player').isHidden(), true);
      assert.equal(await page.evaluate(() => window.closeCount), 2);
      await page.evaluate(() => {
        const video = document.getElementById('owned-video');
        Object.defineProperty(video, 'currentSrc', { configurable: true, value: 'https://compass.jinritemai.com/shop/chance/aigc' });
        Object.defineProperty(video, 'readyState', { configurable: true, value: 0 });
        Object.defineProperty(video, 'error', { configurable: true, value: { code: 4 } });
      });
      await assert.rejects(compass.playCard(page, card), error => {
        assert.equal(error.code, 'MEDIA_UNAVAILABLE');
        assert.match(error.message, /平台播放器中无法播放/);
        assert.equal(error.message.includes('/aigc'), false);
        return true;
      });
      assert.equal(page.listenerCount('response'), 0); assert.equal(page.listenerCount('popup'), 0);
      assert.equal(page.listenerCount('response'), 0);
      assert.equal(page.listenerCount('popup'), 0);
    }
  } finally { await browser.close(); }
});

function node(text = '', selectors = {}, attributes = {}) {
  return { innerText: text, textContent: text, offsetWidth: 1, offsetHeight: 1,
    querySelector: selector => selectors[selector] || null, querySelectorAll: selector => selectors[selector] || [],
    getClientRects: () => [{}], getAttribute: name => attributes[name] || null, matches: selector => selector === 'a[href]' && Boolean(attributes.href) };
}
function domPage({ popup = false, weak = false } = {}) {
  const page = new EventEmitter(); let hoverTitle = '', active = false;
  const currentVideo = { currentSrc: '', readyState: 4, error: null };
  const player = node('', { video: currentVideo, '.auxo-dorami-video-title .auxo-dorami-atom-text, .ecom-dorami-video-title .ecom-dorami-atom-text': node('播放器实际标题') });
  const cardNode = node('', { '[class*=videoName-]': node('实际文案'), img: { currentSrc: 'https://fixture.invalid/cover?token=private' }, 'a[href]': weak ? null : { href: 'https://www.douyin.com/video/123?share=private' } }, weak ? {} : { 'data-video-id': '123' });
  const cells = [node('首次上榜'), node('测试商品', { '[class*=name-]': node('测试商品') }), node(), node('测试店铺')];
  const rowNode = node('', { ':scope > td': cells });
  const document = {
    querySelectorAll(selector) {
      if (selector === 'tr.aurora-table-row, tr.ecom-table-row') return [rowNode];
      if (selector === '.aurora-cascader, .ecom-cascader') return [node('食品 / 粥')];
      if (selector === '[role=tab][aria-selected=true]') return [node('近1天')];
      if (selector === '[class*=activeItem]') return [node('不限')];
      if (selector === '.aurora-popover, .ecom-popover') return hoverTitle ? [node('', { '[class*=videoName-]': node(hoverTitle) })] : [];
      if (selector === '.auxo-dorami-video-container, .ecom-dorami-video-container') return active ? [player] : [];
      if (selector.includes('dialog') || selector === 'iframe') return [];
      throw new Error(`Unmodelled DOM selector ${selector}`);
    },
    querySelector(selector) { if (selector.includes('pagination-item-active')) return node('1'); return null; },
  };
  const evaluate = (operation, argument) => vm.runInNewContext(`(${operation.toString()})(argument)`, { document, URL, location: { pathname: '/shop/chance/merchandise-product-rank' }, argument });
  class Locator {
    constructor(items) { this.items = items; }
    first() { return this.nth(0); } last() { return this.nth(this.items.length - 1); }
    nth(index) { return new Locator(this.items[index] ? [this.items[index]] : []); }
    async count() { return this.items.length; }
    async evaluate(operation) { return operation(this.items[0]); }
    locator(selector) { if (selector.includes('videoWrapper-')) return new Locator([cardNode]); if (selector.includes('moreVideo-')) return new Locator([]); throw new Error(`Unmodelled row selector ${selector}`); }
    async hover() { hoverTitle = '实际文案'; }
    async click() {
      if (popup) { page.emit('popup', { close: async () => { page.popupClosed = true; } }); return; }
      active = true; currentVideo.currentSrc = 'blob:normal-player';
      page.emit('response', { headers: () => ({ 'content-type': 'video/mp4' }), status: () => 200, url: () => 'https://media.fixture.invalid/video?token=private' });
      page.emit('response', { headers: () => ({ 'content-type': 'audio/mp4' }), status: () => 200, url: () => 'https://media.fixture.invalid/audio?token=private' });
    }
  }
  page.locator = selector => {
    if (selector.startsWith('tr.aurora-table-row')) return new Locator([rowNode]);
    if (selector.includes('closeIcon-')) return new Locator([]);
    throw new Error(`Unmodelled page selector ${selector}`);
  };
  page.evaluate = async (operation, argument) => evaluate(operation, argument);
  page.waitForFunction = async operation => { if (!evaluate(operation)) return new Promise(() => {}); };
  page.waitForTimeout = async () => {};
  page.url = () => 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank?rank=private';
  page.context = () => ({ newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'fixture-page' } }), detach: async () => {} }) });
  page.setPlayerCaption = title => { player.querySelector('.auxo-dorami-video-title .auxo-dorami-atom-text, .ecom-dorami-video-title .ecom-dorami-atom-text').textContent = title; };
  page.setCardTitle = title => { cardNode.querySelector('[class*=videoName-]').textContent = title; };
  page.setCardCover = cover => { cardNode.querySelector('img').currentSrc = cover; };
  return page;
}

test('real DOM extraction builds snapshot identities and never persists signed media/cover URLs', async () => {
  const page = domPage();
  const view = await compass.snapshot(page, 'fixture-page');
  assert.equal(view.rows[0].productName, '测试商品'); assert.equal(view.rows[0].cards[0].title, '实际文案');
  const items = compass.captureItems(view, 'fixture-page', page.url().split('?')[0]);
  assert.equal(items[0].publicUrl, 'https://www.douyin.com/video/123');
  assert.equal(items[0].locator.videoId, '123'); assert.equal(JSON.stringify(items).includes('private'), false);
  const card = compass.locate(view, items[0]);
  const player = await compass.playCard(page, card);
  assert.equal(player.videoUrl, 'https://media.fixture.invalid/video?token=private');
  assert.equal(player.audioUrl, 'https://media.fixture.invalid/audio?token=private'); assert.equal(player.caption, '播放器实际标题');
  assert.equal(page.listenerCount('response'), 0); assert.equal(page.listenerCount('popup'), 0);
});

test('normal external popup is closed and returns unsupported-source without waiting for a player', async () => {
  const page = domPage({ popup: true }), cards = await compass.readProductCards(page, 0);
  await assert.rejects(compass.playCard(page, cards[0]), { code: 'UNSUPPORTED_SOURCE' });
  assert.equal(page.popupClosed, true); assert.equal(page.listenerCount('response'), 0);
});

test('capture_page adapter runs actual DOM snapshot and has no task checkpoint', async () => {
  const page = domPage({ weak: true }); let disconnected = false;
  const adapter = createAdapter({ connect: async () => ({ browser: {}, disconnect: async () => { disconnected = true; } }), selectPage: async () => page });
  const result = await adapter.capture_page({ pageId: 'fixture-page' }, { browser: {} }, { boundary: async () => {}, checkpoint: () => assert.fail() });
  assert.equal(result.items.length, 1); assert.match(result.items[0].locator.videoKey, /^snapshot:/); assert.equal(result.items[0].publicUrl, null);
  assert.equal(result.items[0].mediaUrl, undefined); assert.equal(disconnected, true);
});

test('unsupported URL and fake public/media hosts are rejected', () => {
  assert.equal(compass.accepts('https://compass.jinritemai.com/shop/chance/merchandise-product-rank'), true);
  assert.equal(compass.accepts('https://compass.jinritemai.com.evil.invalid/shop/chance/merchandise-product-rank'), false);
  assert.equal(compass.publicVideoUrl('https://douyin.com.evil.invalid/video/123'), null);
  assert.equal(compass.publicVideoUrl('https://media.douyinvod.com/video/123'), null);
});

test('temporary link is returned only for the player with the same observed native video ID', () => {
  const card = compass.identity({ title: '文案', videoId: '123' });
  const view = { rows: [{ productKey: 'p', cards: [card] }], key: 'snapshot', category: '', player: { videoId: '123', url: 'https://media.fixture.invalid/video?token=private' } };
  const item = compass.captureItems(view, 'page', 'compass')[0];
  assert.equal(item.mediaUrl, view.player.url); assert.equal(JSON.stringify(item.locator).includes('private'), false);
  view.player.videoId = '999'; assert.equal(compass.captureItems(view, 'page', 'compass')[0].mediaUrl, undefined);
  view.player.videoId = ''; assert.equal(compass.captureItems(view, 'page', 'compass')[0].mediaUrl, undefined);
});

test('leased-page streaming uses local HTTP fixture, rejects wrong MIME and cleans only its own partial', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-video-network-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('0000ftypnetwork-fixture');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': request.url === '/bad' ? 'text/html' : 'video/mp4' });
    if (request.url === '/slow') { response.write(bytes.subarray(0, 8)); setTimeout(() => response.end(bytes.subarray(8)), 300); }
    else response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const window = {};
  const page = { exposeBinding: async (name, binding) => { window[name] = (...args) => binding({}, ...args); },
    evaluate: async (operation, argument) => vm.runInNewContext(`(${operation.toString()})(argument)`, { argument, window, AbortController, setTimeout, clearTimeout,
      btoa: value => Buffer.from(value, 'binary').toString('base64'), fetch: (address, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(address).pathname}`, options) }) };
  const engine = createCollector(); const destination = path.join(root, 'download.part');
  assert.equal(await engine.downloadMedia(page, 'https://fixture.invalid/video', destination, 'video/'), 'video/mp4');
  assert.deepEqual(fs.readFileSync(destination), bytes);
  await assert.rejects(engine.downloadMedia(page, 'https://fixture.invalid/video', destination, 'video/'), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(destination), bytes);
  const wrong = path.join(root, 'bad.part'); await assert.rejects(engine.downloadMedia(page, 'https://fixture.invalid/bad', wrong, 'video/'), /媒体类型无效/);
  assert.equal(fs.existsSync(wrong), false);
  let cancelled = false;
  const expose = page.exposeBinding;
  page.exposeBinding = async (name, callback) => expose(name, async (...args) => { const result = await callback(...args); cancelled = true; return result; });
  const cancelling = createCollector({ isCancelled: () => cancelled }); const partial = path.join(root, 'cancel.part');
  await assert.rejects(cancelling.downloadMedia(page, 'https://fixture.invalid/slow', partial, 'video/'), { code: 'CANCELLED' });
  assert.equal(fs.existsSync(partial), false);
});


test('weak cover snapshot identity survives lazy titles but rejects a changed cover', async () => {
  const page = domPage({ weak: true });
  page.setCardTitle('异步旧标题');
  const first = await compass.snapshot(page, 'fixture-page');
  const [item] = compass.captureItems(first, 'fixture-page', page.url());
  page.setCardTitle('当前实际标题');
  page.setCardCover('https://fixture.invalid/cover?token=renewed');
  const later = await compass.snapshot(page, 'fixture-page');
  assert.equal(first.key, later.key);
  assert.equal(compass.locate(later, item).title, '当前实际标题');
  page.setCardCover('https://fixture.invalid/different-cover');
  const changed = await compass.snapshot(page, 'fixture-page');
  assert.notEqual(first.key, changed.key);
  assert.throws(() => compass.locate(changed, item), { code: 'PAGE_CHANGED' });
});

test('native identity outranks changing cover and title; ambiguous cover cards remain unselectable', () => {
  const native = compass.identity({ videoId: '123', title: '旧标题', cover: 'https://fixture.invalid/old' });
  const latest = compass.identity({ href: 'https://www.douyin.com/video/123?share=renewed', title: '新标题', cover: 'https://fixture.invalid/new' });
  assert.equal(native.cardKey, latest.cardKey);
  const first = compass.identity({ title: '标题一', cover: 'https://fixture.invalid/cover?token=one' });
  const second = compass.identity({ title: '标题二', cover: 'https://fixture.invalid/cover?token=two' });
  assert.equal(first.cardKey, second.cardKey);
  const view = { key: 'snapshot', category: '食品', rows: [{ productKey: 'product', cards: [first, second] }] };
  assert.deepEqual(compass.captureItems(view, 'fixture-page', 'fixture'), []);
  assert.notEqual(compass.identity({ title: '无封面标题一' }).cardKey, compass.identity({ title: '无封面标题二' }).cardKey);
});


test('hover titles are bound to the matching cover, never a late unrelated tooltip', async () => {
  const page = domPage({ weak: true }); page.setCardTitle('');
  const evaluate = page.evaluate;
  let tooltipReads = 0;
  page.evaluate = async (operation, argument) => {
    if (typeof argument !== 'string' || !operation.toString().includes('videoName-')) return evaluate(operation, argument);
    tooltipReads += 1;
    const tooltip = (cover, title) => node('', { img: [{ currentSrc: cover }], '[class*=videoName-]': node(title) });
    const popovers = [tooltip('https://fixture.invalid/other', '其他商品迟到标题')];
    if (tooltipReads > 1) popovers.unshift(tooltip('https://fixture.invalid/cover?renewed=yes', '当前正确标题'));
    return vm.runInNewContext(`(${operation.toString()})(argument)`, { URL, argument, document: { querySelectorAll: () => popovers } });
  };
  const [card] = await compass.readProductCards(page, 0);
  assert.equal(card.title, '当前正确标题'); assert.equal(tooltipReads, 2);
});

test('hover title stays empty when no tooltip has this card cover', async () => {
  const page = domPage({ weak: true }); page.setCardTitle('');
  let tooltipReads = 0, boundaries = 0;
  const evaluate = page.evaluate;
  page.evaluate = async (operation, argument) => {
    if (typeof argument !== 'string' || !operation.toString().includes('videoName-')) return evaluate(operation, argument);
    tooltipReads += 1;
    return vm.runInNewContext(`(${operation.toString()})(argument)`, { URL, argument, document: {
      querySelectorAll: () => [node('', { img: [{ currentSrc: 'https://fixture.invalid/other' }], '[class*=videoName-]': node('其他标题') })] } });
  };
  const [card] = await compass.readProductCards(page, 0, async () => { boundaries += 1; });
  assert.equal(card.title, ''); assert.equal(tooltipReads, 5); assert.equal(boundaries, 6);
});


test('empty player title falls back to the bound card caption and hover wait remains cancellable', async () => {
  for (const placeholder of ['', '-', '--']) {
    const page = domPage(); page.setPlayerCaption(placeholder);
    const [card] = await compass.readProductCards(page, 0);
    assert.equal((await compass.playCard(page, card)).caption, '实际文案');
  }
  const page = domPage({ weak: true }); page.setCardTitle('');
  let boundaries = 0;
  await assert.rejects(compass.readProductCards(page, 0, async () => {
    boundaries += 1;
    if (boundaries === 2) throw Object.assign(new Error('stopped during hover'), { code: 'CANCELLED' });
  }), { code: 'CANCELLED' });
});
