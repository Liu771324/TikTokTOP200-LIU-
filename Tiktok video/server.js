'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { connectTargetPage, openVideoRanking, CDP_URL } = require('./edge');
const { discoverOptions, runTask } = require('./collector');
const { createTask, loadTask, listTasks, saveTask, appendLog, VIDEO_DIR } = require('./task-store');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN = crypto.randomBytes(24).toString('hex');
let optionsCache = null;
let active = null;
const eventClients = new Set();

for (const task of listTasks()) {
  if (task.status === 'running') {
    task.status = 'stopped';
    appendLog(task, '服务上次退出时任务仍在运行，已保留检查点；请点击续跑');
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function localHost(host) {
  try { return ['127.0.0.1', 'localhost', '::1'].includes(new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase()); }
  catch { return false; }
}

function checkRequest(request, url) {
  if (!localHost(request.headers.host || '')) throw Object.assign(new Error('只允许本机访问'), { status: 403 });
  const origin = request.headers.origin;
  if (origin && !localHost(new URL(origin).host)) throw Object.assign(new Error('禁止跨站请求'), { status: 403 });
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/session') {
    const token = request.headers['x-video-token'] || url.searchParams.get('token');
    if (token !== TOKEN) throw Object.assign(new Error('会话令牌无效，请刷新页面'), { status: 403 });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 65536) request.destroy(new Error('请求体过大')); });
    request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON 格式错误')); } });
    request.on('error', reject);
  });
}

function broadcast(type, data) {
  const value = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try { client.write(value); } catch { eventClients.delete(client); }
  }
}

function summary(task) {
  return { id: task.id, createdAt: task.createdAt, completedAt: task.completedAt, status: task.status,
    parameters: task.parameters, progress: task.progress, errorCount: task.errors.filter((item) => !item.resolvedAt).length, lastLog: task.logs.at(-1) || null,
    outputDirectory: VIDEO_DIR };
}

function startTask(task) {
  if (active) throw new Error('已有任务正在运行');
  const run = { id: task.id, paused: false, stopped: false, sentLogs: task.logs.length };
  active = run;
  const control = {
    throwIfStopped() { if (run.stopped) throw Object.assign(new Error('任务已停止'), { name: 'StopRequestedError' }); },
    async waitIfPaused() {
      if (run.paused) { task.status = 'paused'; saveTask(task); broadcast('status', summary(task)); }
      while (run.paused && !run.stopped) await new Promise((resolve) => setTimeout(resolve, 250));
      this.throwIfStopped();
      if (task.status === 'paused') { task.status = 'running'; saveTask(task); broadcast('status', summary(task)); }
    },
  };
  runTask(task, control).then((finished) => broadcast('status', summary(finished)))
    .catch((error) => { task.status = 'failed'; task.errors.push({ message: error.message }); appendLog(task, `任务失败：${error.message}`); broadcast('status', summary(task)); })
    .finally(() => { if (active === run) active = null; });
  broadcast('status', summary(task));
}

function validateParameters(body) {
  if (!optionsCache) throw new Error('请先读取页面选项');
  const category = String(body.category || '');
  const brandType = String(body.brandType || '');
  const period = String(body.period || '');
  const trendMode = String(body.trendMode || '');
  if (!optionsCache.categories.includes(category)) throw new Error('行业类目无效');
  if (!optionsCache.brandTypes.includes(brandType)) throw new Error('品牌类型无效');
  if (!optionsCache.periods.some((item) => item.label === period)) throw new Error('榜单周期无效');
  if (!['first', 'up_and_first'].includes(trendMode)) throw new Error('采集条件无效');
  return { category, brandType, period, trendMode };
}

async function routeApi(request, response, url) {
  if (url.pathname === '/api/session' && request.method === 'GET') return sendJson(response, 200, { token: TOKEN });
  if (url.pathname === '/api/edge-open' && request.method === 'POST') {
    return sendJson(response, 200, await openVideoRanking());
  }
  if (url.pathname === '/api/edge-status' && request.method === 'GET') {
    try { const { page } = await connectTargetPage(); const pageUrl = page.url(); return sendJson(response, 200, { ok: true, cdpUrl: CDP_URL, pageUrl }); }
    catch (error) { return sendJson(response, 200, { ok: false, cdpUrl: CDP_URL, message: error.message }); }
  }
  if (url.pathname === '/api/options' && request.method === 'GET') {
    optionsCache = await discoverOptions();
    return sendJson(response, 200, { ok: true, ...optionsCache });
  }
  if (url.pathname === '/api/tasks' && request.method === 'GET') return sendJson(response, 200, { tasks: listTasks().map(summary) });
  if (url.pathname === '/api/tasks' && request.method === 'POST') {
    if (active) throw new Error('已有任务正在运行');
    const task = createTask(validateParameters(await readBody(request)));
    startTask(task);
    return sendJson(response, 202, { task: summary(task) });
  }
  if (url.pathname === '/api/events' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write('retry: 1500\n\n');
    eventClients.add(response);
    request.on('close', () => eventClients.delete(response));
    return;
  }
  const match = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)(?:\/(pause|resume|stop))?$/);
  if (!match) return sendJson(response, 404, { message: '接口不存在' });
  const task = loadTask(match[1]);
  if (!task) return sendJson(response, 404, { message: '任务不存在' });
  const action = match[2];
  if (!action && request.method === 'GET') return sendJson(response, 200, { task: { ...task, outputDirectory: VIDEO_DIR } });
  if (request.method !== 'POST') return sendJson(response, 405, { message: '请求方法无效' });
  if (action === 'pause') {
    if (!active || active.id !== task.id || active.paused) throw new Error('任务未运行');
    active.paused = true;
    return sendJson(response, 202, { ok: true, message: '将在当前视频处理完成后暂停' });
  }
  if (action === 'resume') {
    if (active?.id === task.id) { active.paused = false; return sendJson(response, 202, { ok: true }); }
    if (active) throw new Error('已有任务正在运行');
    if (!['paused', 'stopped', 'failed', 'queued', 'running'].includes(task.status) &&
        !(task.status === 'completed' && Object.keys(task.checkpoint.failedVideos || {}).length)) throw new Error('该任务不能续跑');
    startTask(task);
    return sendJson(response, 202, { ok: true });
  }
  if (action === 'stop') {
    if (!active || active.id !== task.id) throw new Error('任务未运行');
    active.stopped = true;
    active.paused = false;
    return sendJson(response, 202, { ok: true, message: '将在当前视频处理完成后停止' });
  }
  return sendJson(response, 404, { message: '接口不存在' });
}

function serveStatic(response, url) {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(response, 403, { message: '禁止访问' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(response, 404, { message: '页面不存在' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    checkRequest(request, url);
    if (url.pathname.startsWith('/api/')) await routeApi(request, response, url);
    else serveStatic(response, url);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.status || 400, { message: error.message });
    else response.end();
  }
});

setInterval(() => {
  if (active) {
    const task = loadTask(active.id);
    if (task) {
      for (const entry of task.logs.slice(active.sentLogs)) broadcast('log', entry);
      active.sentLogs = task.logs.length;
      broadcast('status', summary(task));
    }
  }
  for (const client of eventClients) { try { client.write(': ping\n\n'); } catch { eventClients.delete(client); } }
}, 1000).unref();

server.listen(PORT, '127.0.0.1', () => console.log(`短视频榜采集服务：http://127.0.0.1:${PORT}；输出目录：${VIDEO_DIR}`));

module.exports = { server };
