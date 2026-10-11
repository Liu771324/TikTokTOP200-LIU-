const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskStateFixtures } = require('./fixtures/task_states');
const { mergeCombinationResult, recomputeTaskStats, taskReportPayload } = require('../batch-runner');
const { buildMarkdown } = require('../report_output');
const { countClassified } = require('../growth_prefilter');

for (const fixture of createTaskStateFixtures()) {
  test(`脱敏状态 fixture ${fixture.name} 与旧统计及报告形状兼容`, () => {
    const { task, completion, expected } = fixture;
    const original = JSON.stringify(task);
    const restored = JSON.parse(original);
    const stats = recomputeTaskStats(restored);
    for (const [key, value] of Object.entries(expected.nativeStats)) assert.equal(stats[key], value, key);
    assert.equal(countClassified(stats), stats.qualifyingCount);
    const ids = new Set(restored.combinations.map((item) => item.id));
    for (const item of [...restored.results, ...restored.failures, ...restored.unparseableItems]) {
      assert.ok(ids.has(item.combinationId));
      assert.equal(item.categoryPath, restored.combinations.find((unit) => unit.id === item.combinationId).category.displayPath);
    }
    const payload = taskReportPayload(restored, completion);
    payload.outputTime = new Date('2026-10-11T00:00:02.000Z');
    payload.elapsedSeconds = 2;
    const markdown = buildMarkdown(payload);
    assert.ok(markdown.includes(`> 采集状态: ${completion.status === 'partial' ? '部分结果' : '完整结果'}`));
    assert.ok(markdown.includes(`> 区间覆盖: ${completion.coverageComplete ? '已完成' : '未完成'}`));
    assert.equal(JSON.stringify(task), original, '纯输入 fixture 不被验证过程修改');
  });
}

for (const fixture of createTaskStateFixtures().filter((item) => item.name !== 'clean')) {
  test(`脱敏状态 fixture ${fixture.name} 复用旧合并函数可整体替换 B 并保留 A`, () => {
    const { task } = fixture;
    const healthy = structuredClone(task.results.filter((item) => item.combinationId === 'a'));
    const target = task.combinations.find((item) => item.id === 'b');
    const replacement = { keyword: '脱敏重新采集商品', totalSales: '¥1万', yesterday: '¥1000', today: '¥2000', growth: '100%' };
    const payload = {
      qualifyingCount: 1, results: [replacement], failures: [], unparseableItems: [],
      stats: { normal: 1, detailsOpened: 1 }, elapsedSeconds: 1,
      completion: { status: 'complete', coverageComplete: true },
    };
    mergeCombinationResult(task, target, payload);
    mergeCombinationResult(task, target, payload);
    assert.deepEqual(task.results.filter((item) => item.combinationId === 'a'), healthy);
    assert.deepEqual(task.results.filter((item) => item.combinationId === 'b'), [{ ...replacement, categoryPath: target.category.displayPath, combinationId: 'b' }]);
    assert.equal(task.failures.length, 0);
    assert.equal(task.unparseableItems.length, 0);
    assert.equal(target.coverageComplete, true);
  });
}

test('脱敏状态 fixture 每次创建返回独立对象且不包含机器路径或网络地址', () => {
  const first = createTaskStateFixtures();
  const second = createTaskStateFixtures();
  assert.equal(first.length, 6);
  assert.equal(new Set(first.map((item) => item.name)).size, 6);
  first[0].task.results[0].keyword = '修改副本';
  assert.equal(second[0].task.results[0].keyword, '测试黄芪片');
  assert.equal(first[1].task.results[0].keyword, '测试黄芪片');
  assert.doesNotMatch(JSON.stringify(second), /https?:\/\/|[A-Za-z]:[\\/]|cookie|token/i);
});
