'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ExcelJS = require('exceljs');
const { createAdapter } = require('../../toolbox/node/adapters/business-center.cjs');
const { createTaskState } = require('../task-store');
const { processingCombinations, toolboxStatus, validateParameters } = require('../toolbox_task');
const { createTaskStateFixtures } = require('./fixtures/task_states');
const { createCollector } = require('../collect_v4');
const { createApi } = require('../../toolbox/node/sdk.cjs');
const { fakeBusinessPage, PAGE_URL } = require('./fixtures/fake_business_page');

const TASK_ID = 'a'.repeat(32);
const categories = ['A', 'B'].map(name => ({ displayPath: `测试类目 ${name}`, segments: [`测试类目 ${name}`], valuePath: [] }));
const parameters = { categories, minSales: 10000, maxSales: 250000, only30dGrowth: false };
const clone = value => structuredClone(value);

function payload(keyword = '测试黄芪片') {
  return { results: [{ keyword, totalSales: '¥1万-¥2万', yesterday: '¥1000', today: '¥2000', growth: '100%', category: 'normal', page: 1, attempts: 1 }],
    failures: [], unparseableItems: [], qualifyingCount: 1, elapsedSeconds: 1, stats: { normal: 1, detailsOpened: 1 },
    completion: { status: 'complete', reason: 'range-complete', message: '扫描完成', coverageComplete: true } };
}

function harness(t, options = {}) {
  const root = options.dataRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'business-adapter-'));
  if (!options.dataRoot) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { protocolVersion: 1, toolId: 'business-center', taskId: options.taskId || TASK_ID,
    attempt: options.attempt || 1, dataRoot: root, taskRoot: path.join(root, 'tasks', options.taskId || TASK_ID),
    scratchRoot: path.join(root, 'scratch', options.taskId || TASK_ID), browser: { endpoint: 'http://127.0.0.1:54321', pageId: 'owned-page', leaseId: 'lease' } };
  context.statePath = path.join(context.taskRoot, 'engine-state.json');
  context.artifactStagingRoot = path.join(context.taskRoot, 'staging');
  context.controlRoot = path.join(context.taskRoot, 'control');
  const record = { collected: [], snapshots: [], candidates: [], events: [], connects: [], disconnected: 0, waits: 0 };
  const page = options.page || { url: () => PAGE_URL };
  const api = { control: { cancelled: false, pauseRequested: false },
    emit(type, data) { record.events.push({ type, data: clone(data) }); },
    checkpoint(state) {
      fs.mkdirSync(context.taskRoot, { recursive: true });
      fs.writeFileSync(context.statePath, JSON.stringify({ formatVersion: 1, toolId: context.toolId,
        taskId: context.taskId, attempt: context.attempt, state }));
      record.snapshots.push(clone(state));
    },
    async boundary() { if (api.control.cancelled) throw Object.assign(new Error('已取消'), { code: 'CANCELLED' }); },
    async waitForUser() { record.waits += 1; if (options.onWait) await options.onWait(api); },
    async lookup(candidateId) { return { candidateId, registration: options.registration || null }; },
    async register(candidate) { record.candidates.push(clone(candidate)); return { artifactId: 'fixture-report', registeredAttempt: context.attempt }; },
  };
  const dependencies = {
    async connect(received) { record.connects.push(received.browser.endpoint); return { browser: {}, async disconnect() { record.disconnected += 1; } }; },
    async selectPage(browser, pageId, accepts) { assert.equal(pageId, 'owned-page'); assert.ok(accepts(PAGE_URL)); assert.equal(accepts('https://fxg.jinritemai.com.evil.test/'), false); return page; },
    async discoverCategories() { return { categories: clone(categories), discoveredAt: '2026-10-12T00:00:00.000Z' }; },
    createCollector(config, hooks) { return { async collect() {
      record.collected.push(config.categoryLabel);
      const result = options.collect ? await options.collect(config, hooks, api) : payload(config.categoryLabel);
      hooks.onSnapshot(result, 1);
      return result;
    } }; },
    ...options.dependencies,
  };
  return { root, context, api, record, adapter: createAdapter(dependencies),
    state: () => JSON.parse(fs.readFileSync(context.statePath, 'utf8')).state,
    seed(task) { api.checkpoint({ ...task, taskId: context.taskId }); record.snapshots.length = 0; } };
}

