'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const collector = require('../../../engines/top200/collector');
const store = require('../../../engines/top200/task-store');
const { atomicState } = require('../../../node/sdk.cjs');
const adapterModule = require('../../../node/adapters/top200.cjs');
const fixtures = require('./fixtures/task-states.json').cases;
const copy = value => JSON.parse(JSON.stringify(value));

function setup(t, fixtureId, attempt = 2) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'top200-adapter-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const taskId = 'a'.repeat(32);
  const context = { protocolVersion: 1, toolId: 'top200', taskId, attempt, dataRoot,
    statePath: path.join(dataRoot, 'tasks', taskId, 'engine-state.json'),
    artifactStagingRoot: path.join(dataRoot, 'tasks', taskId, 'staging'),
    browser: { endpoint: 'http://127.0.0.1:1', leaseId: 'fixture' } };
  const task = copy(fixtures.find(item => item.id === (fixtureId || 'clean')).task);
  task.taskId = taskId;
  task.results.forEach(record => { record.taskId = taskId; });
  const parameters = { categories: task.parameters.categories, rankingTypes: task.parameters.rankingTypes, brandType: task.parameters.brandType };
  if (fixtureId) atomicState({ ...context, attempt: 1 }, task);
  const events = [], candidates = [], seen = [], registrations = new Map();
  let boundaries = 0, disconnected = 0, connected = 0;
  const page = { waitForTimeout: async () => {}, evaluate: async () => ({ rows: [], page: 1 }),
    isClosed: () => false, url: () => 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank' };
  const api = {
    control: { cancelled: false, pauseRequested: false },
    checkpoint(state) { atomicState(context, state); },
    emit(type, data) { events.push({ type, data }); },
    async boundary() { boundaries++; if (this.control.cancelled) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' }); },
    async waitForUser(message) { events.push({ type: 'waiting_user', message }); },
    async lookup(candidateId) { return { candidateId, registration: registrations.get(candidateId) || null }; },
    async register(candidate) { candidates.push(candidate); const registration = { artifactId: 'b'.repeat(32), registeredAttempt: context.attempt };
      registrations.set(candidate.candidateId, registration); return registration; },
  };
  const connection = async () => { connected++; return { page, context: { pages: () => [page] },
    disconnect: async () => { disconnected++; } }; };
  const collect = async ({ task: current, combination, control }) => {
    await control.waitIfPaused();
    control.throwIfStopped();
    seen.push({ id: combination.id, page: 1 });
    const record = { ...copy(task.results[0] || {}), taskId, combinationId: combination.id,
      rankingType: combination.rankingType, categoryPath: combination.category.displayPath, productName: '新采集样本', page: 1 };
    return { records: [record], period: { requestedPeriod: '实时', actualPeriod: '实时' },
      local: { scanned: 1, up: 1, first: 0, excluded: 0, unparseable: 0, duplicates: 0 }, endedReason: 'fixture' };
  };
  const makeAdapter = (overrides = {}) => adapterModule.createAdapter({
    collector: { ...collector, runTask: (current, control, log, options) => collector.runTask(current, control, log, { ...options, collectCombination: collect }) },
    connect: connection, checkPage: async () => {}, ...overrides,
  });
  return { context, task, parameters, api, events, candidates, seen, registrations, page, collect, makeAdapter,
    saved: () => JSON.parse(fs.readFileSync(context.statePath, 'utf8')).state,
    counts: () => ({ boundaries, disconnected, connected }) };
}

test('导入与纯任务工厂不创建目录；原生独立入口 API 保留', () => {
  const mkdir = fs.mkdirSync;
  let calls = 0;
  fs.mkdirSync = () => { calls++; throw new Error('import mkdir'); };
  try {
    for (const name of ['../../../engines/top200/task-store', '../../../engines/top200/export-excel', '../../../engines/top200/collector', '../../../node/adapters/top200.cjs']) delete require.cache[require.resolve(name)];
    const imported = require('../../../node/adapters/top200.cjs');
    const factory = require('../../../engines/top200/task-store');
    const parameters = { categories: [{ displayPath: '样本', segments: ['样本', '全部'] }], rankingTypes: ['总榜'], brandType: '不限' };
    assert.equal(factory.createTaskState(parameters, { taskId: 'a'.repeat(32) }).parameters.rankLimit, 200);
    assert.equal(typeof imported.run, 'function');
    for (const name of ['createTask', 'saveTask', 'loadTask', 'listTasks']) assert.equal(typeof factory[name], 'function');
    assert.equal(calls, 0);
  } finally { fs.mkdirSync = mkdir; }
});

test('参数保持发现结果末尾全部，拒绝不匹配路径、重复组合和用户覆盖业务常量', () => {
  const parameters = { categories: [{ displayPath: '样本 / 二级', segments: ['样本', '二级', '全部'] }], rankingTypes: ['总榜'], brandType: '不限' };
  assert.deepEqual(adapterModule.validateParameters(parameters), parameters);
  assert.throws(() => adapterModule.validateParameters({ ...parameters, rankLimit: 1 }), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => adapterModule.validateParameters({ ...parameters, rankingTypes: ['总榜', '总榜'] }), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => adapterModule.validateParameters({ ...parameters, categories: [{ displayPath: '样本', segments: ['另一个'] }] }), { code: 'INVALID_PARAMETERS' });
});

for (const fixtureId of ['clean', 'row_link_failed', 'row_trend_failed', 'all_failed']) {
  test(`真实状态映射及报表恢复：${fixtureId}`, async t => {
    const fixture = fixtures.find(item => item.id === fixtureId);
    const s = setup(t, fixtureId);
    // Final-state mapping is independent of execution/retry; failed units still rerun on resume.
    assert.equal(adapterModule.finalState(s.task), fixture.expected.state);
    if (fixtureId === 'all_failed') return;
    const result = await s.makeAdapter().run(s.parameters, s.context, s.api);
    assert.equal(result.state, fixture.expected.state);
    assert.equal(s.counts().connected, 0);
    assert.equal(s.candidates[0].replaceRole, true);
    assert.equal(s.candidates[0].candidateId, 'top200-report');
    assert.equal(s.saved().reportFiles.artifactId, result.reportArtifactId);
    const filenames = fs.readdirSync(s.context.artifactStagingRoot);
    assert.deepEqual(filenames, ['top200-report.xlsx']);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(s.context.artifactStagingRoot, filenames[0]));
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['任务汇总', '总榜明细', '搜索榜明细', '失败记录']);
  });
}

