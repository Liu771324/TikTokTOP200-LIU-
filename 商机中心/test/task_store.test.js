const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskStore } = require('../task-store');

test('任务按类目顺序创建组合并原子保存快照', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-task-store-'));
  const store = createTaskStore(root);
  const task = store.createTask({
    categories: [
      { displayPath: '传统滋补 / 药食同源食品', segments: ['传统滋补', '药食同源食品'] },
      { displayPath: '传统滋补 / 枸杞及其制品', segments: ['传统滋补', '枸杞及其制品'] },
    ],
    minSales: 10000,
    maxSales: 250000,
  });

  assert.equal(task.combinations.length, 2);
  assert.deepEqual(task.combinations.map((item) => item.category.displayPath), task.parameters.categories.map((item) => item.displayPath));
  assert.deepEqual(task.combinations.map((item) => item.status), ['pending', 'pending']);
  assert.equal(task.parameters.only30dGrowth, false);
  assert.equal(store.loadTask(task.taskId).taskId, task.taskId);
  assert.equal(fs.readdirSync(store.CHECKPOINT_DIR).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('恢复任务跳过已完成类目，重试只重置失败类目', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-task-resume-'));
  const store = createTaskStore(root);
  const task = store.createTask({
    categories: ['A', 'B', 'C'].map((name) => ({ displayPath: name, segments: [name] })),
    minSales: 0,
    maxSales: null,
    only30dGrowth: true,
  });
  task.combinations[0].status = 'completed';
  task.combinations[1].status = 'stopped';
  task.combinations[2].status = 'failed';
  store.saveTask(task);

  const resumed = store.prepareTask(task, { mode: 'resume' });
  assert.deepEqual(resumed.combinations.map((item) => item.status), ['completed', 'pending', 'pending']);
  resumed.combinations[1].status = 'stopped';
  resumed.combinations[2].status = 'failed';
  const retried = store.prepareTask(resumed, { mode: 'retry' });
  assert.deepEqual(retried.combinations.map((item) => item.status), ['completed', 'stopped', 'pending']);
  assert.equal(retried.parameters.only30dGrowth, true);
  fs.rmSync(root, { recursive: true, force: true });
});
