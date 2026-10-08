'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { ShopBrowser, HOME, QUERY } = require('../browser');
const { startServer } = require('../server');
let browser;
before(async () => {
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); });
const seed = () => [
  { id: '3845594673414537410', shopId: '101', shopName: '甲店', title: '原词命中一', status: '0' },
  { id: '3845984143154479219', shopId: '202', shopName: '乙店', title: '原词命中二', status: '0' },
  { id: '3845983264867221886', shopId: '101', shopName: '甲店', title: '原词命中三', status: '1' },
];
async function fixture({ failureCount = 0, uncertainSave = false, commitUnknown = false, queryError = false, login = false } = {}) {
  const context = await browser.newContext(), products = seed(), saves = [], queries = [];
  await context.route('https://fxg.jinritemai.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: login ? '<input type="password">请登录' : '<body>商品管理 订单管理</body>' }));
  await context.route('https://xiaozhu.huanhou.cn/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/c/combainSearch/search') {
      const data = new URLSearchParams(request.postData()); queries.push(Object.fromEntries(data));
      const found = products.filter(p => p.shopId === data.get('shopId') && p.title.includes(data.get('name')) && (!data.get('status') || p.status === data.get('status')));
      await new Promise(resolve => setTimeout(resolve, data.get('shopId') === '101' ? 40 : 5));
      return route.fulfill({ json: queryError && data.get('shopId') === '101' ? { status: 'error', msg: '授权失效' } : { data: found } });
    }
    if (url.pathname === '/c/batchTitle/modify') {
      const data = Object.fromEntries(new URLSearchParams(request.postData())); saves.push(data);
      if (uncertainSave) {
        if (commitUnknown) products.find(p => p.id === data.iid).title = data.newTitle;
        return route.abort('failed');
      }
      if (saves.length <= failureCount) return route.fulfill({ json: { log: { status: 0, apiErrorMsg: '模拟失败' } } });
      products.find(p => p.id === data.iid).title = data.newTitle;
      return route.fulfill({ json: { log: { status: 1 } } });
    }
    return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(`${__dirname}/platform.html`, 'utf8') });
  });
  const home = await context.newPage(); await home.goto(HOME);
  const page = await context.newPage(); await page.goto(QUERY);
  const adapter = new ShopBrowser({ contexts: () => [context], isConnected: () => browser.isConnected() });
  const ready = await adapter.prepare();
  return { context, page, home, products, saves, queries, adapter, ready, signal: new AbortController().signal };
}

