const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeCombinationResult, recomputeTaskStats } = require('../batch-runner');

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
