'use strict';
const path = require('node:path');
const { createApi } = require('./sdk.cjs');
const MAX_BYTES = 1024 * 1024;
const adapterPaths = {
  top200: './adapters/top200.cjs',
  'video-ranking': './adapters/video-ranking.cjs',
  'manual-video': './adapters/manual-video.cjs',
};
const testMode = process.argv.includes('--test-adapter');
const write = message => {
  const line = JSON.stringify({ protocolVersion: 1, ...message });
  if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('协议消息超过大小限制。');
  process.stdout.write(line + '\n');
};
// Legacy diagnostic output must never be mistaken for protocol messages.
console.log = (...args) => console.error(...args);
let active = null;
let buffer = Buffer.alloc(0);
let closing = false;
const pendingArtifacts = new Map();

function errorData(error) {
  return { code: typeof error?.code === 'string' ? error.code : 'WORKER_EXITED',
    message: String(error?.message || error || '工作者执行失败。').slice(0, 4000), retryable: false };
}

function rejectPending(error) {
  for (const pending of pendingArtifacts.values()) pending.reject(error);
  pendingArtifacts.clear();
}

function stop() {
  closing = true;
  if (active) active.api.control.cancelled = true;
  rejectPending(Object.assign(new Error('操作已停止。'), { code: 'CANCELLED' }));
  if (!active) process.stdin.destroy();
}

function handle(message) {
  if (!message || message.protocolVersion !== 1 || typeof message.requestId !== 'string' || typeof message.type !== 'string') {
    throw new Error('协议消息格式无效。');
  }
  const reply = (type, data) => write({ type, requestId: message.requestId, data });
  if (['pause', 'resume', 'cancel'].includes(message.type)) {
    if (!active || active.context.taskId !== message.taskId || active.context.attempt !== message.attempt) {
      reply('error', { code: 'UNSUPPORTED_OPERATION', message: '执行身份已改变。', retryable: false });
      return;
    }
    if (message.type === 'cancel') {
      active.api.control.cancelled = true;
      rejectPending(Object.assign(new Error('操作已停止。'), { code: 'CANCELLED' }));
    } else {
      active.api.control.pauseRequested = message.type === 'pause';
      if (message.type === 'resume') active.api.control.waitingUser = false;
    }
    reply('ack', { command: message.type });
    return;
  }
  if (message.type === 'artifact_result') {
    const pending = pendingArtifacts.get(message.data?.candidateId);
    if (active && active.context.taskId === message.taskId && active.context.attempt === message.attempt && pending) {
      pendingArtifacts.delete(message.data.candidateId);
      if (message.data.error) pending.reject(Object.assign(new Error(message.data.error.message), message.data.error));
      else pending.resolve(message.data);
    }
    return;
  }
  if (message.type === 'shutdown') { reply('ack', { command: 'shutdown' }); stop(); return; }
  if (closing || active) { reply('error', { code: 'BROWSER_BUSY', message: '工作者正在执行其他操作。', retryable: true }); return; }
  if (!['run', 'discover', 'capture_page', 'resolve_items', 'download_item', 'read_results'].includes(message.type)) {
    reply('error', { code: 'UNSUPPORTED_OPERATION', message: '不支持该命令。', retryable: false }); return;
  }
  const context = message.context;
  const isTask = ['run', 'download_item', 'read_results'].includes(message.type);
  if (!context || context.protocolVersion !== 1 || !(Object.hasOwn(adapterPaths, context.toolId) || (testMode && context.toolId === 'business-center'))
      || (isTask && (!/^[a-f0-9]{32}$/.test(context.taskId) || !Number.isInteger(context.attempt) || context.attempt < 1))
      || (!isTask && typeof context.operationId !== 'string')
      || (message.parameters !== undefined && (message.parameters === null || Array.isArray(message.parameters) || typeof message.parameters !== 'object'))) {
    reply('error', { code: 'INVALID_PARAMETERS', message: '执行上下文无效。', retryable: false }); return;
  }
  let adapter;
  try {
    adapter = require(testMode ? path.join(__dirname, '../tests/fixture-adapter.cjs') : adapterPaths[context.toolId]);
    if (typeof adapter[message.type] !== 'function') throw Object.assign(new Error('此工具尚未实现该操作。'), { code: 'UNSUPPORTED_OPERATION' });
  } catch (error) {
    reply('error', errorData(error.code === 'MODULE_NOT_FOUND' ? Object.assign(new Error('此工具尚未接入。'), { code: 'UNSUPPORTED_OPERATION' }) : error));
    return;
  }
  const send = (type, data) => write({ type, requestId: message.requestId,
    ...(context.taskId ? { taskId: context.taskId, attempt: context.attempt } : { operationId: context.operationId }), data });
  const api = createApi(context, send, pendingArtifacts, message.type);
  active = { context, api };
  reply('ack', { command: message.type });
  Promise.resolve().then(() => adapter[message.type](message.parameters || {}, context, api))
    .then(result => send('result', result || {}))
    .catch(error => send('error', errorData(error)))
    .finally(() => { api.close(); rejectPending(new Error('操作已结束。')); active = null; if (closing) process.stdin.destroy(); })
    .catch(() => { stop(); process.exitCode = 1; });
}

process.stdin.on('data', chunk => {
  if (closing) return;
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf(10);
    if (end < 0) break;
    const line = buffer.subarray(0, end);
    buffer = buffer.subarray(end + 1);
    try {
      if (line.length > MAX_BYTES) throw new Error('协议消息超过大小限制。');
      handle(JSON.parse(line.toString('utf8')));
    } catch (error) {
      write({ type: 'error', requestId: null, data: { ...errorData(error), code: 'WORKER_PROTOCOL_ERROR' } });
      stop();
      buffer = Buffer.alloc(0);
      return;
    }
  }
  if (buffer.length > MAX_BYTES) {
    write({ type: 'error', requestId: null, data: { code: 'WORKER_PROTOCOL_ERROR', message: '协议消息超过大小限制。' } });
    stop(); buffer = Buffer.alloc(0);
  }
});
process.stdin.on('end', () => {
  if (buffer.length) write({ type: 'error', requestId: null, data: { code: 'WORKER_PROTOCOL_ERROR', message: '协议消息未完整结束。' } });
  stop();
});
process.stdin.on('close', () => { clearInterval(heartbeat); });
const heartbeat = setInterval(() => write({ type: 'heartbeat', requestId: null, data: {} }), 5000);
heartbeat.unref();
write({ type: 'ready', requestId: null, data: { pid: process.pid, protocolVersion: 1 } });
