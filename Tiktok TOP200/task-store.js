'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCombinationId } = require('./collector-utils');

const ROOT = __dirname;
const TASK_DIR = path.join(ROOT, 'data', 'tasks');
const CHECKPOINT_DIR = path.join(ROOT, 'data', 'checkpoints');
const REPORT_DIR = path.join(ROOT, 'reports');
const LOG_DIR = path.join(ROOT, 'logs');

for (const directory of [TASK_DIR, CHECKPOINT_DIR, REPORT_DIR, LOG_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

function taskPath(taskId) {
  return path.join(TASK_DIR, `${taskId}.json`);
}

function checkpointPath(taskId) {
  return path.join(CHECKPOINT_DIR, `${taskId}.json`);
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function buildTaskName(task, duplicateIndex = 1) {
  const createdAt = new Date(task.createdAt || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  const dateTime = `${createdAt.getFullYear()}-${pad(createdAt.getMonth() + 1)}-${pad(createdAt.getDate())} ${pad(createdAt.getHours())}:${pad(createdAt.getMinutes())}`;
  const parameters = task.parameters || task;
  const rankings = Array.isArray(parameters.rankingTypes) ? parameters.rankingTypes : [];
  const rankingLabel = rankings.length > 3 ? `${rankings.slice(0, 2).join('、')}等${rankings.length}个榜单` : rankings.join('、') || '未指定榜单';
  const categoryCount = Array.isArray(parameters.categories) ? parameters.categories.length : 0;
  const brandLabel = parameters.brandType && parameters.brandType !== '不限' ? `｜${parameters.brandType}` : '';
  const base = `${dateTime}｜${rankingLabel}｜${categoryCount}个类目${brandLabel}`;
  if (duplicateIndex <= 1) return base;
  const circled = ['②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  return `${base}${circled[duplicateIndex - 2] || `（${duplicateIndex}）`}`;
}

function selectVisibleTasks(tasks, completedLimit = 10) {
  let completed = 0;
  return [...tasks]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .filter((task) => {
      if (task.status !== 'completed') return true;
      completed += 1;
      return completed <= completedLimit;
    });
}

function createTask(parameters) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  let taskId;
  do {
    taskId = `top200-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  } while (fs.existsSync(taskPath(taskId)));
  const combinations = [];
  for (const category of parameters.categories) {
    for (const rankingType of parameters.rankingTypes) {
      combinations.push({
        id: createCombinationId(category.displayPath, rankingType),
        category,
        rankingType,
        status: 'pending',
        scanned: 0,
        saved: 0,
      });
    }
  }
  const taskNameBase = buildTaskName({ createdAt: now.toISOString(), parameters });
  const duplicateIndex = listTasks().filter((item) => String(item.taskName || buildTaskName(item)).startsWith(taskNameBase)).length + 1;
  const task = {
    taskId,
    taskName: buildTaskName({ createdAt: now.toISOString(), parameters }, duplicateIndex),
    createdAt: now.toISOString(),
    completedAt: null,
    status: 'pending',
    parameters: {
      ...parameters,
      periodPolicy: '实时优先，否则近1天',
      rankLimit: 200,
    },
    stats: {
      totalCombinations: combinations.length,
      completedCombinations: 0,
      scanned: 0,
      up: 0,
      first: 0,
      excluded: 0,
      unparseable: 0,
      duplicates: 0,
    },
    current: null,
    combinations,
    results: [],
    failures: [],
    reportFiles: null,
  };
  saveTask(task);
  return task;
}

function saveTask(task) {
  atomicWriteJson(taskPath(task.taskId), task);
  if (!['completed', 'failed'].includes(task.status)) atomicWriteJson(checkpointPath(task.taskId), task);
  else if (fs.existsSync(checkpointPath(task.taskId))) fs.unlinkSync(checkpointPath(task.taskId));
  return task;
}

function loadTask(taskId) {
  const filePath = taskPath(taskId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listTasks() {
  return fs.readdirSync(TASK_DIR)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(TASK_DIR, name), 'utf8'))];
      } catch (error) {
        console.warn(`跳过损坏的任务文件 ${name}：${error.message}`);
        return [];
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  ROOT,
  TASK_DIR,
  CHECKPOINT_DIR,
  REPORT_DIR,
  LOG_DIR,
  atomicWriteJson,
  buildTaskName,
  selectVisibleTasks,
  createTask,
  saveTask,
  loadTask,
  listTasks,
};