test('中断组合从第一页重采，完成组合和已有结果保持', async t => {
  const s = setup(t, 'interrupted');
  const first = copy(s.task.results[0]);
  const result = await s.makeAdapter().run(s.parameters, s.context, s.api);
  assert.equal(result.state, 'completed');
  assert.deepEqual(s.seen, [{ id: s.task.combinations[1].id, page: 1 }]);
  assert.deepEqual(s.saved().results[0], first);
  assert.equal(s.counts().disconnected, 1);
});

for (const fixtureId of ['combination_failed', 'row_link_failed', 'row_trend_failed']) {
  test(`重试整体替换异常组合并保留其他组合：${fixtureId}`, async t => {
    const s = setup(t, fixtureId);
    s.context.retryFailed = true;
    const selected = adapterModule.retryCombinations(s.task);
    const preserved = s.task.results.filter(record => !selected.includes(record.combinationId));
    const result = await s.makeAdapter().run(s.parameters, s.context, s.api);
    assert.equal(result.state, 'completed');
    assert.deepEqual(s.seen.map(item => item.id), selected);
    assert.deepEqual(s.saved().results.filter(record => !selected.includes(record.combinationId)), preserved);
    assert.equal(s.saved().failures.length, 0);
    assert.equal(s.saved().results.filter(record => selected.includes(record.combinationId)).length, selected.length);
  });
}

test('未知失败组合明确报错，不默选其他组合', t => {
  const s = setup(t, 'row_link_failed');
  s.task.failures[0].combinationId = 'missing';
  assert.throws(() => adapterModule.retryCombinations(s.task), { code: 'INVALID_STATE' });
});

