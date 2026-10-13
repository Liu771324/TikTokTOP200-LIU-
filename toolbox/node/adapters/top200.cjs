'use strict';

const fs = require('node:fs');
const path = require('node:path');
const collector = require('../../../Tiktok TOP200/collector');
const { createTaskState } = require('../../../Tiktok TOP200/task-store');
const { exportTask } = require('../../../Tiktok TOP200/export-excel');
const browserClient = require('../browser-client.cjs');

const descriptor = { toolId: 'top200', parameterVersion: 1, requiresBrowser: true,
  supportsPause: true, supportsResume: true, supportsRetryFailed: true };
const REPORT_ID = 'top200-report';
const TARGET = 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank';
const fail = (code, message) => Object.assign(new Error(message), { code });
const isTarget = (url) => {
  try { const parsed = new URL(url); return parsed.origin === 'https://compass.jinritemai.com'
    && parsed.pathname === '/shop/chance/merchandise-product-rank'; } catch { return false; }
};

function validateParameters(parameters) {
  if (!parameters || Object.keys(parameters).some(key => !['categories', 'rankingTypes', 'brandType'].includes(key)))
    throw fail('INVALID_PARAMETERS', 'TOP200 参数无效。');
  const { categories, rankingTypes, brandType } = parameters;
  const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
  if (!Array.isArray(categories) || !categories.length || categories.length > 5000
      || categories.some(category => !category || !text(category.displayPath)
        || !Array.isArray(category.segments) || !category.segments.length || category.segments.length > 20
        || category.segments.some(segment => !text(segment))
        || category.segments.filter((segment, index) => !(segment === '全部' && index === category.segments.length - 1)).join(' / ') !== category.displayPath)
      || new Set(categories.map(category => category.displayPath)).size !== categories.length
      || !Array.isArray(rankingTypes) || !rankingTypes.length || rankingTypes.length > 6
      || rankingTypes.some(name => !text(name)) || new Set(rankingTypes).size !== rankingTypes.length
      || !['不限', '知名品牌', '非知名品牌'].includes(brandType))
    throw fail('INVALID_PARAMETERS', '请选择有效的类目、榜单与品牌类型。');
  // Preserve the discovered terminal “全部”; displayPath intentionally omits it.
  return { categories: categories.map(category => ({ displayPath: category.displayPath, segments: [...category.segments] })),
    rankingTypes: [...rankingTypes], brandType };
}

function loadState(context) {
  if (!fs.existsSync(context.statePath)) return null;
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(context.statePath, 'utf8')); }
  catch { throw fail('INVALID_STATE', 'TOP200 检查点无法读取。'); }
  if (envelope.formatVersion !== 1 || envelope.toolId !== 'top200' || envelope.taskId !== context.taskId
      || !Number.isInteger(envelope.attempt) || envelope.attempt > context.attempt || envelope.attempt < 1
      || envelope.state?.taskId !== context.taskId || !Array.isArray(envelope.state.combinations)
      || !envelope.state.parameters || !envelope.state.stats
      || !Array.isArray(envelope.state.results) || !Array.isArray(envelope.state.failures))
    throw fail('INVALID_STATE', 'TOP200 检查点身份或结构不一致。');
  return envelope.state;
}

function retryCombinations(task) {
  const known = new Set(task.combinations.map(combination => combination.id));
  const selected = new Set(task.combinations.filter(combination => combination.status === 'failed').map(combination => combination.id));
  for (const failure of task.failures) {
    if (!known.has(failure.combinationId)) throw fail('INVALID_STATE', '失败记录无法定位到原组合。');
    selected.add(failure.combinationId);
  }
  return [...selected];
}

function finalState(task) {
  const completed = task.combinations.filter(combination => combination.status === 'completed').length;
  if (!completed) return 'failed';
  return task.failures.length || completed !== task.combinations.length ? 'completed_with_errors' : 'completed';
}

async function checkPage(page) {
  if (page.isClosed()) throw fail('BROWSER_DISCONNECTED', 'TOP200 页面已关闭。');
  if (!isTarget(page.url())) throw fail('LOGIN_REQUIRED', '请在受管 Edge 登录抖店并打开商品 TOP200 页面，再点击继续。');
  const verification = page.locator('[id*="captcha"]:visible, [class*="captcha"]:visible, [id*="verify"]:visible');
  if (await verification.count()) throw fail('VERIFICATION_REQUIRED', '请在受管 Edge 完成人工验证，再点击继续。');
}

async function managedConnection(context, client = browserClient) {
  let connection;
  try { connection = await client.connect(context); }
  catch { throw fail('BROWSER_DISCONNECTED', '无法连接受管 Edge，请重新连接后重试。'); }
  try {
    let page;
    try { page = await client.selectPage(connection.browser, context.browser?.pageId, isTarget); }
    catch (error) {
      if (context.browser?.pageId) throw error;
      const browserContext = connection.browser.contexts()[0];
      if (!browserContext) throw fail('BROWSER_DISCONNECTED', '受管 Edge 会话不可用。');
      page = await browserContext.newPage();
      await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.bringToFront();
    await checkPage(page);
    try {
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="tablist"]'))
        .some(list => Array.from(list.querySelectorAll('[role="tab"]'))
          .filter(tab => tab.closest('[role="tablist"]') === list).length >= 6), undefined, { timeout: 15000 });
    } catch {
      await checkPage(page);
      throw fail('PAGE_NOT_READY', 'TOP200 榜单区域尚未加载完成，请稍后重试。');
    }
    return { ...connection, page, context: page.context() };
  } catch (error) {
    await connection.disconnect();
    throw error;
  }
}

