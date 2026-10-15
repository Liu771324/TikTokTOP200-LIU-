'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { chromium } = require('playwright-core');
const { createAdapter } = require('../node/adapters/product-title.cjs');
const { ShopBrowser, HOME, QUERY } = require('../engines/product-title/browser.cjs');
const { newTask, runTask } = require('../engines/product-title/task.cjs');
const { failureWorkbook } = require('../engines/product-title/report.cjs');
const shops = [{ id: '101', name: '甲店' }, { id: '202', name: '乙店' }];
const productStatus = { value: '', label: '所有' };
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const product = (id, title = '原词') => ({ id, title, shopId: '101', shopName: '甲店' });
let browser;
before(async () => {
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); });

async function temporary(work) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'toolbox-title-'));
  try { return await work(root); } finally { await fsp.rm(root, { recursive: true, force: true }); }
}
async function workbook(root, rows, extension = 'xlsx') {
  const directory = path.join(root, 'scratch', `title-import-${'a'.repeat(32)}`); await fsp.mkdir(directory, { recursive: true });
  const inputPath = path.join(directory, `自选标题.${extension}`), book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(book, inputPath, { bookType: extension === 'xls' ? 'biff8' : 'xlsx' });
  return { inputPath, inputSha256: sha(await fsp.readFile(inputPath)) };
}
const options = { status: 'ready', shops, productStatuses: [productStatus] };
function apiFor(context) {
  const api = { control: { cancelled: false }, reports: [], checkpoints: [],
    emit() {}, checkpoint(state) {
      const copy = JSON.parse(JSON.stringify(state)); api.checkpoints.push(copy);
      fs.mkdirSync(path.dirname(context.statePath), { recursive: true });
      fs.writeFileSync(context.statePath, JSON.stringify({ formatVersion: 1, toolId: 'product-title', taskId: context.taskId, attempt: 1, state: copy }));
    }, async registerReport(candidate) { api.reports.push(candidate); return { artifactId: candidate.candidateId }; } };
  return api;
}
async function persistPlan(root, plan) {
  const planId = 'b'.repeat(32), directory = path.join(root, 'scratch', `title-plan-${planId}`);
  await fsp.mkdir(directory, { recursive: true }); const data = JSON.stringify(plan);
  await fsp.writeFile(path.join(directory, 'plan.json'), data);
  const taskId = 'c'.repeat(32), context = { dataRoot: root, taskId, attempt: 1,
    statePath: path.join(root, 'tasks', taskId, 'engine-state.json'), artifactStagingRoot: path.join(root, 'tasks', taskId, 'staging') };
  return { parameters: { planId, planSha256: sha(data) }, context };
}
function frozenPlan() {
  return { engine: 'product-title-v1', fileName: '标题.xlsx', inputSha256: 'a'.repeat(64), shops, productStatus,
    groups: [{ original: '原词', titleCount: 2, productCount: 2, unused: 0 }],
    items: ['9001', '9002'].map((id, i) => ({ ...product(id), original: '原词', before: '原词', target: `新标题${i + 1}`, excelRow: i + 2, order: i + 1, status: 'pending' })),
    summary: { productCount: 2, changeCount: 2 } };
}

for (const extension of ['xls', 'xlsx']) test(`受控 ${extension} 导入保留分组/正文，原文件不改变`, async () => temporary(async root => {
  const input = await workbook(root, [['原标题', '新标题'], ['原词', ' 新一 '], ['', ''], ['', '新二'], ['别词', '新三'], ['原词', '新四']], extension);
  const result = await createAdapter().title_input(input, { dataRoot: root });
  assert.equal(result.fileName, `自选标题.${extension}`); assert.equal(result.groupCount, 2); assert.equal(result.titleCount, 4);
  assert.equal(result.skippedCount, 1); assert.deepEqual(result.groups[0].titles, [' 新一 ', '新二', '新四']);
  assert.equal(sha(await fsp.readFile(input.inputPath)), input.inputSha256);
}));

