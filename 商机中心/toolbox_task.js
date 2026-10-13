'use strict';

const { normalizeCategory } = require('./category_discovery');
const { validateSalesBounds } = require('./collect_utils');
const { removeCombinationData } = require('./batch-runner');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_PARAMETERS' });
}

function validateParameters(parameters) {
  const bounds = validateSalesBounds(parameters.minSales, parameters.maxSales);
  if (!bounds.ok) throw invalid(bounds.message);
  if (!Array.isArray(parameters.categories) || !parameters.categories.length || parameters.categories.length > 10000) {
    throw invalid('请至少选择一个有效类目');
  }
  const categories = parameters.categories.map((item) => normalizeCategory(typeof item === 'string' ? { displayPath: item } : item));
  if (categories.some((item) => !item)) throw invalid('类目格式无效');
  if (new Set(categories.map((item) => item.displayPath)).size !== categories.length) throw invalid('不能重复选择类目');
  if (parameters.only30dGrowth != null && typeof parameters.only30dGrowth !== 'boolean') throw invalid('近30天增长筛选必须是布尔值');
  return { categories, minSales: bounds.minSales, maxSales: bounds.maxSales, only30dGrowth: parameters.only30dGrowth === true };
}

function failureCombinationIds(task) {
  const ids = new Set();
  for (const failure of [...task.failures, ...task.unparseableItems]) {
    const matches = task.combinations.filter((item) => failure.combinationId
      ? item.id === failure.combinationId : item.category.displayPath === failure.categoryPath);
    if (matches.length !== 1) throw invalid('失败明细无法定位到唯一类目，不能重试其他类目代替');
    ids.add(matches[0].id);
  }
  return ids;
}

function processingCombinations(task, retryFailed = false) {
  const failures = retryFailed ? failureCombinationIds(task) : new Set();
  return task.combinations.filter((item) => retryFailed
    ? item.status === 'failed' || failures.has(item.id) || (item.status === 'completed' && !item.coverageComplete)
    : item.status !== 'completed' || !item.coverageComplete);
}

function resetCombination(task, combination) {
  removeCombinationData(task, combination.id);
  Object.assign(combination, { status: 'running', currentPage: 0, qualifyingCount: 0,
    resultCount: 0, failureCount: 0, coverageComplete: false, error: null,
    stats: {}, elapsedSeconds: 0, completion: null });
}

function toolboxStatus(task) {
  if (task.status === 'stopped') return 'cancelled';
  if (task.combinations.every((item) => item.status === 'failed')) return 'failed';
  const abnormal = task.failures.length || task.unparseableItems.length
    || task.combinations.some((item) => item.status !== 'completed' || !item.coverageComplete);
  return abnormal ? 'completed_with_errors' : 'completed';
}

module.exports = { validateParameters, failureCombinationIds, processingCombinations, resetCombination, toolboxStatus, invalid };
