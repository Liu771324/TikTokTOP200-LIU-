'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCollector } = require('../collect_v4');
const { countClassified } = require('../growth_prefilter');
const { runAttempts } = require('../collector_retry');
const { fakeBusinessPage } = require('./fixtures/fake_business_page');

function collector(options = {}, hooks = {}) {
  return createCollector({ categoryLabel: '测试类目', categorySearch: '测试类目', minSales: 10000,
    maxSales: 250000, strictCategory: true, maxItems: Infinity, maxPages: Infinity, stopFile: '', pauseFile: '',
    ...options }, { onLog() {}, ...hooks });
}

function row(keyword, salesAmount, periodChange = '100%', trendDir = 'up', growthTrend = 'up') {
  return { keyword, salesAmount, growthTrend, detail: { salesAmount: '¥2000', periodChange, trendDir } };
}

test('假页面执行真实DOM提取、金额边界和增长分类，暂停点均在关闭并归类后', async () => {
  const page = fakeBusinessPage([
    row('超上限', '¥25万-¥30万'), row('正常增长', '¥10万-¥25万'),
    row('增速快', '¥10万', '增速快', 'fast'), row('下跌', '¥9万', '50%', 'down'),
    row('持平', '¥8万', '持平', 'flat'), row('解析失败', '¥7万', '待更新'),
    row('下限增长', '¥1万', '100%+'), row('低于下限', '小于¥1万'),
  ]);
  let snapshot;
  const result = await collector({}, {
    onSnapshot(value) { snapshot = value; },
    async boundary() {
      assert.equal(page.state.drawer, null);
      assert.equal(countClassified(snapshot.stats), snapshot.qualifyingCount);
    },
  }).collect(page);
  assert.deepEqual(result.results.map((item) => item.keyword), ['正常增长', '增速快', '下限增长']);
  assert.equal(result.results[0].yesterday, '¥1000');
  assert.match(result.results[2].yesterday, /小于¥1000/);
  assert.equal(result.qualifyingCount, 6);
  assert.equal(result.stats.normal, 2);
  assert.equal(result.stats.fast, 1);
  assert.equal(result.stats.down, 1);
  assert.equal(result.stats.flat, 1);
  assert.equal(result.stats.unparseable, 1);
  assert.equal(result.completion.coverageComplete, true);
  assert.equal(page.state.opens.length, 6);
  assert.equal(page.state.closes, 6);
  assert.ok(snapshot.completion.coverageComplete);
});

test('近30天预筛选保持金额守恒，未通过的商品不打开详情', async () => {
  const page = fakeBusinessPage([row('增长', '¥3万'), row('下降', '¥2万', '100%', 'up', 'down'), row('结束', '¥5000')]);
  const result = await collector({ only30dGrowth: true }).collect(page);
  assert.deepEqual(page.state.opens, ['增长']);
  assert.equal(result.qualifyingCount, 2);
  assert.equal(result.stats.prefilterSkipped, 1);
  assert.equal(result.stats.prefilterPassed, 1);
  assert.equal(countClassified(result.stats), 2);
});

test('三次详情无数据只登记一个失败，并在关闭抽屉后保存', async () => {
  const page = fakeBusinessPage([row('无数据', '¥3万', ''), row('下跌', '¥2万', '50%', 'down'), row('结束', '¥5000')]);
  const result = await collector().collect(page);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].attempts, 3);
  assert.equal(result.stats.unavailable, 1);
  assert.equal(page.state.drawer, null);
  assert.equal(page.state.opens.filter((item) => item === '无数据').length, 3);
});

test('Aurora搜索框为空时读取同组件已选完整路径，优先title并可回退显示文字', async () => {
  const categoryLabel = '测试父类 / 测试分组 / 同名末级';
  for (const title of [categoryLabel, '']) {
    const page = fakeBusinessPage([row('增长', '¥3万'), row('结束', '¥5000'), row('更低', '¥1000')], categoryLabel);
    page.state.categoryTitle = title;
    page.state.categoryText = title ? '同名末级' : categoryLabel;
    assert.equal(page.state.categoryInputValue, '');
    const result = await collector({ categoryLabel, categorySearch: '同名末级' }).collect(page);
    assert.equal(result.results.length, 1);
    assert.equal(result.completion.coverageComplete, true);
  }
});

test('同名末级的父类改变时拒绝采集，不使用搜索框目标文字掩盖已选路径', async () => {
  const categoryLabel = '原父类 / 同名末级';
  const page = fakeBusinessPage([row('增长', '¥3万'), row('结束', '¥5000'), row('更低', '¥1000')], categoryLabel);
  await assert.rejects(collector({ categoryLabel, categorySearch: '同名末级' }, {
    async boundary() {
      page.state.categoryLabel = '其他父类 / 同名末级';
      page.state.categoryInputValue = categoryLabel;
    },
  }).collect(page), error => error.code === 'PAGE_CHANGED');
  assert.deepEqual(page.state.opens, []);
});