test('导入 hash 篡改、外部路径、公式与超行数均拒绝', async () => temporary(async root => {
  const adapter = createAdapter(), input = await workbook(root, [['原标题', '新标题'], ['原词', '新']]);
  await assert.rejects(adapter.title_input({ ...input, inputSha256: '0'.repeat(64) }, { dataRoot: root }), /已变化/);
  await assert.rejects(adapter.title_input({ ...input, inputPath: path.join(root, 'outside.xlsx') }, { dataRoot: root }));
  const book = XLSX.readFile(input.inputPath); book.Sheets.Sheet1.B2 = { t: 's', f: 'A2', v: '新' }; XLSX.writeFile(book, input.inputPath);
  await assert.rejects(adapter.title_input({ ...input, inputSha256: sha(await fsp.readFile(input.inputPath)) }, { dataRoot: root }), /公式/);
  delete book.Sheets.Sheet1.B2.f; book.Sheets.Sheet1['!ref'] = 'A1:B10002'; XLSX.writeFile(book, input.inputPath);
  await assert.rejects(adapter.title_input({ ...input, inputSha256: sha(await fsp.readFile(input.inputPath)) }, { dataRoot: root }), /10000/);
}));

test('长文本输入预览限制协议大小，保留截断提示', async () => temporary(async root => {
  const rows = [['原标题', '新标题'], ...Array.from({ length: 120 }, (_, index) => [index ? '' : '原词', '中'.repeat(4000)])];
  const input = await workbook(root, rows), result = await createAdapter().title_input(input, { dataRoot: root });
  assert.equal(result.titleCount, 120); assert.equal(result.previewTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
  assert.ok(result.groups[0].titles.length < 100);
}));

test('预览只读并冻结商品顺序，重叠分组全量拒绝', async () => temporary(async root => {
  let queries = 0, disconnected = 0;
  const adapter = createAdapter({ connect: async () => ({ disconnect: async () => disconnected++, adapter: {
    prepare: async () => options, query: async () => { queries++; return [product('9002'), product('9001')]; },
    save: async () => assert.fail('预览不能保存'),
  } }) });
  const input = await workbook(root, [['原标题', '新标题'], ['原词', '新一'], ['', '新二'], ['', '多余']]);
  const context = { dataRoot: root, scratchRoot: path.join(root, 'scratch', 'operation-1') }, api = { control: { cancelled: false } };
  const result = await adapter.title_plan({ ...input, shops, productStatus }, context, api);
  const plan = JSON.parse(await fsp.readFile(result.planPath, 'utf8'));
  assert.deepEqual(plan.items.map(item => [item.id, item.target]), [['9002', '新一'], ['9001', '新二']]);
  assert.equal(result.summary.unusedCount, 1); assert.equal(disconnected, 1); assert.equal(queries, 1);
  const overlap = await workbook(root, [['原标题', '新标题'], ['原词', '新一'], ['别词', '新二']]);
  await assert.rejects(adapter.title_plan({ ...overlap, shops, productStatus }, { ...context, scratchRoot: path.join(root, 'scratch', 'operation-2') }, api), /同一商品/);
  assert.equal(disconnected, 2);
}));

test('执行按冻结商品分配，不受平台新排序或新增商品影响，禁止重放并保留报告', async () => temporary(async root => {
  const plan = frozenPlan(), run = await persistPlan(root, plan), saved = [];
  const api = apiFor(run.context), adapter = createAdapter({ connect: async () => ({ disconnect: async () => {}, adapter: {
    prepare: async () => options, query: async () => [product('9002'), product('9003'), product('9001')],
    save: async (item, signal, attempt) => { attempt(1); saved.push([item.id, item.target]); return { title: item.target }; },
  } }) });
  const result = await adapter.run(run.parameters, run.context, api);
  assert.equal(result.state, 'completed'); assert.deepEqual(saved, [['9001', '新标题1'], ['9002', '新标题2']]);
  assert.equal(api.reports.length, 2); assert.equal(api.checkpoints[0].task.items[0].status, 'pending');
  assert.ok(api.checkpoints.some(state => state.task.items[0].status === 'saving' && state.task.items[0].attempts === 1));
  await assert.rejects(adapter.run(run.parameters, run.context, api), /禁止重复执行/);
  const results = await adapter.read_results({ offset: 1, limit: 1 }, run.context);
  assert.equal(results.total, 2); assert.equal(results.items[0].productId, '9002');
}));

test('预览后标题变化或计划 hash 改变不保存，结果读取不取浏览器', async () => temporary(async root => {
  const run = await persistPlan(root, frozenPlan()); let connections = 0;
  const adapter = createAdapter({ connect: async () => { connections++; return { disconnect: async () => {}, adapter: {
    prepare: async () => options, query: async () => [product('9001', '人工已修改')], save: async () => assert.fail('不能保存'),
  } }; } });
  await assert.rejects(adapter.run({ ...run.parameters, planSha256: '0'.repeat(64) }, run.context, apiFor(run.context)), /已变化/);
  assert.equal(connections, 0);
  assert.equal((await adapter.run(run.parameters, run.context, apiFor(run.context))).state, 'failed');
  await adapter.read_results({}, run.context); assert.equal(connections, 1);
  const data = JSON.parse(await fsp.readFile(run.context.statePath, 'utf8')); data.state.task.items[0].status = 'saving';
  await fsp.writeFile(run.context.statePath, JSON.stringify(data));
  assert.equal((await adapter.read_results({}, run.context)).items[0].status, 'uncertain');
}));

test('报告登记失败仍保留完整检查点并提示，不重做商品保存', async () => temporary(async root => {
  const run = await persistPlan(root, frozenPlan()), api = apiFor(run.context); let saves = 0;
  api.registerReport = async () => { throw new Error('模拟登记中停止'); };
  const adapter = createAdapter({ connect: async () => ({ disconnect: async () => {}, adapter: {
    prepare: async () => options, query: async () => [product('9001'), product('9002')],
    save: async item => { saves++; return { title: item.target }; },
  } }) });
  const result = await adapter.run(run.parameters, run.context, api);
  assert.equal(result.state, 'completed_with_errors'); assert.equal(result.error.code, 'REPORT_INCOMPLETE');
  assert.equal(saves, 2); assert.equal(api.checkpoints.at(-1).task.saved, 2);
  assert.match(api.checkpoints.at(-1).task.reportError, /报告未完成/);
}));

test('明确失败消耗当前标题并继续，停止保留当前成功、不保存下一件', async () => {
  const plan = frozenPlan(), task = newTask(plan), control = { aborted: false }, attempts = [];
  await runTask(task, plan, { query: async () => [product('9001'), product('9002')], save: async item => {
    attempts.push(item.id);
    if (item.id === '9001') throw Object.assign(new Error('明确拒绝'), { itemRejected: true });
    control.aborted = true; return { title: item.target };
  } }, control, () => {});
  assert.equal(task.status, 'cancelled'); assert.equal(task.failed, 1); assert.equal(task.saved, 1);
  assert.deepEqual(attempts, ['9001', '9002']);
});

test('停止前零保存，未知保存状态停止后续且 Excel 保留文本 ID', async () => {
  const plan = frozenPlan(), stopped = newTask(plan);
  await runTask(stopped, plan, { query: async () => assert.fail('不能查询') }, { aborted: true }, () => {});
  assert.equal(stopped.status, 'cancelled');
  const task = newTask(plan); let count = 0;
  await runTask(task, plan, { query: async () => [product('9001'), product('9002')], save: async (item, signal, onAttempt) => {
    count++; onAttempt(1); throw Object.assign(new Error('结果未知'), { uncertain: true });
  } }, { aborted: false }, () => {});
  assert.equal(task.status, 'failed'); assert.equal(task.items[0].status, 'uncertain'); assert.equal(count, 1);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await failureWorkbook(task));
  assert.equal(book.getWorksheet('失败商品').getCell('A2').value, '9001');
});

