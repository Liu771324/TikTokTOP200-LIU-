'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stopRequested } = require('./collection_control');
const { saveReports } = require('./report_output');
const { groupProducts } = require('./product_grouping');
const taskStore = require('./task-store');

function removeCombinationData(task, combinationId) {
  task.results = task.results.filter((item) => item.combinationId !== combinationId);
  task.failures = task.failures.filter((item) => item.combinationId !== combinationId);
  task.unparseableItems = task.unparseableItems.filter((item) => item.combinationId !== combinationId);
}

function mergeCombinationResult(task, combination, payload) {
  removeCombinationData(task, combination.id);
  const categoryPath = combination.category.displayPath;
  const tag = (item) => ({ ...item, categoryPath, combinationId: combination.id });
  task.results.push(...(payload.results || []).map(tag));
  task.failures.push(...(payload.failures || []).map(tag));
  task.unparseableItems.push(...(payload.unparseableItems || []).map(tag));
  combination.qualifyingCount = payload.qualifyingCount || 0;
  combination.resultCount = payload.results?.length || 0;
  combination.failureCount = (payload.failures?.length || 0) + (payload.unparseableItems?.length || 0);
  combination.coverageComplete = Boolean(payload.completion?.coverageComplete);
  combination.stats = payload.stats || {};
  combination.elapsedSeconds = payload.elapsedSeconds || 0;
  combination.completion = payload.completion || null;
}

function recomputeTaskStats(task) {
  const completed = task.combinations.filter((item) => item.status === 'completed');
  const stats = {
    totalCategories: task.combinations.length,
    completedCategories: completed.length,
    qualifyingCount: 0,
    saved: task.results.length,
    failed: task.failures.length + task.unparseableItems.length,
    normal: 0,
    fast: 0,
    down: 0,
    flat: 0,
    unparseable: 0,
    unavailable: 0,
    retrySuccess: 0,
    prefilterPassed: 0,
    prefilterSkipped: 0,
    detailsOpened: 0,
  };
  for (const combination of task.combinations) {
    stats.qualifyingCount += combination.qualifyingCount || 0;
    for (const key of ['normal', 'fast', 'down', 'flat', 'unparseable', 'unavailable', 'retrySuccess', 'prefilterPassed', 'prefilterSkipped', 'detailsOpened']) {
      stats[key] += combination.stats?.[key] || 0;
    }
  }
  task.stats = stats;
  return stats;
}

function taskReportPayload(task, completion) {
  task.results = groupProducts(task.results);
  const stats = recomputeTaskStats(task);
  return {
    taskId: task.taskId,
    taskName: task.taskName,
    categoryLabel: task.parameters.categories.length === 1 ? task.parameters.categories[0].displayPath : '多类目合并任务',
    categoryLabels: task.parameters.categories.map((category) => category.displayPath),
    completedCategories: stats.completedCategories,
    totalCategories: stats.totalCategories,
    minSales: task.parameters.minSales,
    maxSales: task.parameters.maxSales,
    only30dGrowth: task.parameters.only30dGrowth === true,
    results: task.results,
    qualifyingCount: stats.qualifyingCount,
    elapsedSeconds: Math.round((Date.now() - new Date(task.startedAt || task.createdAt).getTime()) / 1000),
    failures: task.failures,
    unparseableItems: task.unparseableItems,
    stats,
    combinations: task.combinations,
    outputTime: new Date(),
    completion,
  };
}

function buildCollectorEnv(task, combination, resultFile, stopFile, pauseFile) {
  const category = combination.category;
  return {
    ...process.env,
    CATEGORY_SEARCH: category.segments.at(-1),
    CATEGORY_LABEL: category.displayPath,
    CATEGORY_PATH: category.displayPath,
    MIN_SALES: String(task.parameters.minSales),
    MAX_SALES: task.parameters.maxSales == null ? '' : String(task.parameters.maxSales),
    ONLY_30D_GROWTH: task.parameters.only30dGrowth === true ? '1' : '0',
    CDP_URL: process.env.CDP_URL,
    STOP_FILE: stopFile,
    PAUSE_FILE: pauseFile,
    RESULT_FILE: resultFile,
    SKIP_REPORT: '1',
  };
}