test('连接失败尚无异常组合时拒绝空范围重试，要求恢复未完成组合', async t => {
  const s = setup(t, 'connection_failed');
  s.context.retryFailed = true;
  await assert.rejects(s.makeAdapter().run(s.parameters, s.context, s.api), { code: 'INVALID_STATE' });
  assert.equal(s.counts().connected, 0);
  assert.equal(s.candidates.length, 0);
});

test('连接失败落盘 failed，取消落盘 stopped，不运行后续组合或登记', async t => {
  const s = setup(t, 'connection_failed');
  await assert.rejects(s.makeAdapter({ connect: async () => { throw Object.assign(new Error('fixture connection failure'), { code: 'BROWSER_DISCONNECTED' }); } })
    .run(s.parameters, s.context, s.api), { code: 'BROWSER_DISCONNECTED' });
  assert.equal(s.saved().status, 'failed');
  s.api.control.cancelled = true;
  await assert.rejects(s.makeAdapter().run(s.parameters, s.context, s.api), { code: 'CANCELLED' });
  assert.equal(s.saved().status, 'stopped');
  assert.equal(s.candidates.length, 0);
});

test('组合采集持续失败重试三次，全部失败真实返回 failed 并生成失败报表', async t => {
  const s = setup(t, 'all_failed');
  let attempts = 0;
  const engine = { ...collector, runTask: (task, control, log, options) => collector.runTask(task, control, log, {
    ...options, collectCombination: async () => { attempts++; throw new Error('fixture combination failure'); },
  }) };
  const result = await s.makeAdapter({ collector: engine }).run(s.parameters, s.context, s.api);
  assert.equal(result.state, 'failed');
  assert.equal(attempts, 6);
  assert.equal(s.saved().failures.length, 2);
  assert.equal(s.counts().disconnected, 1);
});

test('登录中断保存后等待人工继续，再从组合开头恢复', async t => {
  const s = setup(t, 'interrupted');
  let checks = 0;
  const result = await s.makeAdapter({ checkPage: async () => {
    if (++checks === 1) throw Object.assign(new Error('请完成登录'), { code: 'LOGIN_REQUIRED' });
  } }).run(s.parameters, s.context, s.api);
  assert.equal(result.state, 'completed');
  assert.equal(s.events.filter(event => event.type === 'waiting_user').length, 1);
  assert.equal(s.counts().connected, 2);
  assert.equal(s.counts().disconnected, 2);
  assert.equal(s.seen.length, 1);
});

test('人工验证等待时取消，保存 stopped 并保持已完成组合', async t => {
  const s = setup(t, 'interrupted');
  s.api.waitForUser = async () => {
    assert.equal(s.saved().status, 'waiting_user');
    s.api.control.cancelled = true;
    throw Object.assign(new Error('fixture cancel waiting user'), { code: 'CANCELLED' });
  };
  await assert.rejects(s.makeAdapter({ checkPage: async () => {
    throw Object.assign(new Error('请完成验证'), { code: 'VERIFICATION_REQUIRED' });
  } }).run(s.parameters, s.context, s.api), { code: 'CANCELLED' });
  assert.equal(s.saved().status, 'stopped');
  assert.equal(s.saved().combinations[0].status, 'completed');
  assert.equal(s.counts().disconnected, 1);
  assert.equal(s.candidates.length, 0);
});

test('异常组合整体重采失败时，不留下旧完成统计或旧结果', async t => {
  const s = setup(t, 'row_link_failed');
  s.context.retryFailed = true;
  const selected = adapterModule.retryCombinations(s.task);
  const engine = { ...collector, runTask: (task, control, log, options) => collector.runTask(task, control, log, {
    ...options, collectCombination: async () => { throw new Error('fixture replacement failed'); },
  }) };
  const result = await s.makeAdapter({ collector: engine }).run(s.parameters, s.context, s.api);
  assert.equal(result.state, 'completed_with_errors');
  const combination = s.saved().combinations.find(item => selected.includes(item.id));
  assert.equal(combination.status, 'failed');
  assert.equal(combination.saved, 0);
  assert.equal(combination.scanned, 0);
  assert.equal(combination.completedAt, null);
  assert.equal(s.saved().results.some(record => selected.includes(record.combinationId)), false);
});