test('启动时复用初始空白标签页，只打开一个抖店首页，刷新不增加标签页', async () => {
  const f = await fixture();
  await f.home.close();
  const startup = await f.context.newPage();
  try {
    assert.equal(startup.url(), 'about:blank');
    const adapter = new ShopBrowser({ contexts: () => [f.context], isConnected: () => browser.isConnected() });
    assert.equal((await adapter.prepare()).status, 'ready');
    assert.equal(f.context.pages().filter(page => page.url().startsWith('https://fxg.jinritemai.com/')).length, 1);
    assert.equal(adapter.home, startup);
    assert.equal(f.context.pages().length, 2);
    await adapter.prepare();
    assert.equal(f.context.pages().filter(page => page.url().startsWith('https://fxg.jinritemai.com/')).length, 1);
  } finally { await f.context.close(); }
});
test('真实控件方式读取店铺，清空残留条件，等待全部完成并保留页面顺序', async () => {
  const f = await fixture();
  try {
    assert.equal(f.ready.status, 'ready'); assert.equal(f.ready.shops[0].name, '甲店');
    await f.page.locator('#minPrice').fill('900'); await f.page.locator('#excludeName').fill('不该残留');
    const rows = await f.adapter.query('原词', f.ready.shops, f.signal);
    assert.equal(await f.page.locator('#minPrice').inputValue(), '');
    assert.equal(await f.page.locator('#excludeName').inputValue(), '');
    assert.deepEqual(rows.map(p => p.shopId), ['202', '101', '101']);
    assert.equal(rows.length, 3);
    assert.ok(f.queries.every(query => query.status === ''));
    for (const [i, p] of rows.entries()) await f.adapter.save({ ...p, before: p.title, target: `新标题${i}` }, f.signal);
    assert.deepEqual(f.saves.map(s => s.iid), rows.map(p => p.id));
    assert.deepEqual(f.products.map(p => p.title), ['新标题1', '新标题0', '新标题2']);
  } finally { await f.context.close(); }
});
test('平台明确失败只重试一次，第二次成功或失败都核对结果', async () => {
  for (const failureCount of [1, 2]) {
    const f = await fixture({ failureCount });
    try {
      const [p] = await f.adapter.query('原词', f.ready.shops, f.signal);
      const work = f.adapter.save({ ...p, before: p.title, target: '目标标题' }, f.signal);
      if (failureCount === 1) assert.equal((await work).title, '目标标题');
      else await assert.rejects(work, error => error.itemRejected && /已重试一次/.test(error.message));
      assert.equal(f.saves.length, 2);
    } finally { await f.context.close(); }
  }
});
test('超限和平台改写换行在保存前停止，标题不会截断', async () => {
  for (const target of ['中'.repeat(31), '目标\n标题']) {
    const f = await fixture();
    try {
      const [p] = await f.adapter.query('原词', f.ready.shops, f.signal);
      await assert.rejects(f.adapter.save({ ...p, before: p.title, target }, f.signal), error => error.itemRejected && /限制|改写/.test(error.message));
      assert.equal(f.saves.length, 0);
    } finally { await f.context.close(); }
  }
});
test('已有目标标题不重复提交', async () => {
  const f = await fixture();
  try {
    const [p] = await f.adapter.query('原词', f.ready.shops, f.signal);
    await f.adapter.save({ ...p, before: p.title, target: p.title }, f.signal);
    assert.equal(f.saves.length, 0);
  } finally { await f.context.close(); }
});
test('查询店铺报错不接受部分结果；未登录时保持等待', async () => {
  const f = await fixture({ queryError: true });
  try { await assert.rejects(f.adapter.query('原词', f.ready.shops, f.signal), /授权失效/); assert.equal(f.saves.length, 0); }
  finally { await f.context.close(); }
  const loggedOut = await fixture({ login: true });
  try { assert.equal(loggedOut.ready.status, 'waiting-login'); assert.equal(loggedOut.queries.length, 0); }
  finally { await loggedOut.context.close(); }
});
test('未知保存结果先查询，已提交则成功，无法确认则停止且不重复提交', async () => {
  for (const commitUnknown of [true, false]) {
    const f = await fixture({ uncertainSave: true, commitUnknown });
    try {
      const [p, next] = await f.adapter.query('原词', f.ready.shops, f.signal, '0');
      const work = f.adapter.save({ ...p, before: p.title, target: '目标标题' }, f.signal);
      if (commitUnknown) assert.equal((await work).title, '目标标题');
      else await assert.rejects(work, error => error.uncertain && /未重复提交/.test(error.message));
      assert.equal(f.saves.length, 1);
      assert.equal(f.queries.at(-1).name, '目标标题');
      assert.equal(f.queries.at(-1).status, '0');
      if (commitUnknown) {
        assert.equal(f.adapter.restoreQuery.productStatus, '0');
        await f.adapter.save({ ...next, before: next.title, target: next.title }, f.signal);
        assert.equal(f.queries.at(-1).name, '原词');
        assert.equal(f.queries.at(-1).status, '0');
        assert.equal(f.saves.length, 1);
      }
    } finally { await f.context.close(); }
  }
});

