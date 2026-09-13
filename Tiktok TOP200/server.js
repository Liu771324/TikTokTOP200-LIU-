'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const edge = require('./edge');
const { discoverOptions, runTask, StopRequestedError } = require('./collector');
const { createTask, loadTask, listTasks, buildTaskName, selectVisibleTasks, REPORT_DIR } = require('./task-store');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');
let activeRun = null;
let discoveryCache = null;
let eventClients = [];

function sendJson(response, code, value) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy(new Error('请求体过大'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON 格式错误')); }
    });
    request.on('error', reject);
  });
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  eventClients = eventClients.filter((client) => {
    try { client.write(payload); return true; } catch { return false; }
  });
}

function log(line) {
  const value = String(line || '').trim();
  if (value) broadcast('log', { line: value, at: new Date().toISOString() });
}

function publicTask(task, includeDetails = true) {
  if (!task) return null;
  const value = {
    taskId: task.taskId,
    taskName: task.taskName || buildTaskName(task),
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    status: task.status,
    parameters: task.parameters,
    stats: task.stats,
    current: task.current,
    combinations: task.combinations,
    resultCount: task.results.length,
    failureCount: task.failures.length,
    reportFiles: task.reportFiles ? { json: true, xlsx: true } : null,
    lastError: task.lastError,
  };
  if (includeDetails) {
    value.results = task.results;
    value.failures = task.failures;
  }
  return value;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function isLoopbackHost(value) {
  try {
    const hostname = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function assertLocalRequest(request) {
  if (!isLoopbackHost(request.headers.host || '')) throw forbidden('只允许本机访问');
  const origin = request.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch {}
    if (!isLoopbackHost(originHost)) throw forbidden('禁止跨站请求');
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method || '')) {
    if (request.headers['x-top200-token'] !== SESSION_TOKEN) throw forbidden('会话令牌无效，请刷新页面');
  }
}

function startRunner(task, options = {}) {
  if (activeRun) throw new Error('已有任务正在运行');
  const state = { taskId: task.taskId, paused: false, stopped: false };
  activeRun = state;
  broadcast('status', { state: 'running', taskId: task.taskId });
  const control = {
    throwIfStopped() {
      if (state.stopped) throw new StopRequestedError();
    },
    async waitIfPaused() {
      while (state.paused) {
        if (state.stopped) throw new StopRequestedError();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    },
  };
  runTask(task, control, log, options)
    .then((completed) => broadcast('status', { state: 'completed', task: publicTask(completed, false) }))
    .catch((error) => broadcast('status', {
      state: error instanceof StopRequestedError ? 'stopped' : 'failed',
      taskId: task.taskId,
      message: error.message,
    }))
    .finally(() => { if (activeRun === state) activeRun = null; });
}

async function handleDiscover(response) {
  const edgeState = await edge.ensureEdgeDebug();
  if (edgeState.status === 'need-path') {
    sendJson(response, 200, { ok: true, needPath: true });
    return;
  }
  if (edgeState.status === 'launched') {
    sendJson(response, 200, { ok: true, needLogin: true, timeout: Boolean(edgeState.timeout) });
    return;
  }
  try {
    discoveryCache = await discoverOptions(log);
    sendJson(response, 200, { ok: true, ...discoveryCache });
  } catch (error) {
    sendJson(response, error.code === 'LOGIN_REQUIRED' ? 409 : 500, { ok: false, needLogin: error.code === 'LOGIN_REQUIRED', message: error.message });
  }
}

function validateTaskParameters(body) {
  if (!discoveryCache) throw new Error('请先读取类目和榜单');
  if (!Array.isArray(body.categories) || !body.categories.length) throw new Error('至少选择一个行业类目');
  if (!Array.isArray(body.rankingTypes) || !body.rankingTypes.length) throw new Error('至少选择一个榜单');
  if (!discoveryCache.brandTypes.includes(body.brandType)) throw new Error('品牌类型无效');
  const allowedCategories = new Map(discoveryCache.categories.map((item) => [item.displayPath, item]));
  const categories = body.categories.map((item) => {
    const pathValue = typeof item === 'string' ? item : item.displayPath;
    const category = allowedCategories.get(pathValue);
    if (!category) throw new Error(`类目无效：${pathValue}`);
    return category;
  });
  const allowedRankings = new Set(discoveryCache.rankingTypes.map((item) => item.name));
  for (const ranking of body.rankingTypes) if (!allowedRankings.has(ranking)) throw new Error(`榜单无效：${ranking}`);
  return { categories, brandType: body.brandType, rankingTypes: body.rankingTypes };
}

function sendFile(response, filePath, downloadName) {
  const resolved = path.resolve(filePath || '');
  if (!resolved.startsWith(`${path.resolve(REPORT_DIR)}${path.sep}`) || !fs.existsSync(resolved)) {
    sendJson(response, 404, { ok: false, message: '报告文件不存在' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': path.extname(resolved) === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  });
  fs.createReadStream(resolved).pipe(response);
}

async function routeApi(request, response, url) {
  if (url.pathname === '/api/session' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, token: SESSION_TOKEN });
    return true;
  }
  if (url.pathname === '/api/discover' && request.method === 'POST') {
    await handleDiscover(response);
    return true;
  }
  if (url.pathname === '/api/edge-path' && request.method === 'POST') {
    const body = await readBody(request);
    const saved = edge.saveEdgePath(body.edgePath);
    sendJson(response, 200, { ok: true, edgePath: saved });
    return true;
  }
  if (url.pathname === '/api/status') {
    const task = activeRun ? loadTask(activeRun.taskId) : null;
    sendJson(response, 200, {
      active: activeRun ? { taskId: activeRun.taskId, paused: activeRun.paused, stopped: activeRun.stopped } : null,
      task: publicTask(task),
      cdpReady: await edge.isCdpReady(),
      discovered: Boolean(discoveryCache),
    });
    return true;
  }
  if (url.pathname === '/api/tasks' && request.method === 'GET') {
    sendJson(response, 200, { tasks: selectVisibleTasks(listTasks(), 10).map((task) => publicTask(task, false)) });
    return true;
  }
  if (url.pathname === '/api/tasks' && request.method === 'POST') {
    if (activeRun) throw new Error('已有任务正在运行');
    const parameters = validateTaskParameters(await readBody(request));
    const task = createTask(parameters);
    startRunner(task);
    sendJson(response, 202, { ok: true, task: publicTask(task) });
    return true;
  }

  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(pause|resume|stop|retry|download))?$/);
  if (!match) return false;
  const taskId = decodeURIComponent(match[1]);
  const action = match[2];
  const task = loadTask(taskId);
  if (!task) {
    sendJson(response, 404, { ok: false, message: '任务不存在' });
    return true;
  }
  if (!action && request.method === 'GET') {
    sendJson(response, 200, { task: publicTask(task) });
    return true;
  }
  if (action === 'pause' && request.method === 'POST') {
    if (!activeRun || activeRun.taskId !== taskId) throw new Error('该任务未在运行');
    activeRun.paused = true;
    broadcast('status', { state: 'paused', taskId });
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (action === 'resume' && request.method === 'POST') {
    if (activeRun && activeRun.taskId === taskId) {
      activeRun.paused = false;
      broadcast('status', { state: 'running', taskId });
    } else {
      startRunner(task);
    }
    sendJson(response, 202, { ok: true });
    return true;
  }
  if (action === 'stop' && request.method === 'POST') {
    if (!activeRun || activeRun.taskId !== taskId) throw new Error('该任务未在运行');
    activeRun.stopped = true;
    activeRun.paused = false;
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (action === 'retry' && request.method === 'POST') {
    if (activeRun) throw new Error('已有任务正在运行');
    const failedIds = task.combinations.filter((item) => item.status === 'failed').map((item) => item.id);
    if (!failedIds.length) throw new Error('没有失败组合可重试');
    startRunner(task, { onlyCombinationIds: failedIds });
    sendJson(response, 202, { ok: true, count: failedIds.length });
    return true;
  }
  if (action === 'download' && request.method === 'GET') {
    const type = url.searchParams.get('type') === 'xlsx' ? 'xlsx' : 'json';
    const filePath = type === 'xlsx' ? task.reportFiles?.xlsxPath : task.reportFiles?.jsonPath;
    sendFile(response, filePath, `TOP200-${task.taskId}.${type}`);
    return true;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  try {
    assertLocalRequest(request);
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (await routeApi(request, response, url)) return;
    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write('retry: 1500\n\n');
      eventClients.push(response);
      request.on('close', () => { eventClients = eventClients.filter((client) => client !== response); });
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, relative);
    if (!filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`) && filePath !== path.join(path.resolve(PUBLIC_DIR), 'index.html')) {
      sendJson(response, 403, { ok: false, message: '禁止访问' });
      return;
    }
    if (!fs.existsSync(filePath)) {
      sendJson(response, 404, { ok: false, message: 'Not Found' });
      return;
    }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.statusCode || 400, { ok: false, message: error.message });
    else response.end();
  }
});

setInterval(() => {
  eventClients = eventClients.filter((client) => {
    try { client.write(': ping\n\n'); return true; } catch { return false; }
  });
}, 25000).unref();

server.listen(PORT, '127.0.0.1', () => {
  const localUrl = `http://127.0.0.1:${PORT}`;
  console.log(`TOP200 采集服务已启动：${localUrl}`);
  if (process.env.NO_OPEN !== '1' && process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', localUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});

module.exports = { server };