test('暂停只在已保存安全边界确认，取消可阻止浏览器连接', async t => {
  const s = setup(t, 'interrupted');
  s.api.control.pauseRequested = true;
  s.api.boundary = async () => {
    assert.equal(s.saved().taskId, s.context.taskId);
    assert.equal(s.api.control.pauseRequested, true);
    s.api.control.cancelled = true;
    throw Object.assign(new Error('fixture cancel while paused'), { code: 'CANCELLED' });
  };
  await assert.rejects(s.makeAdapter().run(s.parameters, s.context, s.api), { code: 'CANCELLED' });
  assert.equal(s.counts().connected, 0);
  assert.equal(s.saved().status, 'stopped');
});

test('登记成功但 checkpoint 前退出：同 attempt lookup 恢复，不重复导出/登记；下一 attempt 替换', async t => {
  const s = setup(t, 'clean');
  s.registrations.set('top200-report', { artifactId: 'c'.repeat(32), registeredAttempt: s.context.attempt });
  let writes = 0;
  const adapter = s.makeAdapter({ exportTask: async () => { writes++; } });
  const result = await adapter.run(s.parameters, s.context, s.api);
  assert.equal(result.reportArtifactId, 'c'.repeat(32));
  assert.equal(writes, 0);
  assert.equal(s.candidates.length, 0);
  s.context.attempt++;
  await s.makeAdapter().run(s.parameters, s.context, s.api);
  assert.equal(s.candidates.length, 1);
  assert.equal(s.candidates[0].replaceRole, true);
});

