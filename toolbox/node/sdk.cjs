'use strict';
const fs = require('node:fs');
const path = require('node:path');

class Cancelled extends Error {
  constructor() { super('操作已停止。'); this.code = 'CANCELLED'; }
}

function atomicState(context, state) {
  const envelope = { formatVersion: 1, toolId: context.toolId, taskId: context.taskId,
    attempt: context.attempt, savedAt: new Date().toISOString(), state };
  const temporary = `${context.statePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(context.statePath), { recursive: true });
    const fd = fs.openSync(temporary, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(envelope), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, context.statePath);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function createApi(context, send, pendingArtifacts, command = 'run') {
  const control = { cancelled: false, pauseRequested: false, waitingUser: false };
  let closed = false;
  const assertOpen = () => { if (closed || control.cancelled) throw new Cancelled(); };
  const api = {
    control,
    close() { closed = true; },
    emit(type, data) { assertOpen(); send(type, data); },
    checkpoint(state) {
      // A cancelled operation may still save its last safe boundary before exiting.
      if (closed || command !== 'run') throw Object.assign(new Error('当前操作不允许写任务状态。'), { code: 'UNSUPPORTED_OPERATION' });
      atomicState(context, state);
      send('checkpoint', { savedAt: new Date().toISOString() });
    },
    async boundary() {
      assertOpen();
      if (control.pauseRequested) {
        send('state', { state: 'paused' });
        while (control.pauseRequested && !control.cancelled) await new Promise(resolve => setTimeout(resolve, 50));
        if (control.cancelled) throw new Cancelled();
        send('state', { state: 'running' });
      }
    },
    async waitForUser(message) {
      assertOpen();
      if (!['run', 'download_item'].includes(command)) throw Object.assign(new Error('短操作不能等待人工继续，请完成登录后重新读取。'), { code: 'UNSUPPORTED_OPERATION' });
      await api.boundary();
      control.waitingUser = true;
      send('state', { state: 'waiting_user', message });
      while (control.waitingUser && !control.cancelled) await new Promise(resolve => setTimeout(resolve, 50));
      assertOpen();
      send('state', { state: 'running' });
      await api.boundary();
    },
    async register(candidate) {
      assertOpen();
      if (!['run', 'download_item'].includes(command)) throw Object.assign(new Error('当前操作不允许登记文件。'), { code: 'UNSUPPORTED_OPERATION' });
      if (pendingArtifacts.has(candidate.candidateId)) throw new Error('结果正在登记。');
      return new Promise((resolve, reject) => {
        pendingArtifacts.set(candidate.candidateId, { resolve, reject });
        try { send('artifact_candidate', candidate); }
        catch (error) { pendingArtifacts.delete(candidate.candidateId); reject(error); }
      });
    },
    async registerReport(candidate) {
      // Title writes finish verifying the current submission after stop; their
      // reports may still be registered, without reopening ordinary work.
      if (closed || command !== 'run' || context.toolId !== 'product-title'
          || !['excel', 'text'].includes(candidate?.kind)) {
        throw Object.assign(new Error('此操作不允许登记收尾报告。'), { code: 'UNSUPPORTED_OPERATION' });
      }
      if (pendingArtifacts.has(candidate.candidateId)) throw new Error('报告正在登记。');
      return new Promise((resolve, reject) => {
        pendingArtifacts.set(candidate.candidateId, { resolve, reject, finalTitleReport: true });
        try { send('artifact_candidate', candidate); }
        catch (error) { pendingArtifacts.delete(candidate.candidateId); reject(error); }
      });
    },
    async lookup(candidateId) {
      assertOpen();
      if (!context.taskId) throw new Error('此操作没有任务身份。');
      if (pendingArtifacts.has(candidateId)) throw new Error('结果正在查询或登记。');
      return new Promise((resolve, reject) => {
        pendingArtifacts.set(candidateId, { resolve, reject });
        try { send('artifact_lookup', { candidateId }); }
        catch (error) { pendingArtifacts.delete(candidateId); reject(error); }
      });
    },
    async updateMetadata(candidateId, metadata) {
      assertOpen();
      if (!['run', 'download_item'].includes(command) || !context.taskId) {
        throw Object.assign(new Error('当前操作不允许更新任务结果。'), { code: 'UNSUPPORTED_OPERATION' });
      }
      if (typeof candidateId !== 'string' || !candidateId || candidateId.length > 200
          || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
          || !Object.keys(metadata).length || Object.keys(metadata).some(key => !['title', 'caption'].includes(key))
          || Object.entries(metadata).some(([key, value]) => typeof value !== 'string' || !value.trim()
            || [...value].length > (key === 'title' ? 2000 : 20000))) {
        throw Object.assign(new Error('视频标题或文案格式无效。'), { code: 'INVALID_PARAMETERS' });
      }
      if (pendingArtifacts.has(candidateId)) throw new Error('结果正在查询或登记。');
      return new Promise((resolve, reject) => {
        pendingArtifacts.set(candidateId, { resolve, reject });
        try { send('artifact_metadata', { candidateId, metadata }); }
        catch (error) { pendingArtifacts.delete(candidateId); reject(error); }
      });
    },
  };
  return api;
}

module.exports = { createApi, atomicState, Cancelled };
