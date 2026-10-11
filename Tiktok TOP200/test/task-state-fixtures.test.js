'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/task-states.json');
const { createCombinationId, parseTrend } = require('../collector-utils');

test('状态 fixture 覆盖七种脱敏场景，原生任务与未来宿主预期分开', () => {
  assert.equal(fixtures.fixtureVersion, 1);
  assert.equal(fixtures.designVersion, '0.2');
  assert.deepEqual(fixtures.cases.map((item) => item.id), [
    'clean', 'interrupted', 'combination_failed', 'row_link_failed',
    'row_trend_failed', 'all_failed', 'connection_failed',
  ]);
  assert.equal(new Set(fixtures.cases.map((item) => item.task.taskId)).size, 7);
});

for (const scenario of fixtures.cases) {
  test(`状态 fixture 自洽：${scenario.id}`, () => {
    const { task, expected } = scenario;
    const ids = task.combinations.map((item) => item.id);
    assert.equal(task.parameters.rankLimit, 200);
    assert.equal(task.parameters.periodPolicy, '实时优先，否则近1天');
    assert.equal(task.combinations.length, task.parameters.categories.length * task.parameters.rankingTypes.length);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(task.reportFiles, null);
    assert.equal('expected' in task, false);
    assert.equal('observedError' in task, false);
    assert.equal(new Date(task.createdAt).toISOString(), task.createdAt);
    for (const combination of task.combinations) {
      assert.equal(combination.id, createCombinationId(combination.category.displayPath, combination.rankingType));
      const records = task.results.filter((record) => record.combinationId === combination.id);
      assert.equal(combination.saved, records.length);
      if (combination.status !== 'completed') assert.equal(records.length, 0);
    }
    for (const record of task.results) {
      assert.equal(record.taskId, task.taskId);
      assert.ok(ids.includes(record.combinationId));
      assert.match(record.productName, /^脱敏商品/);
      assert.match(record.shopName, /^脱敏店铺/);
      if (record.productUrl) assert.equal(new URL(record.productUrl).hostname, 'example.test');
      const trend = parseTrend({ text: record.trendText, up: record.trendType === 'up' });
      assert.equal(trend.trendType, record.trendType);
      assert.equal(trend.riseCount, record.riseCount);
    }
    for (const failure of task.failures) {
      const combination = task.combinations.find((item) => item.id === failure.combinationId);
      assert.ok(combination);
      assert.equal(failure.categoryPath, combination.category.displayPath);
      assert.equal(failure.rankingType, combination.rankingType);
      assert.equal(new Date(failure.at).toISOString(), failure.at);
    }
    const completed = task.combinations.filter((item) => item.status === 'completed');
    assert.equal(task.stats.totalCombinations, task.combinations.length);
    assert.equal(task.stats.completedCombinations, completed.length);
    for (const field of ['scanned', 'up', 'first', 'excluded', 'unparseable', 'duplicates']) {
      assert.equal(task.stats[field], completed.reduce((sum, item) => sum + item[field], 0));
    }
    assert.deepEqual(expected.resumeCombinationIds, task.combinations.filter((item) => item.status !== 'completed').map((item) => item.id));
    const abnormal = new Set([
      ...task.combinations.filter((item) => item.status === 'failed').map((item) => item.id),
      ...task.failures.map((item) => item.combinationId),
    ]);
    assert.deepEqual(expected.retryCombinationIds, ids.filter((id) => abnormal.has(id)));
    assert.equal(expected.restartPage, expected.resumeCombinationIds.length || expected.retryCombinationIds.length ? 1 : null);
  });
}

test('中断、逐行错误和连接错误样本保留旧实现差异，不冒充真实恢复测试', () => {
  const byId = Object.fromEntries(fixtures.cases.map((item) => [item.id, item]));
  assert.equal(byId.clean.expected.state, 'completed');
  assert.equal(byId.interrupted.task.status, 'running');
  assert.equal(byId.interrupted.task.current.page, 2);
  assert.equal(byId.interrupted.expected.trigger, 'host_restart');
  assert.equal(byId.interrupted.expected.state, 'interrupted');
  for (const id of ['combination_failed', 'row_link_failed', 'row_trend_failed']) {
    assert.equal(byId[id].task.status, 'completed');
    assert.equal(byId[id].expected.state, 'completed_with_errors');
  }
  assert.equal(byId.row_link_failed.task.results[0].productUrl, '');
  assert.equal(byId.row_link_failed.task.failures[0].stage, '商品链接');
  assert.equal(byId.row_trend_failed.task.failures[0].stage, '趋势解析');
  assert.equal(byId.row_trend_failed.task.stats.unparseable, 1);
  assert.equal(byId.all_failed.task.status, 'completed');
  assert.equal(byId.all_failed.task.results.length, 0);
  assert.equal(byId.all_failed.expected.state, 'failed');
  assert.equal(byId.connection_failed.task.status, 'running');
  assert.equal(byId.connection_failed.task.failures.length, 0);
  assert.equal(byId.connection_failed.observedError.code, 'BROWSER_DISCONNECTED');
  assert.equal(byId.connection_failed.expected.trigger, 'connection_error');
  assert.equal(byId.connection_failed.expected.state, 'failed');
});
