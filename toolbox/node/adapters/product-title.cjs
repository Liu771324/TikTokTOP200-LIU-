'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readWorkbook } = require('../../engines/product-title/workbook.cjs');
const { ShopBrowser } = require('../../engines/product-title/browser.cjs');
const { newTask, runTask } = require('../../engines/product-title/task.cjs');
const { failureWorkbook } = require('../../engines/product-title/report.cjs');
const browserClient = require('../browser-client.cjs');

const ENGINE = 'product-title-v1';
const descriptor = { toolId: 'product-title', parameterVersion: 1, requiresBrowser: true,
  supportsPause: false, supportsResume: false, supportsRetryFailed: false };
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const signalFor = api => ({ get aborted() { return api.control.cancelled; } });
const id = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function internalPath(root, filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw fail('INVALID_PARAMETERS', '内部文件路径无效');
  const resolvedRoot = fs.realpathSync(root), resolved = fs.realpathSync(filename);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('INVALID_PARAMETERS', '文件不在工具箱内部目录');
  return resolved;
}

function validateScope(shops, productStatus) {
  if (!Array.isArray(shops) || !shops.length || shops.length > 500 || new Set(shops.map(shop => shop?.id)).size !== shops.length
      || shops.some(shop => !shop || !id(shop.id) || typeof shop.name !== 'string' || !shop.name.trim() || shop.name.length > 200)
      || !productStatus || typeof productStatus.value !== 'string' || productStatus.value.length > 100
      || typeof productStatus.label !== 'string' || productStatus.label.length > 200)
    throw fail('INVALID_PARAMETERS', '请选择有效店铺和商品状态');
}

async function inputData(parameters, context) {
  if (!hash(parameters.inputSha256)) throw fail('INVALID_PARAMETERS', '表格摘要无效');
  const file = internalPath(path.join(context.dataRoot, 'scratch'), parameters.inputPath);
  if (!/^title-import-[a-f0-9]{32}$/.test(path.basename(path.dirname(file))) || !/\.xlsx?$/i.test(file))
    throw fail('INVALID_PARAMETERS', '表格快照位置无效');
  if (fs.statSync(file).size > 25 * 1024 * 1024) throw fail('INVALID_PARAMETERS', '标题表格不能超过 25 MiB');
  const input = await readWorkbook(file);
  if (input.inputSha256 !== parameters.inputSha256) throw fail('INVALID_STATE', '表格快照已变化，请重新选择');
  if (!input.titleCount) throw fail('INVALID_PARAMETERS', '表格没有可执行的新标题');
  return input;
}

function validatePlan(plan) {
  if (!plan || plan.engine !== ENGINE || !hash(plan.inputSha256) || typeof plan.fileName !== 'string'
      || !Array.isArray(plan.groups) || !plan.groups.length || plan.groups.length > 100
      || !Array.isArray(plan.items) || plan.items.length > 10000 || !plan.summary)
    throw fail('INVALID_STATE', '商品标题计划结构无效');
  validateScope(plan.shops, plan.productStatus);
  const originals = new Set();
  for (const group of plan.groups) {
    if (typeof group.original !== 'string' || !group.original.trim() || group.original.length > 4000 || originals.has(group.original)
        || !Number.isInteger(group.titleCount) || group.titleCount < 0 || group.titleCount > 10000)
      throw fail('INVALID_STATE', '计划原标题分组无效');
    originals.add(group.original);
  }
  const keys = new Set();
  for (const item of plan.items) {
    const key = `${item?.shopId}:${item?.id}`;
    if (!item || !id(item.id) || !id(item.shopId) || keys.has(key) || !plan.shops.some(shop => shop.id === item.shopId)
        || !originals.has(item.original) || typeof item.before !== 'string' || item.before.length > 4000
        || typeof item.target !== 'string' || item.target.length > 4000 || typeof item.shopName !== 'string'
        || !Number.isInteger(item.order) || item.order < 1
        || (item.target ? !Number.isInteger(item.excelRow) || item.excelRow < 2 || !['pending', 'unchanged'].includes(item.status)
          : item.excelRow !== null || item.status !== 'unmodified'))
      throw fail('INVALID_STATE', '计划商品身份、标题或分配无效');
    keys.add(key);
  }
  return plan;
}

async function managedConnection(context) {
  const connection = await browserClient.connect(context);
  try {
    if (!connection.browser.contexts()[0]) throw fail('BROWSER_DISCONNECTED', '受管 Edge 不可用');
    connection.browser.contexts()[0].setDefaultTimeout(5000);
    return { ...connection, adapter: new ShopBrowser(connection.browser) };
  } catch (error) { await connection.disconnect(); throw error; }
}