function runCollector(task, combination, resultFile, stopFile, pauseFile) {
  return new Promise((resolve) => {
    const env = buildCollectorEnv(task, combination, resultFile, stopFile, pauseFile);
    const child = spawn(process.execPath, ['collect_v4.js'], {
      cwd: __dirname,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    let errorOutput = '';
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      errorOutput = `${errorOutput}${text}`.slice(-4000);
      process.stderr.write(chunk);
    });
    child.on('exit', (code) => resolve({ code, errorOutput: errorOutput.trim() }));
  });
}

async function runTask(taskId) {
  const task = taskStore.loadTask(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  const stopFile = process.env.STOP_FILE;
  const pauseFile = process.env.PAUSE_FILE;
  const onlyIds = process.env.ONLY_COMBINATION_IDS
    ? new Set(process.env.ONLY_COMBINATION_IDS.split(',').filter(Boolean))
    : null;
  task.status = 'running';
  task.startedAt ||= new Date().toISOString();
  task.completedAt = null;
  taskStore.saveTask(task);

  for (let index = 0; index < task.combinations.length; index += 1) {
    const combination = task.combinations[index];
    if (combination.status === 'completed' || (onlyIds && !onlyIds.has(combination.id))) continue;
    if (stopRequested(stopFile)) {
      task.status = 'stopped';
      break;
    }
    removeCombinationData(task, combination.id);
    combination.status = 'running';
    combination.error = null;
    task.current = {
      combinationId: combination.id,
      categoryIndex: index + 1,
      categoryTotal: task.combinations.length,
      categoryPath: combination.category.displayPath,
    };
    taskStore.saveTask(task);
    console.log(`开始类目 ${index + 1}/${task.combinations.length}：${combination.category.displayPath}`);

    const resultFile = path.join(taskStore.CHECKPOINT_DIR, `${task.taskId}-${combination.id}-result.json`);
    try { fs.unlinkSync(resultFile); } catch {}
    const outcome = await runCollector(task, combination, resultFile, stopFile, pauseFile);
    if (outcome.code !== 0 || !fs.existsSync(resultFile)) {
      combination.status = 'failed';
      combination.error = outcome.errorOutput.split('\n').at(-1) || `采集进程退出码 ${outcome.code}`;
      task.failures.push({
        combinationId: combination.id,
        categoryPath: combination.category.displayPath,
        keyword: '-',
        page: combination.currentPage || 0,
        attempts: 1,
        stage: '类目采集',
        reason: combination.error,
      });
      console.error(`类目失败，继续下一项：${combination.error}`);
    } else {
      const payload = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      mergeCombinationResult(task, combination, payload);
      if (payload.completion?.status === 'partial' && payload.completion?.reason === 'user-stopped') {
        combination.status = 'stopped';
        task.status = 'stopped';
      } else {
        combination.status = 'completed';
        combination.completedAt = new Date().toISOString();
      }
    }
    try { fs.unlinkSync(resultFile); } catch {}
    task.current = null;
    recomputeTaskStats(task);
    taskStore.saveTask(task);
    if (task.status === 'stopped') break;
  }

  const failedCategories = task.combinations.filter((item) => item.status === 'failed').length;
  const stopped = task.status === 'stopped' || stopRequested(stopFile);
  const allCompleted = task.combinations.every((item) => item.status === 'completed');
  const completion = allCompleted
    ? { status: 'complete', reason: 'all-categories-complete', message: '全部类目扫描完成', coverageComplete: true }
    : {
      status: 'partial',
      reason: stopped ? 'user-stopped' : 'failed-categories',
      message: stopped ? '用户手动停止' : `${failedCategories} 个类目采集失败`,
      coverageComplete: false,
    };
  task.status = allCompleted ? 'completed' : (stopped ? 'stopped' : 'completed');
  task.completedAt = allCompleted || !stopped ? new Date().toISOString() : null;
  task.current = null;
  const reportPayload = taskReportPayload(task, completion);
  task.reportFiles = await saveReports(reportPayload);
  taskStore.saveTask(task);
  console.log(`${allCompleted ? '任务完成' : '任务已生成部分报告'}：${task.stats.completedCategories}/${task.stats.totalCategories} 个类目，${task.results.length} 条增长`);
  return task;
}

if (require.main === module) {
  runTask(process.env.TASK_ID).catch((error) => {
    console.error(`批量任务失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildCollectorEnv, mergeCombinationResult, recomputeTaskStats, removeCombinationData, runTask, taskReportPayload };
