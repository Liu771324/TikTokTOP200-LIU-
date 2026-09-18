'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');
const edge = require('./edge');
const { discoverCategories, normalizeCategory } = require('./category_discovery');
const { validateSalesBounds } = require('./collect_utils');
const taskStore = require('./task-store');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CATEGORIES_FILE = path.join(ROOT, 'categories.json');
const PAUSE_FILE = path.join(ROOT, 'pause.flag');
const LATEST_FILES = {
  md: path.join(ROOT, '选品报告-成交增长.md'),
  xlsx: path.join(ROOT, '选品报告-成交增长.xlsx'),
  'partial-md': path.join(ROOT, '选品报告-成交增长-部分.md'),
  'partial-xlsx': path.join(ROOT, '选品报告-成交增长-部分.xlsx'),
};

let activeRun = null;
let discoveryCache = null;
let logClients = [];

taskStore.recoverInterruptedTasks();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  logClients = logClients.filter((response) => {
    try { response.write(payload); return true; } catch { return false; }
  });
}

function pushLog(line) {
  broadcast('log', { line });
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('请求内容过大'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('请求 JSON 格式错误')); }
    });
    request.on('error', reject);
  });
}

function readLegacyCategories() {
  try { return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8')).categories || []; }
  catch { return []; }
}

function publicTask(task, includeDetails = true) {
  if (!task) return null;
  const value = {
    taskId: task.taskId,
    taskName: task.taskName,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    parameters: task.parameters,
    stats: task.stats,
    current: task.current,
    combinations: task.combinations,
    reportFiles: task.reportFiles,
    lastError: task.lastError,
  };
  if (includeDetails) {
    value.results = task.results;
    value.failures = task.failures;
    value.unparseableItems = task.unparseableItems;
  }
  return value;
}

async function ensureDebugEdge(confirmed = false) {
  if (confirmed && await edge.isCdpReady()) return { status: 'ready' };
  return edge.ensureEdgeDebug();
}

function clearRunFlags(stopFile) {
  try { fs.unlinkSync(PAUSE_FILE); } catch {}
  try { fs.unlinkSync(stopFile); } catch {}
}

function startTask(task, { onlyCombinationIds = null } = {}) {
  if (activeRun) throw new Error('已有任务正在运行');
  const stopFile = path.join(ROOT, `.stop-task-${Date.now()}-${process.pid}.flag`);
  clearRunFlags(stopFile);
  const child = spawn(process.execPath, ['batch-runner.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TASK_ID: task.taskId,
      CDP_URL: edge.CDP_URL,
      STOP_FILE: stopFile,
      PAUSE_FILE,
      ONLY_COMBINATION_IDS: onlyCombinationIds?.join(',') || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  activeRun = { child, taskId: task.taskId, stopFile, state: 'running', startedAt: Date.now() };
  broadcast('status', { state: 'running', task: publicTask(task, false) });
  child.stdout.on('data', (chunk) => pushLog(chunk.toString()));
  child.stderr.on('data', (chunk) => pushLog(chunk.toString()));
  child.on('exit', (code) => {
    clearRunFlags(stopFile);
    const finishedTask = taskStore.loadTask(task.taskId);
    const state = finishedTask?.status === 'stopped' ? 'stopped' : (code === 0 ? 'done' : 'failed');
    activeRun = null;
    broadcast('status', {
      state,
      ok: code === 0,
      task: publicTask(finishedTask, false),
      hasReport: Boolean(finishedTask?.reportFiles),
      partial: finishedTask?.reportFiles?.partial || false,
    });
  });
  return task;
}

function validateSubmittedCategories(categories) {
  if (!discoveryCache) throw new Error('请先点击“读取 / 刷新类目”');
  if (!Array.isArray(categories) || !categories.length) throw new Error('至少选择一个类目');
  const allowed = new Map(discoveryCache.categories.map((category) => [category.displayPath, category]));
  const selected = categories.map((item) => {
    const normalized = normalizeCategory(typeof item === 'string' ? { displayPath: item } : item);
    const category = normalized && allowed.get(normalized.displayPath);
    if (!category) throw new Error(`类目无效或发现结果已过期：${normalized?.displayPath || '-'}`);
    return category;
  });
  if (new Set(selected.map((category) => category.displayPath)).size !== selected.length) {
    throw new Error('同一任务不能重复选择相同类目');
  }
  return selected;
}

async function handleDiscover(response, confirmed = false) {
  const edgeState = await ensureDebugEdge(confirmed);
  if (edgeState.status === 'need-path') {
    sendJson(response, 200, { ok: true, needPath: true });
    return;
  }
  if (edgeState.status === 'launched') {
    sendJson(response, 200, { ok: true, needLogin: true, timeout: Boolean(edgeState.timeout) });
    return;
  }
  discoveryCache = await discoverCategories({ cdpUrl: edge.CDP_URL });
  pushLog(`已读取 ${discoveryCache.categories.length} 个可选类目`);
  sendJson(response, 200, { ok: true, ...discoveryCache });
}

async function handleCreateTask(request, response) {
  if (activeRun) throw new Error('已有任务正在运行');
  const body = await readBody(request);
  const categories = validateSubmittedCategories(body.categories);
  const bounds = validateSalesBounds(body.minSales, body.maxSales);
  if (!bounds.ok) throw new Error(bounds.message);
  const edgeState = await ensureDebugEdge(Boolean(body.confirmed));
  if (edgeState.status === 'need-path') {
    sendJson(response, 200, { ok: true, needPath: true });
    return;
  }
  if (edgeState.status === 'launched') {
    sendJson(response, 200, { ok: true, needLogin: true });
    return;
  }
  const task = taskStore.createTask({
    categories,
    minSales: bounds.minSales,
    maxSales: bounds.maxSales,
    only30dGrowth: body.only30dGrowth === true,
  });
  startTask(task);
  sendJson(response, 202, { ok: true, task: publicTask(task, false) });
}

async function handleLegacyStart(request, response) {
  if (activeRun) throw new Error('已有任务正在运行');
  const body = await readBody(request);
  if (!body.label) throw new Error('缺少类目参数');
  const bounds = validateSalesBounds(body.minSales, body.maxSales);
  if (!bounds.ok) throw new Error(bounds.message);
  const edgeState = await ensureDebugEdge(Boolean(body.confirmed));
  if (edgeState.status === 'need-path') { sendJson(response, 200, { ok: true, needPath: true }); return; }
  if (edgeState.status === 'launched') { sendJson(response, 200, { ok: true, needLogin: true }); return; }
  const category = normalizeCategory({ displayPath: body.label });
  const task = taskStore.createTask({
    categories: [category],
    minSales: bounds.minSales,
    maxSales: bounds.maxSales,
    only30dGrowth: body.only30dGrowth === true,
  });
  startTask(task);
  sendJson(response, 202, { ok: true, task: publicTask(task, false) });
}

function taskReportPath(task, type) {
  const files = task?.reportFiles;
  if (!files) return null;
  if (type === 'xlsx') return files.xlsxPath;
  if (type === 'json') return files.jsonPath;
  return files.latestPath;
}

function sendDownload(response, filePath, downloadName) {
  if (!filePath || !fs.existsSync(filePath)) {
    sendJson(response, 404, { ok: false, message: '报告文件不存在' });
    return;
  }
  const types = {
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
  };
  response.writeHead(200, {
    'Content-Type': types[path.extname(filePath)] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  });
  fs.createReadStream(filePath).pipe(response);
}

async function routeApi(request, response, url) {
  if (url.pathname === '/api/categories') {
    sendJson(response, 200, { categories: readLegacyCategories() });
    return true;
  }
  if (url.pathname === '/api/discover' && request.method === 'POST') {
    const body = await readBody(request);
    await handleDiscover(response, Boolean(body.confirmed));
    return true;
  }
  if (url.pathname === '/api/start' && request.method === 'POST') {
    await handleLegacyStart(request, response);
    return true;
  }
  if (url.pathname === '/api/tasks' && request.method === 'GET') {
    sendJson(response, 200, { tasks: taskStore.listTasks().slice(0, 30).map((task) => publicTask(task, false)) });
    return true;
  }
  if (url.pathname === '/api/tasks' && request.method === 'POST') {
    await handleCreateTask(request, response);
    return true;
  }
  if (url.pathname === '/api/status') {
    const task = activeRun ? taskStore.loadTask(activeRun.taskId) : null;
    sendJson(response, 200, {
      state: activeRun?.state || 'idle',
      active: activeRun ? { taskId: activeRun.taskId, state: activeRun.state } : null,
      task: publicTask(task, false),
      discovered: Boolean(discoveryCache),
    });
    return true;
  }
  if (url.pathname === '/api/save-edge-path' && request.method === 'POST') {
    const body = await readBody(request);
    if (!body.edgePath || !fs.existsSync(body.edgePath)) throw new Error('路径无效');
    edge.saveEdgePath(body.edgePath);
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/open') {
    const taskId = url.searchParams.get('taskId');
    const type = url.searchParams.get('type') || url.searchParams.get('file') || 'md';
    const task = taskId ? taskStore.loadTask(taskId) : null;
    const filePath = task ? taskReportPath(task, type.replace('partial-', '')) : LATEST_FILES[type];
    if (!filePath || !fs.existsSync(filePath)) throw new Error('报告还不存在，请先完成一次采集');
    exec(`start "" "${filePath}"`, { shell: true });
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/logs') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('retry: 1500\n\n');
    const task = activeRun ? taskStore.loadTask(activeRun.taskId) : null;
    response.write(`event: status\ndata: ${JSON.stringify({ state: activeRun?.state || 'idle', task: publicTask(task, false) })}\n\n`);
    logClients.push(response);
    request.on('close', () => { logClients = logClients.filter((client) => client !== response); });
    return true;
  }

  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(pause|resume|stop|retry|download))?$/);
  if (!match) return false;
  const taskId = decodeURIComponent(match[1]);
  const action = match[2];
  const task = taskStore.loadTask(taskId);
  if (!task) {
    sendJson(response, 404, { ok: false, message: '任务不存在' });
    return true;
  }
  if (!action && request.method === 'GET') {
    sendJson(response, 200, { task: publicTask(task) });
    return true;
  }
  if (action === 'pause' && request.method === 'POST') {
    if (!activeRun || activeRun.taskId !== taskId || activeRun.state === 'stopping') throw new Error('该任务当前不能暂停');
    fs.writeFileSync(PAUSE_FILE, '', 'utf8');
    activeRun.state = 'paused';
    broadcast('status', { state: 'paused', task: publicTask(task, false) });
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (action === 'resume' && request.method === 'POST') {
    if (activeRun && activeRun.taskId === taskId) {
      try { fs.unlinkSync(PAUSE_FILE); } catch {}
      activeRun.state = 'running';
      broadcast('status', { state: 'running', task: publicTask(task, false) });
    } else {
      if (activeRun) throw new Error('已有其他任务正在运行');
      taskStore.prepareTask(task, { mode: 'resume' });
      taskStore.saveTask(task);
      startTask(task);
    }
    sendJson(response, 202, { ok: true });
    return true;
  }
  if (action === 'stop' && request.method === 'POST') {
    if (!activeRun || activeRun.taskId !== taskId) throw new Error('该任务未在运行');
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
    activeRun.state = 'stopping';
    fs.writeFileSync(activeRun.stopFile, 'stop', 'utf8');
    broadcast('status', { state: 'stopping', task: publicTask(task, false) });
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (action === 'retry' && request.method === 'POST') {
    if (activeRun) throw new Error('已有任务正在运行');
    const failedIds = task.combinations.filter((item) => item.status === 'failed').map((item) => item.id);
    if (!failedIds.length) throw new Error('没有失败类目可重试');
    taskStore.prepareTask(task, { mode: 'retry' });
    taskStore.saveTask(task);
    startTask(task, { onlyCombinationIds: failedIds });
    sendJson(response, 202, { ok: true, count: failedIds.length });
    return true;
  }
  if (action === 'download' && request.method === 'GET') {
    const type = ['md', 'xlsx', 'json'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'md';
    sendDownload(response, taskReportPath(task, type), `成交增长-${task.taskId}.${type}`);
    return true;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (await routeApi(request, response, url)) return;
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, relative);
    if (filePath !== path.join(path.resolve(PUBLIC_DIR), 'index.html') && !filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) {
      sendJson(response, 403, { ok: false, message: '禁止访问' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      sendJson(response, 404, { ok: false, message: 'Not Found' });
      return;
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.code === 'LOGIN_REQUIRED' ? 409 : 400, { ok: false, needLogin: error.code === 'LOGIN_REQUIRED', message: error.message });
    else response.end();
  }
});

setInterval(() => {
  logClients = logClients.filter((client) => {
    try { client.write(': ping\n\n'); return true; } catch { return false; }
  });
}, 25000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`采集服务已启动：http://localhost:${PORT}`);
});

module.exports = { publicTask, server, validateSubmittedCategories };
