'use strict';

const TIME = '2026-10-11T00:00:00.000Z';
const complete = { status: 'complete', reason: 'all-categories-complete', message: '全部类目扫描完成', coverageComplete: true };

function category(id) {
  return { displayPath: `测试类目 ${id.toUpperCase()}`, segments: [`测试类目 ${id.toUpperCase()}`] };
}

function result(id, keyword) {
  return { combinationId: id, categoryPath: category(id).displayPath, keyword, totalSales: '¥1万-¥2万', yesterday: '¥1000', today: '¥2000', growth: '100%', category: 'normal', page: 1, attempts: 1 };
}

function cleanTask() {
  return {
    taskId: 'business-fixture', taskName: '脱敏双类目测试', status: 'completed',
    createdAt: TIME, updatedAt: TIME, startedAt: TIME, completedAt: TIME,
    parameters: { categories: [category('a'), category('b')], minSales: 0, maxSales: null, only30dGrowth: false },
    combinations: ['a', 'b'].map((id, index) => ({
      id, index, category: category(id), status: 'completed', currentPage: 1,
      qualifyingCount: 1, resultCount: 1, failureCount: 0, coverageComplete: true,
      stats: { normal: 1, detailsOpened: 1 }, elapsedSeconds: 1, error: null,
      completion: { status: 'complete', reason: 'range-complete', message: '金额区间扫描完成', coverageComplete: true },
    })),
    current: null, results: [result('a', '测试黄芪片'), result('b', '测试黄芪膏')],
    failures: [], unparseableItems: [], stats: {}, reportFiles: null, lastError: null,
  };
}

function createTaskStateFixtures() {
  return ['clean', 'detail_failure', 'parse_failure', 'category_failure', 'stopped', 'incomplete_coverage'].map((name) => {
    const task = cleanTask();
    const target = task.combinations[1];
    let completion = { ...complete };
    let failed = 0;
    let saved = 2;
    let completedCategories = 2;
    let qualifyingCount = 2;
    if (name === 'detail_failure' || name === 'parse_failure') {
      const detail = { combinationId: 'b', categoryPath: target.category.displayPath, keyword: '脱敏失败商品', page: 1, attempts: 3, reason: name === 'detail_failure' ? '模拟详情未加载' : '模拟较上周期值无法解析' };
      task[name === 'detail_failure' ? 'failures' : 'unparseableItems'].push(detail);
      target.qualifyingCount = 2;
      target.failureCount = 1;
      target.stats.detailsOpened = 2;
      target.stats[name === 'detail_failure' ? 'unavailable' : 'unparseable'] = 1;
      failed = 1;
      qualifyingCount = 3;
    } else if (name === 'category_failure') {
      task.results = task.results.filter((item) => item.combinationId !== 'b');
      task.failures.push({ combinationId: 'b', categoryPath: target.category.displayPath, keyword: '-', page: 0, attempts: 1, stage: '类目采集', reason: '模拟子采集进程失败' });
      Object.assign(target, { status: 'failed', currentPage: 0, qualifyingCount: 0, resultCount: 0, failureCount: 1, coverageComplete: false, stats: {}, completion: null, error: '模拟子采集进程失败' });
      completion = { status: 'partial', reason: 'failed-categories', message: '1 个类目采集失败', coverageComplete: false };
      failed = 1;
      saved = 1;
      completedCategories = 1;
      qualifyingCount = 1;
    } else if (name === 'stopped' || name === 'incomplete_coverage') {
      completion = { status: 'partial', reason: name === 'stopped' ? 'user-stopped' : 'max-pages', message: name === 'stopped' ? '用户手动停止' : '达到 MAX_PAGES=1', coverageComplete: false, stoppedAtPage: 1 };
      target.coverageComplete = false;
      target.completion = { ...completion };
      if (name === 'stopped') {
        task.status = 'stopped';
        task.completedAt = null;
        target.status = 'stopped';
        completedCategories = 1;
      }
    }
    return {
      name, task, completion,
      expected: {
        nativeStats: { saved, failed, completedCategories, qualifyingCount },
        toolboxStatus: name === 'clean' ? 'completed' : name === 'stopped' ? 'cancelled' : 'completed_with_errors',
        // 目标约定，当前旧代码未提供状态归一化或异常类目选择接口。
        reprocessCombinationIds: name === 'clean' ? [] : ['b'],
        reprocessMode: name === 'stopped' ? 'resume' : name === 'clean' ? null : 'retry',
      },
    };
  });
}

module.exports = { createTaskStateFixtures };