test('结果只读分页超过十条，不连接浏览器或写状态；拒绝错误身份及参数', async t => {
  const s = setup(t, 'clean');
  s.task.results = Array.from({ length: 23 }, (_, rank) => ({ rank: rank + 1 }));
  atomicState({ ...s.context, attempt: 1 }, s.task);
  const before = fs.readFileSync(s.context.statePath, 'utf8');
  const adapter = s.makeAdapter();
  const result = await adapter.read_results({ offset: 20, limit: 10 }, s.context, s.api);
  assert.equal(result.total, 23);
  assert.deepEqual(result.items.map(row => row.rank), [21, 22, 23]);
  assert.equal(fs.readFileSync(s.context.statePath, 'utf8'), before);
  assert.equal(s.counts().connected, 0);
  await assert.rejects(adapter.read_results({ offset: -1 }, s.context), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(adapter.read_results({}, { ...s.context, taskId: 'd'.repeat(32) }), { code: 'INVALID_STATE' });
});

test('受管浏览器连接失败释放自身连接，明确页面 ID 不接管其他页面', async () => {
  let released = 0, created = 0;
  const client = { connect: async () => ({ browser: { contexts: () => [{ newPage: async () => { created++; } }] }, disconnect: async () => { released++; } }),
    selectPage: async () => { throw Object.assign(new Error('missing selected page'), { code: 'BROWSER_DISCONNECTED' }); } };
  await assert.rejects(adapterModule.managedConnection({ browser: { pageId: 'selected' } }, client), { code: 'BROWSER_DISCONNECTED' });
  assert.equal(released, 1);
  assert.equal(created, 0);
  assert.equal(adapterModule.isTarget('https://compass.jinritemai.com.evil.test/shop/chance/merchandise-product-rank'), false);
});

test('受管页面未准备好/未登录都释放自身连接，发现不无限等待人工控制', async t => {
  const s = setup(t);
  let released = 0;
  const page = { ...s.page, bringToFront: async () => {}, locator: () => ({ count: async () => 0 }),
    waitForFunction: async () => { throw new Error('fixture not loaded'); } };
  const client = { connect: async () => ({ browser: {}, disconnect: async () => { released++; } }), selectPage: async () => page };
  await assert.rejects(adapterModule.managedConnection(s.context, client), { code: 'PAGE_NOT_READY' });
  assert.equal(released, 1);
  let waited = 0;
  s.api.waitForUser = async () => { waited++; };
  const adapter = s.makeAdapter({ checkPage: async () => { throw Object.assign(new Error('fixture login'), { code: 'LOGIN_REQUIRED' }); } });
  await assert.rejects(adapter.discover({}, s.context, s.api), { code: 'LOGIN_REQUIRED' });
  assert.equal(waited, 0);
  assert.equal(s.counts().disconnected, 1);
  assert.equal(fs.existsSync(s.context.statePath), false);
});

test('发现操作复用核心接口、原始 categories segments 与 rankingTypes，不创建正式任务', async t => {
  const s = setup(t);
  const expected = { categories: [{ displayPath: '样本', segments: ['样本', '全部'] }],
    rankingTypes: [{ name: '总榜', periods: [], preferredPeriod: '实时' }], brandTypes: ['不限', '知名品牌', '非知名品牌'] };
  const adapter = s.makeAdapter({ collector: { discoverOptions: async (log, options) => {
    const connection = await options.connectTargetPage();
    try { log('fixture discover'); return expected; } finally { await connection.disconnect(); }
  } } });
  assert.deepEqual(await adapter.discover({}, s.context, s.api), expected);
  assert.equal(fs.existsSync(s.context.statePath), false);
  assert.equal(s.counts().disconnected, 1);
});

test('真实组合核心在假页面从第一页检查原始前200名，趋势/周期/筛选及逐行边界保持', async () => {
  const parameters = { categories: [{ displayPath: '样本', segments: ['样本', '全部'] }], rankingTypes: ['总榜'], brandType: '不限' };
  const task = store.createTaskState(parameters, { taskId: 'a'.repeat(32) });
  task.current = { combinationId: task.combinations[0].id };
  let currentPage = 2, saves = 0, boundaries = 0;
  const actions = [];
  const trends = [{ up: true, valueText: '2' }, { first: true }, { down: true }, { equal: true }, { text: '无法解析' }];
  const rows = Array.from({ length: 205 }, (_, index) => ({ rankText: String(index + 1), rowIndex: index + 1,
    cellTexts: ['', `商品${index + 1}`, '店铺'], productName: `商品${index + 1}`, shopName: '店铺', priceRange: '¥20', trend: trends[index % 5] }));
  function locator(selector, rowIndex = 0) {
    return {
      first() { return this; }, filter() { return this; },
      nth(index) { return locator(selector, selector.includes('tbody tr') ? index : rowIndex); },
      locator(child) { return locator(child, rowIndex); },
      async count() { return 1; }, async waitFor() {},
      async innerText() { return '样本'; },
      async getAttribute(name) { return name === 'class' ? 'active' : 'true'; },
      async evaluateAll() { return [{ index: 0, text: `商品${rowIndex + 1}`, href: `https://example.test/product/${rowIndex + 1}`, classes: 'name' }]; },
      async click() { actions.push(selector); if (selector.includes('pagination-item-1')) currentPage = 1; },
    };
  }
  const page = { locator, getByRole: (role, options) => { actions.push(options.name); return locator(options.name); },
    waitForTimeout: async () => {},
    evaluate: async fn => fn.toString().includes('input[type=')
      ? [{ value: 'one', label: '近1天', checked: true, disabled: false, control: 'tab' }]
      : { headers: ['排名', '商品', '店铺名称'], rows: copy(rows), page: currentPage, total: 205, hasNext: false },
  };
  const result = await collector.collectCombination({ page, context: { pages: () => [page] }, task,
    combination: task.combinations[0], save: () => { saves++; }, log: () => {},
    control: { waitIfPaused: async () => { boundaries++; }, throwIfStopped() {} } });
  assert.equal(currentPage, 1);
  assert.equal(result.local.scanned, 200);
  assert.equal(result.local.up, 40);
  assert.equal(result.local.first, 40);
  assert.equal(result.local.excluded, 80);
  assert.equal(result.local.unparseable, 40);
  assert.equal(result.records.length, 80);
  assert.equal(task.failures.length, 40);
  assert.equal(result.period.actualPeriod, '近1天');
  assert.ok(result.records.every(record => record.rank <= 200 && record.page === 1));
  assert.ok(saves >= 200 && boundaries >= 200);
  assert.ok(actions.includes('总榜') && actions.includes('近1天'));
});