function createAdapter(dependencies = {}) {
  const connect = dependencies.connect || managedConnection;

  async function title_input(parameters, context) {
    if (Object.keys(parameters).some(key => !['inputPath', 'inputSha256'].includes(key))) throw fail('INVALID_PARAMETERS', '表格读取参数无效');
    const input = await inputData(parameters, context);
    let remaining = 100, previewBytes = 0;
    const groups = [];
    for (const group of input.groups) {
      if (!remaining) break;
      if (previewBytes + Buffer.byteLength(JSON.stringify({ original: group.original, titles: [], rows: [] })) > 500 * 1024) break;
      let length = Math.min(group.titles.length, remaining);
      while (length && previewBytes + Buffer.byteLength(JSON.stringify({ original: group.original, titles: group.titles.slice(0, length) })) > 500 * 1024) length--;
      if (!length && group.titles.length) break;
      groups.push({ original: group.original, titles: group.titles.slice(0, length), rows: group.rows.slice(0, length) });
      previewBytes += Buffer.byteLength(JSON.stringify(groups[groups.length - 1]));
      remaining -= length;
    }
    return { fileName: input.fileName, groupCount: input.groups.length, titleCount: input.titleCount,
      skippedCount: input.skipped.length, groups, skipped: input.skipped.slice(0, 20), previewTruncated: input.titleCount > 100 - remaining };
  }

  async function ready(connection) {
    const result = await connection.adapter.prepare();
    if (result.status !== 'ready') throw fail('LOGIN_REQUIRED', result.message);
    return result;
  }

  async function discover(parameters, context) {
    if (Object.keys(parameters).length) throw fail('INVALID_PARAMETERS', '读取选项不接受额外参数');
    const connection = await connect(context);
    try { const result = await ready(connection); return { shops: result.shops, productStatuses: result.productStatuses }; }
    finally { await connection.disconnect(); }
  }

  async function title_plan(parameters, context, api) {
    if (Object.keys(parameters).some(key => !['inputPath', 'inputSha256', 'shops', 'productStatus'].includes(key)))
      throw fail('INVALID_PARAMETERS', '商品预览参数无效');
    validateScope(parameters.shops, parameters.productStatus);
    const input = await inputData(parameters, context), connection = await connect(context), signal = signalFor(api);
    try {
      const options = await ready(connection);
      const shops = parameters.shops.map(shop => options.shops.find(known => known.id === shop.id));
      const productStatus = options.productStatuses.find(status => status.value === parameters.productStatus.value);
      if (shops.some(shop => !shop) || !productStatus) throw fail('INVALID_PARAMETERS', '店铺或商品状态已变化，请重新读取');
      const plan = { engine: ENGINE, fileName: input.fileName, inputSha256: input.inputSha256,
        shops, productStatus, groups: [], items: [], summary: null };
      const known = new Set();
      for (const group of input.groups) {
        if (signal.aborted) throw fail('CANCELLED', '预览已停止');
        const products = group.titles.length ? await connection.adapter.query(group.original, shops, signal, productStatus.value) : [];
        if (plan.items.length + products.length > 10000) throw fail('INVALID_PARAMETERS', '最多支持 10000 件匹配商品，请缩小范围');
        plan.groups.push({ original: group.original, titleCount: group.titles.length, productCount: products.length,
          unused: Math.max(0, group.titles.length - products.length) });
        products.forEach((product, index) => {
          const key = `${product.shopId}:${product.id}`;
          if (known.has(key)) throw fail('INVALID_PARAMETERS', '不同原标题组命中同一商品，请调整查询词后重新预览');
          known.add(key);
          const target = group.titles[index] || '';
          plan.items.push({ ...product, original: group.original, before: product.title, target,
            excelRow: target ? group.rows[index] : null, order: index + 1,
            status: target ? target === product.title ? 'unchanged' : 'pending' : 'unmodified' });
        });
      }
      plan.summary = { fileName: input.fileName, groupCount: plan.groups.length, titleCount: input.titleCount,
        productCount: plan.items.length, changeCount: plan.items.filter(item => item.status === 'pending').length,
        unchangedCount: plan.items.filter(item => item.status === 'unchanged').length,
        unmodifiedCount: plan.items.filter(item => !item.target).length,
        unusedCount: plan.groups.reduce((total, group) => total + group.unused, 0), shops, productStatus };
      validatePlan(plan);
      const data = JSON.stringify(plan);
      if (Buffer.byteLength(data) > 20 * 1024 * 1024) throw fail('INVALID_PARAMETERS', '商品预览超过 20 MiB，请缩小范围');
      const planPath = path.join(context.scratchRoot, 'plan.json');
      await fsp.mkdir(context.scratchRoot, { recursive: true }); await fsp.writeFile(planPath, data, { flag: 'wx' });
      return { planPath, summary: plan.summary };
    } finally { await connection.disconnect(); }
  }

  async function run(parameters, context, api) {
    if (Object.keys(parameters).some(key => !['planId', 'planSha256'].includes(key))
        || typeof parameters.planId !== 'string' || !/^[a-f0-9]{32}$/.test(parameters.planId) || !hash(parameters.planSha256))
      throw fail('INVALID_PARAMETERS', '商品标题任务参数无效');
    if (fs.existsSync(context.statePath)) throw fail('INVALID_STATE', '商品标题任务禁止重复执行，请核对后重新预览');
    const filename = internalPath(path.join(context.dataRoot, 'scratch'), path.join(context.dataRoot, 'scratch', `title-plan-${parameters.planId}`, 'plan.json'));
    if (fs.statSync(filename).size > 20 * 1024 * 1024) throw fail('INVALID_STATE', '商品标题计划过大');
    const data = await fsp.readFile(filename);
    if (digest(data) !== parameters.planSha256) throw fail('INVALID_STATE', '商品标题计划已变化，请重新预览');
    const plan = validatePlan(JSON.parse(data.toString('utf8'))), task = newTask(plan), signal = signalFor(api);
    const checkpoint = () => {
      api.checkpoint({ engine: ENGINE, plan, task });
      if (!api.control.cancelled) api.emit('progress', { current: task.saved + task.failed + task.unchanged,
        total: plan.items.filter(item => item.target).length, phase: 'saving', message: task.message });
    };
    checkpoint();
    let connection;
    try {
      if (signal.aborted) throw fail('CANCELLED', '任务已停止');
      connection = await connect(context); await ready(connection);
      await runTask(task, plan, connection.adapter, signal, checkpoint);
    } catch (error) {
      task.status = signal.aborted ? 'cancelled' : 'failed'; task.message = error.message;
      task.finishedAt = new Date().toISOString(); checkpoint();
    } finally { if (connection) await connection.disconnect(); }
    try {
      await fsp.mkdir(context.artifactStagingRoot, { recursive: true });
      for (const report of [{ name: 'product-title-result.json', kind: 'text', data: JSON.stringify({ engine: ENGINE, plan, task }, null, 2) },
        { name: 'product-title-failures.xlsx', kind: 'excel', data: await failureWorkbook(task) }]) {
        const filename = path.join(context.artifactStagingRoot, report.name); await fsp.writeFile(filename, report.data);
        await api.registerReport({ candidateId: report.name, kind: report.kind, role: 'report',
          relpath: path.relative(context.dataRoot, filename).split(path.sep).join('/'), displayName: report.name,
          metadata: { rows: task.items.length, failures: task.failed } });
      }
    } catch (error) {
      task.reportError = `报告未完成，可在任务详情查看已保存结果：${error.message}`;
      task.message += `；${task.reportError}`;
      if (task.status === 'completed') task.status = 'completed_with_errors';
      checkpoint();
    }
    return { state: task.status, stats: { saved: task.saved, failed: task.failed, unchanged: task.unchanged }, message: task.message,
      ...((task.status === 'failed' || task.reportError) ? { error: { code: task.reportError ? 'REPORT_INCOMPLETE' : 'TITLE_EXECUTION_FAILED', message: task.message, retryable: false } } : {}) };
  }

  async function read_results(parameters, context) {
    const { offset = 0, limit = 50 } = parameters;
    if (Object.keys(parameters).some(key => !['offset', 'limit'].includes(key)) || !Number.isInteger(offset) || offset < 0
        || !Number.isInteger(limit) || limit < 1 || limit > 200) throw fail('INVALID_PARAMETERS', '结果分页参数无效');
    if (!fs.existsSync(context.statePath)) return { items: [], total: 0, offset, limit };
    const envelope = JSON.parse(await fsp.readFile(context.statePath, 'utf8'));
    if (envelope.formatVersion !== 1 || envelope.toolId !== 'product-title' || envelope.taskId !== context.taskId
        || !Number.isInteger(envelope.attempt) || envelope.attempt < 1 || envelope.attempt > context.attempt
        || envelope.state?.engine !== ENGINE || !Array.isArray(envelope.state.task?.items)) throw fail('INVALID_STATE', '商品标题检查点无效');
    const rows = envelope.state.task.items;
    return { items: rows.slice(offset, offset + limit).map(item => ({ productId: item.id, shopName: item.shopName,
      before: item.before, target: item.target, excelRow: item.excelRow,
      status: item.status === 'saving' ? 'uncertain' : item.status,
      reason: item.status === 'saving' ? '上次保存被中断，结果待人工核对' : item.reason, attempts: item.attempts })), total: rows.length, offset, limit };
  }

  return { descriptor, title_input, title_plan, discover, run, read_results };
}

module.exports = { ...createAdapter(), createAdapter, validatePlan, validateScope, internalPath };
