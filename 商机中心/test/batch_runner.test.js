const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCollectorEnv, mergeCombinationResult, recomputeTaskStats, taskReportPayload } = require('../batch-runner');

test('组合续跑会替换未完成类目的旧结果，不重复已保存明细', () => {
  const combination = { id: 'b', category: { displayPath: '类目 B' }, status: 'running' };
  const task = {
    combinations: [
      { id: 'a', category: { displayPath: '类目 A' }, status: 'completed', qualifyingCount: 1, stats: { normal: 1 } },
      combination,
    ],
    results: [
      { combinationId: 'a', categoryPath: '类目 A', keyword: 'A 商品' },
      { combinationId: 'b', categoryPath: '类目 B', keyword: 'B 旧结果' },
    ],
    failures: [{ combinationId: 'b', keyword: 'B 旧失败' }],
    unparseableItems: [],
  };

  mergeCombinationResult(task, combination, {
    qualifyingCount: 1,
    results: [{ keyword: 'B 新结果' }],
    failures: [],
    unparseableItems: [],
    stats: { normal: 1 },
    completion: { status: 'complete', coverageComplete: true },
  });
  recomputeTaskStats(task);

  assert.deepEqual(task.results.map((item) => item.keyword), ['A 商品', 'B 新结果']);
  assert.equal(task.failures.length, 0);
  assert.equal(task.results[1].categoryPath, '类目 B');
  assert.equal(task.stats.qualifyingCount, 2);
});

test('最终任务快照会基于合并结果重新计算跨类目产品分组', () => {
  const task = {
    taskId: 'task-1',
    createdAt: new Date().toISOString(),
    parameters: {
      categories: [{ displayPath: '类目 A' }, { displayPath: '类目 B' }],
      minSales: 0,
      maxSales: null,
    },
    combinations: [],
    results: [
      { keyword: '黄芪膏', categoryPath: '类目 A' },
      { keyword: '黄芪片', categoryPath: '类目 B' },
    ],
    failures: [],
    unparseableItems: [],
  };

  taskReportPayload(task, { status: 'complete', coverageComplete: true });

  assert.deepEqual(task.results.map((item) => item.productGroup), ['黄芪', '黄芪']);
});

test('批量采集子进程沿用任务保存的近30天预筛选模式', () => {
  const env = buildCollectorEnv({
    parameters: { minSales: 0, maxSales: null, only30dGrowth: true },
  }, {
    category: { displayPath: '类目 A', segments: ['类目 A'] },
  }, 'result.json', 'stop.flag', 'pause.flag');

  assert.equal(env.ONLY_30D_GROWTH, '1');
});

test('批量统计保留预筛选通过、跳过和实际打开详情数量', () => {
  const task = {
    combinations: [{
      status: 'completed',
      qualifyingCount: 3,
      stats: { normal: 1, prefilterPassed: 1, prefilterSkipped: 2, detailsOpened: 1 },
    }],
    results: [{}],
    failures: [],
    unparseableItems: [],
  };

  const stats = recomputeTaskStats(task);

  assert.deepEqual(
    [stats.prefilterPassed, stats.prefilterSkipped, stats.detailsOpened],
    [1, 2, 1],
  );
});