for (const fixture of createTaskStateFixtures()) {
  test(`六类状态 ${fixture.name} 采用约定最终状态及类目恢复粒度`, () => {
    assert.equal(toolboxStatus(fixture.task), fixture.expected.toolboxStatus);
    const selected = processingCombinations(fixture.task, fixture.expected.reprocessMode === 'retry');
    assert.deepEqual(selected.map(item => item.id), fixture.expected.reprocessCombinationIds);
  });
}

test('纯任务工厂支持宿主taskId且不创建旧store', () => {
  const task = createTaskState(parameters, { taskId: TASK_ID, now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(task.taskId, TASK_ID);
  assert.equal(task.createdAt, '2026-10-12T00:00:00.000Z');
  assert.equal(task.combinations.length, 2);
  assert.equal(task.parameters.minSales, 10000);
});

test('参数拒绝无效边界、重复/空类目和非布尔预筛选', () => {
  for (const changes of [{ minSales: -1 }, { maxSales: 1 }, { categories: [] },
    { categories: [categories[0], categories[0]] }, { categories: [''] }, { only30dGrowth: 'false' }]) {
    assert.throws(() => validateParameters({ ...parameters, ...changes }), error => error.code === 'INVALID_PARAMETERS');
  }
});

test('discover小类目结果保持原接口且不发送分片', async t => {
  const h = harness(t);
  const result = await h.adapter.discover({}, h.context, h.api);
  assert.deepEqual(result, { categories, discoveredAt: '2026-10-12T00:00:00.000Z' });
  assert.deepEqual(h.record.events, []);
  assert.equal(h.record.disconnected, 1);
});

test('discover必要类目字段超过1MiB时分片完整保留所有路径与顺序', async t => {
  const largeCategories = Array.from({ length: 10000 }, (_, index) => {
    const segments = ['电商一级类目', '二级商品分类', `商品三级类目${index}`];
    return { displayPath: segments.join(' / '), segments, valuePath: ['100', '200', String(index)] };
  });
  const source = { categories: largeCategories, discoveredAt: '2026-10-12T00:00:00.000Z' };
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > 1024 * 1024);
  const h = harness(t, { dependencies: { async discoverCategories() { return source; } } });
  const result = await h.adapter.discover({}, h.context, h.api);
  const chunks = h.record.events.filter(event => event.type === 'options_chunk');
  assert.equal(chunks.length, 200);
  for (const chunk of chunks) {
    assert.equal(chunk.data.field, 'categories');
    assert.equal(chunk.data.items.length, 50);
    assert.ok(Buffer.byteLength(JSON.stringify({ protocolVersion: 1, requestId: 'fixture',
      operationId: 'fixture', type: chunk.type, data: chunk.data })) < 1024 * 1024);
  }
  assert.deepEqual(chunks.flatMap(chunk => chunk.data.items), largeCategories);
  assert.deepEqual(result, { categories: [], discoveredAt: source.discoveredAt });
  assert.equal(source.categories.length, 10000);
  assert.equal(h.record.disconnected, 1);
});

test('discover取消分片时停止发送并断开客户端', async t => {
  const largeCategories = Array.from({ length: 10000 }, (_, index) => ({
    displayPath: `电商商品分类${index}`, segments: [`电商商品分类${index}`], valuePath: [String(index)] }));
  const h = harness(t, { dependencies: { async discoverCategories() { return { categories: largeCategories }; } } });
  const emit = h.api.emit;
  h.api.emit = (type, data) => { emit(type, data); h.api.control.cancelled = true; };
  await assert.rejects(h.adapter.discover({}, h.context, h.api), error => error.code === 'CANCELLED');
  assert.equal(h.record.events.filter(event => event.type === 'options_chunk').length, 1);
  assert.equal(h.record.disconnected, 1);
});

test('run只用注入endpoint和状态路径，登记独占Excel且保留原列/工作表语义', async t => {
  const h = harness(t);
  assert.deepEqual(await h.adapter.run(parameters, h.context, h.api), { state: 'completed' });
  assert.deepEqual(h.record.collected, categories.map(item => item.displayPath));
  assert.deepEqual(h.record.connects, ['http://127.0.0.1:54321']);
  assert.equal(h.record.disconnected, 1);
  const candidate = h.record.candidates[0];
  assert.equal(candidate.candidateId, 'business-report');
  assert.equal(candidate.replaceRole, true);
  assert.equal(candidate.role, 'report');
  assert.ok(candidate.relpath.startsWith(`tasks/${TASK_ID}/staging/`));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(h.root, candidate.relpath));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['采集汇总', '成交增长', '失败记录']);
  const sheet = workbook.getWorksheet('成交增长');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['#', '产品分组', '类目', '产品名称', '近30天总成交', '昨日成交', '今日成交', '较昨日增长']);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.getCell('C2').value, '测试类目 A');
  assert.equal(sheet.getCell('A1').fill.fgColor.argb, 'FFDCE6F1');
  assert.equal(sheet.getCell('B2').isMerged, true);
  assert.equal(fs.existsSync(path.join(h.root, 'data')), false);
  assert.equal(fs.existsSync(path.join(h.root, 'reports')), false);
  assert.equal(h.state().results.length, 2);
});

