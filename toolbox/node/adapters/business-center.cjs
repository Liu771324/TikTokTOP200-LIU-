'use strict';

const fs = require('node:fs');
const path = require('node:path');
const browserClient = require('../browser-client.cjs');
const { createTaskState } = require('../../../商机中心/task-store.js');
const { createCollector } = require('../../../商机中心/collect_v4.js');
const { discoverCategories } = require('../../../商机中心/category_discovery.js');
const { mergeCombinationResult, recomputeTaskStats, taskReportPayload } = require('../../../商机中心/batch-runner.js');
const { generateExcelReport } = require('../../../商机中心/export_excel.js');
const { groupProducts } = require('../../../商机中心/product_grouping.js');
const { validateParameters, processingCombinations, resetCombination, toolboxStatus, invalid } = require('../../../商机中心/toolbox_task.js');

const descriptor = { toolId: 'business-center', parameterVersion: 1, requiresBrowser: true,
  supportsPause: true, supportsResume: true, supportsRetryFailed: true };
const REPORT_ID = 'business-report';

function accepts(url) {
  try { return new URL(url).hostname === 'fxg.jinritemai.com'; } catch { return false; }
}

function readState(context) {
  if (!fs.existsSync(context.statePath)) return null;
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(context.statePath, 'utf8')); }
  catch { throw invalid('任务状态损坏，无法安全恢复'); }
  if (!envelope || envelope.formatVersion !== 1 || envelope.toolId !== descriptor.toolId || envelope.taskId !== context.taskId
      || !Number.isInteger(envelope.attempt) || envelope.attempt < 1 || envelope.attempt > context.attempt
      || envelope.state?.taskId !== context.taskId
      || ['combinations', 'results', 'failures', 'unparseableItems'].some(key => !Array.isArray(envelope.state[key]))) {
    throw invalid('任务状态与当前任务不匹配');
  }
  return envelope.state;
}