test('暂停安全边界后已选完整路径改变，空搜索框下仍拒绝处理下一条', async () => {
  const categoryLabel = '原父类 / 同名末级';
  const page = fakeBusinessPage([row('第一条', '¥3万'), row('第二条', '¥2万'), row('结束', '¥5000')], categoryLabel);
  let saved;
  await assert.rejects(collector({ categoryLabel, categorySearch: '同名末级' }, {
    onSnapshot(value) { saved = value; },
    async boundary() {
      if (saved.qualifyingCount === 1) page.state.categoryLabel = '其他父类 / 同名末级';
    },
  }).collect(page), error => error.code === 'PAGE_CHANGED');
  assert.equal(page.state.categoryInputValue, '');
  assert.deepEqual(page.state.opens, ['第一条']);
  assert.equal(page.state.drawer, null);
});

test('暂停恢复后类目、页码或排序改变，拒绝使用旧行继续采集', async () => {
  for (const change of [page => { page.state.categoryLabel = '其他类目'; },
    page => { page.state.pageNumber = 2; }, page => { page.state.sortDirection = 'ascending'; },
    page => { page.state.rows[1].salesAmount = '¥1.5万'; }]) {
    const page = fakeBusinessPage([row('第一条', '¥3万'), row('第二条', '¥2万'), row('结束', '¥5000')]);
    let saved;
    await assert.rejects(collector({}, {
      onSnapshot(value) { saved = value; },
      async boundary() { if (saved.qualifyingCount === 1) change(page); },
    }).collect(page), error => error.code === 'PAGE_CHANGED');
    assert.deepEqual(page.state.opens, ['第一条']);
  }
});

test('取消在安全边界发生，最后一条已归类快照可恢复', async () => {
  const page = fakeBusinessPage([row('第一条', '¥3万'), row('第二条', '¥2万'), row('结束', '¥5000')]);
  let saved;
  await assert.rejects(collector({}, {
    onSnapshot(value) { saved = value; },
    async boundary() { if (saved.qualifyingCount === 1) throw Object.assign(new Error('已取消'), { code: 'CANCELLED' }); },
  }).collect(page), error => error.code === 'CANCELLED');
  assert.equal(saved.results.length, 1);
  assert.equal(page.state.drawer, null);
  assert.deepEqual(page.state.opens, ['第一条']);
});

test('抽屉关闭失败不会重试下一商品或报告paused安全边界', async () => {
  const page = fakeBusinessPage([row('第一条', '¥3万'), row('第二条', '¥2万'), row('结束', '¥5000')]);
  page.state.failClose = true;
  let boundaries = 0;
  await assert.rejects(collector({}, { async boundary() { boundaries += 1; } }).collect(page), error => error.code === 'PAGE_CHANGED');
  assert.equal(boundaries, 1);
  assert.deepEqual(page.state.opens, ['第一条']);
});

test('注入PAUSE_FILE生效，STOP_FILE可打断等待，不读取源码默认flag', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'business-pause-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pauseFile = path.join(directory, 'owned-pause.flag');
  const stopFile = path.join(directory, 'owned-stop.flag');
  const oldPause = process.env.PAUSE_FILE;
  const oldStop = process.env.STOP_FILE;
  process.env.PAUSE_FILE = pauseFile;
  process.env.STOP_FILE = stopFile;
  t.after(() => { if (oldPause === undefined) delete process.env.PAUSE_FILE; else process.env.PAUSE_FILE = oldPause;
    if (oldStop === undefined) delete process.env.STOP_FILE; else process.env.STOP_FILE = oldStop; });
  fs.writeFileSync(pauseFile, '');
  const page = fakeBusinessPage([row('第一条', '¥3万'), row('第二条', '¥2万'), row('结束', '¥5000')]);
  const operation = createCollector({ categoryLabel: '测试类目', categorySearch: '测试类目', strictCategory: true,
    minSales: 10000, maxSales: 250000 }, { onLog() {} }).collect(page);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(page.state.opens.length, 0);
  fs.writeFileSync(stopFile, '');
  const result = await operation;
  assert.equal(result.completion.reason, 'user-stopped');
});

test('控制错误从重试层原样传播', async () => {
  const error = Object.assign(new Error('已取消'), { code: 'CANCELLED' });
  await assert.rejects(runAttempts({ operation: async () => { throw error; }, shouldRetry: () => false }), value => value === error);
});