for (const name of ['detail_failure', 'parse_failure', 'category_failure', 'incomplete_coverage']) {
  test(`retryFailed整体替换异常类目 ${name}，保留未选中的A`, async t => {
    const fixture = createTaskStateFixtures().find(item => item.name === name);
    const h = harness(t, { attempt: 2 });
    h.seed(fixture.task);
    h.context.retryFailed = true;
    assert.deepEqual(await h.adapter.run(fixture.task.parameters, h.context, h.api), { state: 'completed' });
    assert.deepEqual(h.record.collected, ['测试类目 B']);
    const state = h.state();
    assert.deepEqual(state.results.find(item => item.combinationId === 'a'), fixture.task.results.find(item => item.combinationId === 'a'));
    assert.equal(state.results.filter(item => item.combinationId === 'b').length, 1);
    assert.deepEqual(state.failures, []);
    assert.deepEqual(state.unparseableItems, []);
  });
}

test('resume跳过完成A，stopped B从头采集并替换部分结果', async t => {
  const fixture = createTaskStateFixtures().find(item => item.name === 'stopped');
  const h = harness(t, { attempt: 2 });
  h.seed(fixture.task);
  await h.adapter.run(fixture.task.parameters, h.context, h.api);
  assert.deepEqual(h.record.collected, ['测试类目 B']);
  assert.equal(h.state().results.length, 2);
  assert.equal(h.state().results.filter(item => item.combinationId === 'b').length, 1);
});

test('不能把无法映射的失败明细悄悄当作其他类目重试', async t => {
  const fixture = createTaskStateFixtures().find(item => item.name === 'detail_failure');
  fixture.task.failures[0].combinationId = 'missing';
  const h = harness(t, { attempt: 2 }); h.seed(fixture.task); h.context.retryFailed = true;
  await assert.rejects(h.adapter.run(fixture.task.parameters, h.context, h.api), error => error.code === 'INVALID_PARAMETERS');
  assert.equal(h.record.connects.length, 0);
});

test('类目失败不会阻止其他类目，最终成功与异常状态明确区分', async t => {
  const h = harness(t, { async collect(config) {
    if (config.categoryLabel.endsWith('A')) throw new Error('模拟类目失败');
    return payload();
  } });
  assert.deepEqual(await h.adapter.run(parameters, h.context, h.api), { state: 'completed_with_errors' });
  assert.equal(h.state().failures.length, 1);
  assert.equal(h.state().combinations[0].status, 'failed');
  assert.equal(h.state().combinations[1].status, 'completed');
});