test('状态筛选实际传入查询，非法状态不查询，任务只修改该状态商品', async () => {
  const f = await fixture();
  const os = require('node:os'), path = require('node:path'), fsp = require('node:fs/promises');
  const reportDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'title-status-'));
  const data = require('../workbook').groupRows([['原标题', '新标题'], ['原词', '下架新标题'], ['无匹配', '第二组标题']]);
  const mockBrowser = { contexts: () => [f.context], isConnected: () => true, on: () => {} };
  const app = await startServer({ detect: async () => true, connect: async () => mockBrowser, closeBrowser: async () => {}, readInput: async () => data, open: false, reportDir });
  const start = productStatus => fetch('http://127.0.0.1:8080/api/start', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: JSON.stringify({ shopIds: ['101', '202'], productStatus }) });
  try {
    await waitPhase(app, 'ready');
    assert.equal(app.state.productStatuses.length, 9);
    for (const value of ['unknown', 0, null]) assert.equal((await start(value)).status, 400);
    assert.equal(app.state.task, null); assert.equal(f.queries.length, 0); assert.equal(f.saves.length, 0);
    assert.equal((await start('1')).status, 202);
    for (let i = 0; i < 100 && app.state.task.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(app.state.task.status, 'complete');
    assert.deepEqual(app.state.task.productStatus, { value: '1', label: '下架' });
    assert.equal(app.state.task.saved, 1);
    assert.deepEqual(f.saves.map(save => save.iid), [seed()[2].id]);
    assert.equal(f.products[0].title, seed()[0].title); assert.equal(f.products[1].title, seed()[1].title);
    assert.equal(f.queries.length, 4); assert.ok(f.queries.every(query => query.status === '1'));
    await assert.rejects(f.adapter.query('原词', f.ready.shops, f.signal, 'unknown'), /商品状态/);
    assert.equal(f.queries.length, 4);
    await app.shutdown('状态筛选验证');
    const file = (await fsp.readdir(reportDir)).find(name => name.endsWith('.json'));
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(reportDir, file))).productStatus, { value: '1', label: '下架' });
  } finally { await app.shutdown('测试完成'); await f.context.close(); await fsp.rm(reportDir, { recursive: true, force: true }); }
});