async function platform({ mode = 'success', control = { aborted: false }, unexpectedResponse } = {}) {
  const context = await browser.newContext(), products = [product('9001'), product('9002')], saves = [];
  await context.route('https://fxg.jinritemai.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body>商品管理 订单管理</body>' }));
  await context.route('https://xiaozhu.huanhou.cn/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname === '/c/combainSearch/search') {
      const data = new URLSearchParams(request.postData());
      return route.fulfill({ json: { data: products.filter(item => item.shopId === data.get('shopId') && item.title.includes(data.get('name'))) } });
    }
    if (pathname === '/c/batchTitle/modify') {
      const data = Object.fromEntries(new URLSearchParams(request.postData())); saves.push(data);
      if (mode.startsWith('stop')) control.aborted = true;
      if (unexpectedResponse !== undefined) return route.fulfill({ json: unexpectedResponse });
      if (mode === 'reject' || mode === 'stop-reject') return route.fulfill({ json: { log: { status: 0, apiErrorMsg: '平台拒绝' } } });
      if (mode === 'reject-string') return route.fulfill({ json: { log: { status: '0', apiErrorMsg: '平台拒绝' } } });
      if (mode === 'unknown-uncommitted') return route.fulfill({ status: 500, body: '网络失败' });
      products.find(item => item.id === data.iid).title = data.newTitle;
      if (mode === 'stop-unknown') return route.fulfill({ status: 500, body: '网络失败' });
      await new Promise(resolve => setTimeout(resolve, 30));
      return route.fulfill({ json: { log: { status: 1 } } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'product-title-platform.html'), 'utf8') });
  });
  const home = await context.newPage(); await home.goto(HOME);
  const page = await context.newPage(); await page.goto(QUERY);
  const adapter = new ShopBrowser({ contexts: () => [context], isConnected: () => true });
  await adapter.prepare();
  return { context, adapter, saves, products, control };
}

