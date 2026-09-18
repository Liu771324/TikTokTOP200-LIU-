'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCategory } = require('./category_discovery');

function createTaskStore(rootDir = __dirname) {
  const TASK_DIR = path.join(rootDir, 'data', 'tasks');
  const CHECKPOINT_DIR = path.join(rootDir, 'data', 'checkpoints');
  for (const directory of [TASK_DIR, CHECKPOINT_DIR]) fs.mkdirSync(directory, { recursive: true });

  const taskPath = (taskId) => path.join(TASK_DIR, `${taskId}.json`);
  const checkpointPath = (taskId) => path.join(CHECKPOINT_DIR, `${taskId}.json`);

  function atomicWriteJson(filePath, value) {
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporary, filePath);
  }

  function saveTask(task) {
    task.updatedAt = new Date().toISOString();
    atomicWriteJson(taskPath(task.taskId), task);
    if (task.status === 'completed' && task.combinations.every((item) => item.status === 'completed')) {
      try { fs.unlinkSync(checkpointPath(task.taskId)); } catch {}
    } else {
      atomicWriteJson(checkpointPath(task.taskId), task);
    }
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
        try { return [JSON.parse(fs.readFileSync(path.join(TASK_DIR, name), 'utf8'))]; }
        catch { return []; }
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function createTask(parameters) {
    const now = new Date();
    const categories = parameters.categories.map(normalizeCategory).filter(Boolean);
    const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const taskId = `business-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
    const combinations = categories.map((category, index) => ({
      id: crypto.createHash('sha1').update(category.displayPath).digest('hex').slice(0, 16),
      index,
      category,
      status: 'pending',
      currentPage: 0,
      qualifyingCount: 0,
      resultCount: 0,
      failureCount: 0,
      coverageComplete: false,
      error: null,
    }));
    const task = {
      taskId,
      taskName: `${now.toLocaleString('zh-CN', { hour12: false })}｜${categories.length}个类目｜成交增长`,
      status: 'pending',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAt: null,
      completedAt: null,
      parameters: {
        categories,
        minSales: parameters.minSales,
        maxSales: parameters.maxSales,
        only30dGrowth: parameters.only30dGrowth === true,
      },
      combinations,
      current: null,
      results: [],
      failures: [],
      unparseableItems: [],
      stats: {
        totalCategories: combinations.length,
        completedCategories: 0,
        qualifyingCount: 0,
        saved: 0,
        failed: 0,
      },
      reportFiles: null,
      lastError: null,
    };
    return saveTask(task);
  }

  function prepareTask(task, { mode = 'resume' } = {}) {
    const eligible = mode === 'retry' ? new Set(['failed']) : new Set(['pending', 'running', 'stopped', 'failed']);
    for (const combination of task.combinations) {
      if (eligible.has(combination.status)) {
        combination.status = 'pending';
        combination.error = null;
      }
    }
    task.status = 'pending';
    task.current = null;
    task.completedAt = null;
    task.lastError = null;
    return task;
  }

  function recoverInterruptedTasks() {
    for (const task of listTasks()) {
      if (task.status !== 'running') continue;
      task.status = 'stopped';
      task.lastError = '服务重启，等待继续';
      for (const combination of task.combinations) {
        if (combination.status === 'running') combination.status = 'stopped';
      }
      saveTask(task);
    }
  }

  return {
    TASK_DIR,
    CHECKPOINT_DIR,
    atomicWriteJson,
    checkpointPath,
    createTask,
    listTasks,
    loadTask,
    prepareTask,
    recoverInterruptedTasks,
    saveTask,
    taskPath,
  };
}

const defaultStore = createTaskStore(__dirname);

module.exports = { createTaskStore, ...defaultStore };