test('工作台状态选择在轮询后保留，启动传入状态，执行时锁定并显示范围', async () => {
  const context = await browser.newContext(), page = await context.newPage();
  let state = { phase: 'ready', message: '', shops: [{ id: '101', name: '甲店' }], productStatuses: [{ value: '', label: '所有' }, { value: '1', label: '下架' }], input: { fileName: '标题.xlsx', titleCount: 1, skipped: [], groups: [{ original: '原词', titles: ['新标题'], rows: [2] }] }, inputError: '', task: null };
  let requestBody, polls = 0;
  await context.route('http://127.0.0.1:8080/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') { polls++; return route.fulfill({ json: state }); }
    if (url.pathname === '/api/start') {
      requestBody = route.request().postDataJSON();
      state = { ...state, task: require('../task').newTask(state.shops, state.input, state.productStatuses[1]) };
      return route.fulfill({ status: 202, json: state.task });
    }
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const [file, contentType] = assets[url.pathname];
    return route.fulfill({ contentType, body: fs.readFileSync(`${__dirname}/../public/${file}`, 'utf8') });
  });
  try {
    await page.goto('http://127.0.0.1:8080/');
    await page.waitForFunction(() => !document.querySelector('#product-status').disabled);
    assert.equal(await page.locator('#product-status').inputValue(), '');
    await page.locator('#product-status').selectOption('1');
    await page.locator('#all').click();
    const before = polls;
    while (polls <= before) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await page.locator('#product-status').inputValue(), '1');
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#scope').textContent.includes('商品状态：下架'));
    assert.equal(await page.locator('#product-status').isDisabled(), true);
    assert.deepEqual(requestBody, { shopIds: ['101'], productStatus: '1' });
    assert.equal(await page.locator('#product-status').inputValue(), '1');
    assert.equal(await page.locator('#shops input').isDisabled(), true);
    assert.match(await page.locator('#scope').textContent(), /商品状态：下架/);
    await page.screenshot({ path: `${__dirname}/workbench-product-status.png`, fullPage: true });
    state.task.status = 'complete';
    await page.waitForFunction(() => !document.querySelector('#product-status').disabled);
    assert.equal(await page.locator('#product-status').inputValue(), '1');
    state.phase = 'disconnected';
    await page.waitForFunction(() => document.querySelector('#product-status').disabled);
  } finally { await context.close(); }
});
test('8080 被占用时不连接或启动 Edge', async () => {
  const occupied = http.createServer(); await new Promise(resolve => occupied.listen(8080, '127.0.0.1', resolve)); let connected = false;
  try { await assert.rejects(startServer({ connect: async () => { connected = true; }, open: false }), /8080 端口已被占用/); assert.equal(connected, false); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
});
test('平台拒绝第一件后继续后续标题，Excel 下载及自动落盘记录失败商品', async () => {
  const os = require('node:os'), path = require('node:path'), fsp = require('node:fs/promises'), ExcelJS = require('exceljs');
  const reportDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'title-report-'));
  const f = await fixture({ failureCount: 2 });
  const mockBrowser = { contexts: () => [f.context], isConnected: () => true, on: () => {} };
  const data = require('../workbook').groupRows([['原标题', '新标题'], ['原词', '新一'], ['', '新二'], ['', '新三'], ['', '新四'], ['不命中', '末组']]);
  const app = await startServer({ detect: async () => true, connect: async () => mockBrowser, closeBrowser: async () => {}, readInput: async () => data, open: false, reportDir });
  try {
    await waitPhase(app, 'ready');
    const group = app.state.input.groups[0];
    f.products.forEach(product => { product.title = group.original; });
    const response = await fetch('http://127.0.0.1:8080/api/start', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: JSON.stringify({ shopIds: ['101', '202'] }) });
    assert.equal(response.status, 202);
    for (let i = 0; i < 200 && app.state.task.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 50));
    const task = app.state.task;
    assert.equal(task.status, 'complete'); assert.equal(task.saved, 2); assert.equal(task.failed, 1); assert.equal(task.stopPosition, null);
    assert.deepEqual(f.saves.map(save => save.newTitle), [group.titles[0], group.titles[0], group.titles[1], group.titles[2]]);
    const failed = task.items[0]; assert.equal(failed.status, 'failed'); assert.equal(failed.skipped, true);
    assert.equal(task.groups[0].unused, Math.max(0, group.titles.length - 3));
    const download = await fetch('http://127.0.0.1:8080/api/failures.xlsx');
    assert.equal(download.status, 200); assert.match(download.headers.get('content-type'), /spreadsheetml/);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(await download.arrayBuffer()));
    assert.equal(book.getWorksheet('失败商品').getCell('A2').value, failed.id);
    assert.equal(book.getWorksheet('失败商品').getCell('B2').value, failed.shopName);
    await app.shutdown('报告落盘验证');
    const files = await fsp.readdir(reportDir), excelFile = files.find(file => file.endsWith('-失败商品.xlsx'));
    assert.ok(excelFile); await book.xlsx.readFile(path.join(reportDir, excelFile));
    assert.equal(book.getWorksheet('失败商品').rowCount, 2);
    assert.equal(book.getWorksheet('失败商品').getCell('A2').value, failed.id);
  } finally { await app.shutdown('测试完成'); await f.context.close(); await fsp.rm(reportDir, { recursive: true, force: true }); }
});
async function waitPhase(app, phase) {
  for (let i = 0; i < 100 && app.state.phase !== phase; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(app.state.phase, phase, app.state.message);
}
test('工作台先读取表格，点击连接后才进入业务页面；本机校验及关闭释放端口', async () => {
  const f = await fixture();
  // 用独立浏览器提供生命周期事件，不连接用户的 Edge。
  const mockBrowser = { contexts: () => [f.context], isConnected: () => true, on: (event, fn) => { mockBrowser.disconnected = fn; } };
  let closed = false, connections = 0;
  const app = await startServer({ detect: async () => false, connect: async () => { connections++; return mockBrowser; }, closeBrowser: async () => { closed = true; }, open: false });
  try {
    const state = await (await fetch('http://127.0.0.1:8080/api/state')).json();
    assert.equal(state.phase, 'disconnected'); assert.equal(state.app, 'product-title-workbench'); assert.equal(connections, 0);
    assert.ok(state.input.titleCount > 0); assert.match(state.input.fileName, /^标题\.(xls|xlsx)$/i); assert.equal(state.task, null);
    const unauthorized = await fetch('http://127.0.0.1:8080/api/start', { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 403);
    const badConnect = await fetch('http://127.0.0.1:8080/api/connect', { method: 'POST', body: '{}' });
    assert.equal(badConnect.status, 403); assert.equal(connections, 0);
    const beforeConnect = await fetch('http://127.0.0.1:8080/api/start', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: '{"shopIds":["101"]}' });
    assert.equal(beforeConnect.status, 409);
    const refreshed = await fetch('http://127.0.0.1:8080/api/refresh', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: '{}' });
    assert.equal(refreshed.status, 200); assert.equal(connections, 0);
    const connected = await fetch('http://127.0.0.1:8080/api/connect', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: '{}' });
    assert.equal(connected.status, 202); await waitPhase(app, 'ready'); assert.equal(connections, 1);
    assert.ok(f.context.pages().every(page => !page.url().startsWith('http://127.0.0.1:8080')));
    const empty = await fetch('http://127.0.0.1:8080/api/start', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: '{"shopIds":[]}' });
    assert.equal(empty.status, 400);
    mockBrowser.disconnected();
    await new Promise(resolve => app.server.on('close', resolve));
    const probe = http.createServer(); await new Promise(resolve => probe.listen(8080, '127.0.0.1', resolve)); await new Promise(resolve => probe.close(resolve));
    assert.equal(closed, false);
  } finally { await app.shutdown('测试完成'); await f.context.close(); }
});
test('已打开调试 Edge 时自动检测并复用，工作台不进入调试浏览器', async () => {
  const f = await fixture(); let connections = 0;
  const mockBrowser = { contexts: () => [f.context], isConnected: () => true, on: () => {} };
  const app = await startServer({ detect: async () => true, connect: async () => { connections++; return mockBrowser; }, closeBrowser: async () => {}, open: false });
  try {
    await waitPhase(app, 'ready'); assert.equal(connections, 1);
    const response = await fetch('http://127.0.0.1:8080/api/connect', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: '{}' });
    assert.equal(response.status, 200); assert.equal(connections, 1);
    assert.ok(f.context.pages().every(page => !page.url().startsWith('http://127.0.0.1:8080')));
  } finally { await app.shutdown('测试完成'); await f.context.close(); }
});
test('连接失败保留工作台并允许重试，连接期间不重复启动 Edge', async () => {
  const f = await fixture(); let connections = 0, release;
  const mockBrowser = { contexts: () => [f.context], isConnected: () => true, on: () => {} };
  const app = await startServer({ detect: async () => false, connect: async () => {
    connections++; if (connections === 1) throw new Error('模拟连接失败');
    return new Promise(resolve => { release = () => resolve(mockBrowser); });
  }, closeBrowser: async () => {}, open: false });
  const connectRequest = () => fetch('http://127.0.0.1:8080/api/connect', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8080' }, body: '{}' });
  try {
    assert.equal((await connectRequest()).status, 202); await waitPhase(app, 'error');
    assert.match(app.state.message, /模拟连接失败/);
    assert.equal((await connectRequest()).status, 202); assert.equal(app.state.phase, 'connecting');
    assert.equal((await connectRequest()).status, 409); assert.equal(connections, 2);
    release(); await waitPhase(app, 'ready');
  } finally { release?.(); await app.shutdown('测试完成'); await f.context.close(); }
});