for (const mode of ['stop-success', 'stop-unknown', 'stop-reject']) test(`真实控件夹具：${mode} 在途停止只核对，不提交下一件`, async () => {
  const fixture = await platform({ mode }), plan = frozenPlan(), task = newTask(plan);
  try {
    await runTask(task, plan, fixture.adapter, fixture.control, () => {});
    assert.equal(task.status, 'cancelled'); assert.equal(fixture.saves.length, 1);
    assert.equal(task.saved, mode === 'stop-reject' ? 0 : 1);
    assert.equal(task.items[1].status, 'unmodified');
  } finally { await fixture.context.close(); }
});

test('真实控件夹具：明确失败最多两次；未知未提交一次后停止；超限零提交', async () => {
  for (const mode of ['reject', 'unknown-uncommitted', 'success']) {
    const fixture = await platform({ mode });
    try {
      const [item] = await fixture.adapter.query('原词', shops, fixture.control);
      const work = fixture.adapter.save({ ...item, before: item.title, target: mode === 'success' ? '中'.repeat(31) : '目标' }, fixture.control);
      await assert.rejects(work, error => mode === 'unknown-uncommitted' ? error.uncertain : error.itemRejected);
      assert.equal(fixture.saves.length, mode === 'reject' ? 2 : mode === 'unknown-uncommitted' ? 1 : 0);
    } finally { await fixture.context.close(); }
  }
});

for (const response of [{}, { message: 'response format changed' }, { log: { status: 2 } }]) {
  test(`未知 JSON ${JSON.stringify(response)} 仅一次保存，核对不明即停止`, async () => {
    const fixture = await platform({ unexpectedResponse: response }), plan = frozenPlan(), task = newTask(plan);
    try {
      await runTask(task, plan, fixture.adapter, fixture.control, () => {});
      assert.equal(task.status, 'failed'); assert.equal(task.items[0].status, 'uncertain');
      assert.equal(fixture.saves.length, 1); assert.equal(task.items[1].status, 'unmodified');
    } finally { await fixture.context.close(); }
  });
}

test('字符串明确拒绝状态 0 仍最多保存两次', async () => {
  const fixture = await platform({ mode: 'reject-string' });
  try {
    const [item] = await fixture.adapter.query('原词', shops, fixture.control);
    await assert.rejects(fixture.adapter.save({ ...item, before: item.title, target: '目标' }, fixture.control), error => error.itemRejected);
    assert.equal(fixture.saves.length, 2);
  } finally { await fixture.context.close(); }
});