function createAdapter(dependencies = {}) {
  const engine = dependencies.collector || collector;
  const connect = dependencies.connect || (context => managedConnection(context));
  const check = dependencies.checkPage || checkPage;
  const writeReport = dependencies.exportTask || exportTask;

  async function discover(parameters, context, api) {
    if (Object.keys(parameters).length) throw fail('INVALID_PARAMETERS', '读取选项不接受额外参数。');
    return engine.discoverOptions(message => api.emit('log', { level: 'info', message }), {
      connectTargetPage: async () => {
        const connection = await connect(context);
        try { await check(connection.page); return connection; }
        catch (error) { await connection.disconnect(); throw error; }
      },
    });
  }

  async function run(parameters, context, api) {
    const validated = validateParameters(parameters);
    const task = loadState(context) || createTaskState(validated, { taskId: context.taskId });
    if (JSON.stringify(validateParameters({ categories: task.parameters.categories,
      rankingTypes: task.parameters.rankingTypes, brandType: task.parameters.brandType })) !== JSON.stringify(validated))
      throw fail('INVALID_STATE', 'TOP200 参数与检查点不一致。');
    task.parameters.rankLimit = 200;
    task.parameters.periodPolicy = '实时优先，否则近1天';
    const onlyCombinationIds = context.retryFailed ? retryCombinations(task) : undefined;
    if (context.retryFailed && !onlyCombinationIds.length && task.combinations.some(item => item.status !== 'completed'))
      throw fail('INVALID_STATE', '没有可定位的异常组合，请继续任务以重采未完成组合。');
    let activePage;
    const save = () => {
      api.checkpoint(task);
      // Cancellation may checkpoint but must not emit new business events.
      if (!api.control.cancelled) api.emit('progress', { current: task.stats.completedCombinations,
        total: task.combinations.length, phase: 'collecting', message: task.current
          ? `${task.current.categoryPath} / ${task.current.rankingType} / 第${task.current.page || 1}页` : '正在保存组合进度' });
    };
    const control = {
      async waitIfPaused() {
        save();
        await api.boundary();
        if (activePage) await check(activePage);
      },
      throwIfStopped() { if (api.control.cancelled) throw new collector.StopRequestedError(); },
    };
    async function report() {
      save();
      await api.boundary();
      const previous = (await api.lookup(REPORT_ID)).registration;
      if (previous?.registeredAttempt === context.attempt) return { candidateId: REPORT_ID, artifactId: previous.artifactId, attempt: context.attempt };
      const xlsxPath = path.join(context.artifactStagingRoot, 'top200-report.xlsx');
      await writeReport(task, { xlsxPath, writeJson: false });
      await api.boundary();
      const result = await api.register({ candidateId: REPORT_ID, kind: 'excel', role: 'report', replaceRole: true,
        relpath: path.relative(context.dataRoot, xlsxPath).split(path.sep).join('/'),
        displayName: `TOP200-${task.taskId}.xlsx`, metadata: { rows: task.results.length, failures: task.failures.length } });
      return { candidateId: REPORT_ID, artifactId: result.artifactId, attempt: context.attempt };
    }
    save();
    // Login/verification interrupts the current combination. Continue restarts that combination at page one.
    let retryScope = onlyCombinationIds;
    for (;;) {
      try {
        await engine.runTask(task, control, message => api.emit('log', { level: 'info', message }), {
          saveTask: save, onlyCombinationIds: retryScope,
          connectTargetPage: async () => {
            const connection = await connect(context);
            activePage = connection.page;
            return { ...connection, disconnect: async () => { activePage = null; await connection.disconnect(); } };
          }, exportTask: report,
        });
        task.status = finalState(task);
        save();
        return { state: task.status, stats: task.stats, reportArtifactId: task.reportFiles.artifactId };
      } catch (error) {
        activePage = null;
        if (['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code)) {
          task.status = 'waiting_user';
          save();
          try { await api.waitForUser(error.message); }
          catch (waitingError) {
            task.status = waitingError.code === 'CANCELLED' ? 'stopped' : 'failed';
            save();
            throw waitingError;
          }
          // Already replaced successful retry combinations must now be skipped.
          retryScope = undefined;
          continue;
        }
        if (error.code === 'CANCELLED') { task.status = 'stopped'; save(); throw error; }
        task.status = 'failed';
        task.lastError = error.message;
        save();
        throw error;
      }
    }
  }

  async function read_results(parameters, context) {
    const { offset = 0, limit = 50, section = 'results' } = parameters;
    if (Object.keys(parameters).some(key => !['offset', 'limit', 'section'].includes(key))
        || !['results', 'failures'].includes(section)
        || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw fail('INVALID_PARAMETERS', '结果分页参数无效。');
    const task = loadState(context);
    const rows = task?.[section] || [];
    return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
  }
  return { descriptor, run, discover, read_results };
}

module.exports = { ...createAdapter(), createAdapter, validateParameters, retryCombinations, finalState, isTarget, managedConnection };