test('run登录等待保留客户端，resume后类目从头替换，discover不永久等待', async t => {
  let calls = 0;
  const h = harness(t, { async collect(config, hooks) {
    if (calls++ === 0) {
      hooks.onSnapshot(payload('登录前部分结果'), 1);
      throw Object.assign(new Error('请登录'), { code: 'LOGIN_REQUIRED' });
    }
    return payload('登录后完整结果');
  } });
  await h.adapter.run({ ...parameters, categories: [categories[0]] }, h.context, h.api);
  assert.equal(h.record.waits, 1);
  assert.deepEqual(h.state().results.map(item => item.keyword), ['登录后完整结果']);
  assert.equal(h.record.disconnected, 1);
  const discovery = harness(t, { dependencies: { async discoverCategories() { throw Object.assign(new Error('请登录'), { code: 'LOGIN_REQUIRED' }); } } });
  await assert.rejects(discovery.adapter.discover({}, discovery.context, discovery.api), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(discovery.record.waits, 0);
  assert.equal(discovery.record.disconnected, 1);
});

test('取消保存最后安全快照并断开客户端，不继续下一类目', async t => {
  const h = harness(t, { async collect(config, hooks, api) {
    hooks.onSnapshot(payload(), 1); api.control.cancelled = true; await hooks.boundary();
  } });
  await assert.rejects(h.adapter.run(parameters, h.context, h.api), error => error.code === 'CANCELLED');
  assert.equal(h.state().status, 'stopped');
  assert.equal(h.state().results.length, 1);
  assert.equal(h.state().combinations[0].status, 'stopped');
  assert.equal(h.state().combinations[1].status, 'pending');
  assert.equal(h.record.candidates.length, 0);
  assert.equal(h.record.disconnected, 1);
});

test('同attempt登记成功checkpoint前重启通过lookup恢复，下一attempt替换角色', async t => {
  const task = createTaskStateFixtures()[0].task;
  const h = harness(t, { registration: { artifactId: 'registered', registeredAttempt: 1 } });
  h.seed(task);
  await h.adapter.run(task.parameters, h.context, h.api);
  assert.equal(h.record.candidates.length, 0);
  assert.equal(h.record.connects.length, 0);
  assert.equal(h.state().reportRegistration.artifactId, 'registered');
  h.context.attempt = 2;
  await h.adapter.run(task.parameters, h.context, h.api);
  assert.equal(h.record.candidates.length, 1);
  assert.equal(h.record.candidates[0].replaceRole, true);
});

test('新报告写入失败不重新登记或撤销旧报告引用', async t => {
  const task = createTaskStateFixtures()[0].task;
  task.reportRegistration = { artifactId: 'previous-report', registeredAttempt: 1 };
  const h = harness(t, { attempt: 2, registration: task.reportRegistration,
    dependencies: { async generateExcelReport() { throw new Error('模拟Excel写入失败'); } } });
  h.seed(task);
  await assert.rejects(h.adapter.run(task.parameters, h.context, h.api), /模拟Excel写入失败/);
  assert.equal(h.record.candidates.length, 0);
  assert.deepEqual(h.state().reportRegistration, task.reportRegistration);
  assert.equal(h.state().status, 'failed');
});

test('read_results拒绝跨任务、未来attempt或损坏状态，恢复不能更改业务参数', async t => {
  const task = createTaskStateFixtures()[0].task;
  const h = harness(t); h.seed(task);
  await assert.rejects(h.adapter.run({ ...task.parameters, minSales: 1 }, h.context, h.api), error => error.code === 'INVALID_PARAMETERS');
  const envelope = JSON.parse(fs.readFileSync(h.context.statePath, 'utf8'));
  for (const changes of [{ taskId: 'b'.repeat(32) }, { attempt: 2 }, { attempt: 0 }, { formatVersion: 2 }]) {
    fs.writeFileSync(h.context.statePath, JSON.stringify({ ...envelope, ...changes }));
    await assert.rejects(h.adapter.read_results({}, h.context), error => error.code === 'INVALID_PARAMETERS');
  }
  fs.writeFileSync(h.context.statePath, '{broken');
  await assert.rejects(h.adapter.read_results({}, h.context), error => error.code === 'INVALID_PARAMETERS');
});

test('A/B报告相互独立，分页历史读取不连接浏览器、不写状态', async t => {
  const a = harness(t, { taskId: 'a'.repeat(32), collect: async () => payload('A报告商品') });
  const b = harness(t, { dataRoot: a.root, taskId: 'b'.repeat(32), collect: async () => payload('B报告商品') });
  await a.adapter.run(parameters, a.context, a.api);
  const report = path.join(a.root, a.record.candidates[0].relpath);
  const before = fs.readFileSync(report);
  await b.adapter.run(parameters, b.context, b.api);
  assert.deepEqual(fs.readFileSync(report), before);
  const stateBefore = fs.readFileSync(a.context.statePath);
  const page = await a.adapter.read_results({ offset: 1, limit: 1 }, a.context);
  assert.equal(page.total, 2); assert.equal(page.items.length, 1);
  assert.equal(page.items[0].keyword, 'A报告商品');
  assert.deepEqual(fs.readFileSync(a.context.statePath), stateBefore);
  assert.equal(a.record.connects.length, 1);
  await assert.rejects(a.adapter.read_results({ limit: 201 }, a.context), error => error.code === 'INVALID_PARAMETERS');
});

test('历史详情支持results、failures、unparseableItems独立只读分页', async t => {
  const detail = createTaskStateFixtures().find(item => item.name === 'detail_failure').task;
  const parse = createTaskStateFixtures().find(item => item.name === 'parse_failure').task;
  const h = harness(t); detail.unparseableItems = parse.unparseableItems; h.seed(detail);
  const before = fs.readFileSync(h.context.statePath);
  for (const section of ['results', 'failures', 'unparseableItems']) {
    const result = await h.adapter.read_results({ section, offset: 0, limit: 1 }, h.context);
    assert.equal(result.total, detail[section].length);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].keyword, detail[section][0].keyword);
    const end = await h.adapter.read_results({ section, offset: result.total, limit: 1 }, h.context);
    assert.deepEqual(end.items, []);
  }
  await assert.rejects(h.adapter.read_results({ section: 'unknown' }, h.context), error => error.code === 'INVALID_PARAMETERS');
  assert.deepEqual(fs.readFileSync(h.context.statePath), before);
  assert.equal(h.record.connects.length, 0);
});