function createAdapter(dependencies = {}) {
  const connect = dependencies.connect || browserClient.connect;
  const selectPage = dependencies.selectPage || browserClient.selectPage;
  const discoverCategoriesForPage = dependencies.discoverCategories || discoverCategories;
  const collectorFactory = dependencies.createCollector || createCollector;
  const writeExcel = dependencies.generateExcelReport || generateExcelReport;

  async function discover(parameters, context, api) {
    const connection = await connect(context);
    try {
      const page = await selectPage(connection.browser, context.browser?.pageId, accepts);
      await api.boundary();
      const result = await discoverCategoriesForPage({ page });
      if (!Array.isArray(result.categories) || result.categories.length > 10000) {
        throw Object.assign(new Error('商机类目返回格式无效或超过安全上限。'), { code: 'WORKER_PROTOCOL_ERROR' });
      }
      if (Buffer.byteLength(JSON.stringify(result)) <= 900 * 1024) return result;
      for (let offset = 0; offset < result.categories.length; offset += 50) {
        await api.boundary();
        api.emit('options_chunk', { field: 'categories', items: result.categories.slice(offset, offset + 50) });
      }
      return { ...result, categories: [] };
    } finally { await connection.disconnect(); }
  }

  async function run(parameters, context, api) {
    const validated = validateParameters(parameters);
    const existing = readState(context);
    const task = existing || createTaskState(validated, { taskId: context.taskId });
    if (JSON.stringify(validateParameters(task.parameters)) !== JSON.stringify(validated)) throw invalid('恢复时不能更改原任务参数');
    const selected = processingCombinations(task, context.retryFailed === true);
    task.status = 'running';
    task.startedAt ||= new Date().toISOString();
    task.completedAt = null;
    task.lastError = null;
    const checkpoint = () => {
      task.updatedAt = new Date().toISOString();
      recomputeTaskStats(task);
      api.checkpoint(task);
    };
    checkpoint();
    let connection;
    try {
      await api.boundary();
      if (selected.length) {
        connection = await connect(context);
        const page = await selectPage(connection.browser, context.browser?.pageId, accepts);
        let discovery;
        while (!discovery) {
          try { discovery = await discoverCategoriesForPage({ page }); }
          catch (error) {
            if (error.code !== 'LOGIN_REQUIRED') throw error;
            checkpoint();
            await api.waitForUser(error.message);
          }
        }
        const available = new Set(discovery.categories.map((item) => item.displayPath));
        if (selected.some((item) => !available.has(item.category.displayPath))) throw invalid('所选类目已失效，请重新读取类目后创建任务');

        for (const combination of selected) {
          await api.boundary();
          let finished = false;
          while (!finished) {
            resetCombination(task, combination);
            task.current = { combinationId: combination.id, categoryPath: combination.category.displayPath };
            checkpoint();
            try {
              const collector = collectorFactory({ categoryLabel: combination.category.displayPath,
                categorySearch: combination.category.segments.at(-1),
                minSales: validated.minSales, maxSales: validated.maxSales, only30dGrowth: validated.only30dGrowth,
                strictCategory: true, stopFile: '', pauseFile: '', maxPages: Infinity, maxItems: Infinity }, {
                boundary: () => api.boundary(), shouldStop: () => api.control.cancelled,
                onLog: (message) => { if (!api.control.cancelled) api.emit('log', { message }); },
                onSnapshot(payload, pageNumber) {
                  mergeCombinationResult(task, combination, payload);
                  combination.currentPage = pageNumber;
                  checkpoint();
                  if (!api.control.cancelled) api.emit('progress', { current: task.stats.completedCategories,
                    total: task.combinations.length, message: `${combination.category.displayPath} · 第${pageNumber}页 · ${combination.qualifyingCount}条达标` });
                },
              });
              const payload = await collector.collect(page);
              mergeCombinationResult(task, combination, payload);
              combination.status = payload.completion?.reason === 'user-stopped' ? 'stopped' : 'completed';
              finished = true;
            } catch (error) {
              if (api.control.cancelled || error.code === 'CANCELLED') {
                combination.status = 'stopped';
                throw error;
              }
              if (error.code === 'LOGIN_REQUIRED') {
                checkpoint();
                await api.waitForUser(error.message);
                continue;
              }
              combination.status = 'failed';
              combination.coverageComplete = false;
              combination.error = error.message;
              task.failures.push({ combinationId: combination.id, categoryPath: combination.category.displayPath,
                keyword: '-', page: combination.currentPage, attempts: 1, stage: '类目采集', reason: error.message });
              combination.failureCount += 1;
              finished = true;
            }
            checkpoint();
          }
          await api.boundary();
        }
      }

      const finalState = toolboxStatus(task);
      const coverageComplete = task.combinations.every((item) => item.status === 'completed' && item.coverageComplete);
      const completion = { status: coverageComplete ? 'complete' : 'partial', coverageComplete,
        reason: coverageComplete ? 'all-categories-complete' : 'failed-categories',
        message: coverageComplete ? '全部类目扫描完成' : '部分类目失败或覆盖不完整' };
      task.status = finalState === 'failed' ? 'failed' : 'completed';
      task.current = null;
      task.completedAt = new Date().toISOString();
      checkpoint();
      await api.boundary();
      const { registration } = await api.lookup(REPORT_ID);
      if (registration?.registeredAttempt === context.attempt) {
        task.reportRegistration = registration;
      } else {
        fs.mkdirSync(context.artifactStagingRoot, { recursive: true });
        const reportPath = path.join(context.artifactStagingRoot, `business-report-${context.attempt}.xlsx`);
        await writeExcel(taskReportPayload(structuredClone(task), completion), reportPath);
        await api.boundary();
        task.reportRegistration = await api.register({ candidateId: REPORT_ID, kind: 'excel', role: 'report',
          relpath: path.relative(context.dataRoot, reportPath).split(path.sep).join('/'),
          displayName: '商机中心.xlsx', metadata: { categories: task.combinations.length, coverageComplete }, replaceRole: true });
      }
      checkpoint();
      return { state: finalState };
    } catch (error) {
      if (api.control.cancelled || error.code === 'CANCELLED') {
        task.status = 'stopped';
        task.current = null;
        for (const item of task.combinations) if (item.status === 'running') item.status = 'stopped';
      } else {
        task.status = 'failed';
        task.lastError = error.message;
      }
      checkpoint();
      throw error;
    } finally { if (connection) await connection.disconnect(); }
  }

  async function read_results(parameters, context) {
    const offset = parameters.offset ?? 0;
    const limit = parameters.limit ?? 50;
    const section = parameters.section ?? 'results';
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('分页参数无效');
    if (!['results', 'failures', 'unparseableItems'].includes(section)) throw invalid('结果分区无效');
    const task = readState(context);
    if (!task) return { items: [], total: 0, offset, limit };
    const rows = section === 'results' ? groupProducts(task.results) : task[section];
    return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit,
      stats: task.stats, failures: task.failures.length, unparseable: task.unparseableItems.length };
  }

  return { descriptor, run, discover, read_results };
}

module.exports = { ...createAdapter(), createAdapter, accepts };
