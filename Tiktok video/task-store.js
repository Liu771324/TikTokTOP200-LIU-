'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const TASK_DIR = path.join(ROOT, 'data', 'tasks');
const CHECKPOINT_DIR = path.join(ROOT, 'data', 'checkpoints');
const LOG_DIR = path.join(ROOT, 'logs');
const VIDEO_DIR = path.join(ROOT, '视频');
for (const directory of [TASK_DIR, CHECKPOINT_DIR, LOG_DIR, VIDEO_DIR]) fs.mkdirSync(directory, { recursive: true });

function taskFile(id) { return path.join(TASK_DIR, `${id}.json`); }
function checkpointFile(id) { return path.join(CHECKPOINT_DIR, `${id}.json`); }

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function saveTask(task) {
  atomicWrite(taskFile(task.id), task);
  atomicWrite(checkpointFile(task.id), task.checkpoint || {});
  return task;
}

function createTask(parameters) {
  const task = {
    id: `video-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: 'queued',
    parameters,
    progress: { scanned: 0, eligible: 0, videosSaved: 0, videoFailures: 0, captionFailures: 0, currentRank: null, currentProduct: null, currentVideo: null },
    logs: [],
    errors: [],
    checkpoint: { page: 1, rank: 1, productId: null, videoIndex: 0, completedVideos: {}, failedVideos: {}, eligibleRanks: [], trendErrors: [], productDirs: {}, rankProducts: {}, initialTotal: null, pageSize: null },
  };
  saveTask(task);
  return task;
}

function loadTask(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(taskFile(id), 'utf8')); } catch { return null; }
}

function listTasks() {
  return fs.readdirSync(TASK_DIR).filter((name) => name.endsWith('.json')).flatMap((name) => {
    try { return [JSON.parse(fs.readFileSync(path.join(TASK_DIR, name), 'utf8'))]; } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function appendLog(task, line) {
  const entry = { at: new Date().toISOString(), line: String(line) };
  task.logs.push(entry);
  fs.appendFileSync(path.join(LOG_DIR, `${task.id}.log`), `${entry.at}\t${entry.line}\n`, 'utf8');
  saveTask(task);
}

module.exports = { ROOT, TASK_DIR, CHECKPOINT_DIR, LOG_DIR, VIDEO_DIR, atomicWrite, createTask, saveTask, loadTask, listTasks, appendLog };