test('真实SDK暂停握手在DOM抽屉关闭且checkpoint后发生，resume继续当前类目', async t => {
  const page = fakeBusinessPage([
    { keyword: '第一条', salesAmount: '¥3万', growthTrend: 'up' },
    { keyword: '第二条', salesAmount: '¥2万', growthTrend: 'up' },
    { keyword: '结束', salesAmount: '¥5000', growthTrend: 'up' },
  ], categories[0].displayPath);
  const h = harness(t, { page, dependencies: { createCollector } });
  const events = [];
  const pending = new Map();
  let requested = false;
  const api = createApi(h.context, (type, data) => {
    events.push({ type, data });
    if (type === 'checkpoint' && !requested) {
      const state = h.state();
      if (state.results.length === 1) { requested = true; api.control.pauseRequested = true; }
    }
    if (type === 'state' && data.state === 'paused') {
      assert.equal(page.state.drawer, null);
      assert.equal(h.state().results.length, 1);
      setImmediate(() => { api.control.pauseRequested = false; });
    }
    if (type === 'artifact_lookup') {
      const waiting = pending.get(data.candidateId); pending.delete(data.candidateId);
      waiting.resolve({ candidateId: data.candidateId, registration: null });
    }
    if (type === 'artifact_candidate') {
      const waiting = pending.get(data.candidateId); pending.delete(data.candidateId);
      waiting.resolve({ candidateId: data.candidateId, artifactId: 'sdk-report', registeredAttempt: 1 });
    }
  }, pending, 'run');
  assert.deepEqual(await h.adapter.run({ ...parameters, categories: [categories[0]] }, h.context, api), { state: 'completed' });
  assert.ok(events.some(event => event.type === 'state' && event.data.state === 'paused'));
  assert.ok(events.some(event => event.type === 'state' && event.data.state === 'running'));
  assert.equal(h.state().results.length, 2);
});

test('冷导入适配器与业务模块无写盘、HTTP监听、子进程或CDP连接副作用', () => {
  const adapterPath = path.resolve(__dirname, '../../toolbox/node/adapters/business-center.cjs');
  const source = `const fs=require('node:fs');for(const name of ['mkdirSync','writeFileSync','renameSync','unlinkSync'])fs[name]=()=>{throw Error('write:'+name)};
    require('node:net').Server.prototype.listen=()=>{throw Error('listen')};
    const cp=require('node:child_process');cp.spawn=cp.exec=cp.execSync=()=>{throw Error('spawn')};
    require('playwright-core').chromium.connectOverCDP=()=>{throw Error('connect')};
    require(${JSON.stringify(adapterPath)});process.stdout.write('import-safe');`;
  const result = spawnSync(process.execPath, ['-e', source], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'import-safe');
});
