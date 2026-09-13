'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { createTask, saveTask, loadTask, buildTaskName, selectVisibleTasks, TASK_DIR, CHECKPOINT_DIR } = require('../task-store');
const { exportTask } = require('../export-excel');

test('检查点恢复保留已完成组合，不会把它重新标为待执行', () => {
  const task = createTask({
    categories: [{ displayPath: '脱敏一级 / 脱敏二级', segments: ['脱敏一级', '脱敏二级'] }],
    brandType: '不限',
    rankingTypes: ['总榜', '搜索榜'],
  });
  task.status = 'running';
  task.combinations[0].status = 'completed';
  task.combinations[1].status = 'pending';
  saveTask(task);
  const restored = loadTask(task.taskId);
  assert.equal(restored.combinations[0].status, 'completed');
  assert.deepEqual(restored.combinations.filter((item) => item.status !== 'completed').map((item) => item.rankingType), ['搜索榜']);
  task.status = 'completed';
  saveTask(task);
  fs.unlinkSync(path.join(TASK_DIR, `${task.taskId}.json`));
  assert.equal(fs.existsSync(path.join(CHECKPOINT_DIR, `${task.taskId}.json`)), false);
});

test('新任务持久化可读名称，旧任务可生成兼容显示名称', () => {
  const parameters = {
    categories: [{ displayPath: '脱敏类目', segments: ['脱敏类目'] }],
    brandType: '不限',
    rankingTypes: ['总榜', '搜索榜'],
  };
  const task = createTask(parameters);
  assert.match(task.taskName, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}｜总榜、搜索榜｜1个类目/);
  assert.equal(loadTask(task.taskId).taskName, task.taskName);
  assert.match(buildTaskName({ createdAt: task.createdAt, parameters }), /总榜、搜索榜｜1个类目/);
  task.status = 'completed';
  saveTask(task);
  fs.unlinkSync(path.join(TASK_DIR, `${task.taskId}.json`));
});

test('历史主列表保留全部未完成任务和最近 10 个已完成任务', () => {
  const tasks = Array.from({ length: 15 }, (_, index) => ({
    taskId: `task-${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 6, 0, index)).toISOString(),
    status: index < 12 ? 'completed' : ['stopped', 'failed', 'pending'][index - 12],
  })).reverse();
  const visible = selectVisibleTasks(tasks, 10);
  assert.equal(visible.filter((task) => task.status === 'completed').length, 10);
  assert.deepEqual(visible.filter((task) => task.status !== 'completed').map((task) => task.taskId).sort(), ['task-12', 'task-13', 'task-14']);
});

test('Excel 按榜单分表、顶部展示公共信息且 JSON 与明细总数一致', async () => {
  const task = {
    taskId: `top200-test-${Date.now()}`,
    createdAt: '2026-08-07T06:30:25.000Z',
    completedAt: '2026-08-07T07:40:30.000Z',
    status: 'completed',
    parameters: { categories: [{ displayPath: '脱敏类目' }], brandType: '不限', rankingTypes: ['总榜', '搜索榜'] },
    stats: { scanned: 2, up: 1, first: 1 },
    combinations: [
      { category: { displayPath: '脱敏类目' }, rankingType: '总榜', actualPeriod: '实时', status: 'completed', scanned: 1, up: 1, first: 0, excluded: 0, unparseable: 0 },
      { category: { displayPath: '脱敏类目' }, rankingType: '搜索榜', actualPeriod: '近1天', status: 'completed', scanned: 1, up: 0, first: 1, excluded: 0, unparseable: 0 },
    ],
    results: [
      { collectedAt: new Date().toISOString(), categoryPath: '脱敏类目', brandType: '不限', rankingType: '总榜', requestedPeriod: '实时', actualPeriod: '实时', rank: 1, trendType: 'up', trendText: '↑ 2', riseCount: 2, productName: '商品A', priceRange: '¥10', productUrl: 'https://example.test/product?id=1', shopName: '店铺A', userPaymentAmount: '¥1万-¥2万', clickCount: '1万-2万', clickConversionRate: '10%-15%', orderCount: '100-200', page: 1, rowIndex: 1, extraFields: {} },
      { collectedAt: new Date().toISOString(), categoryPath: '脱敏类目', brandType: '不限', rankingType: '搜索榜', requestedPeriod: '实时', actualPeriod: '近1天', rank: 2, trendType: 'first', trendText: '首次上榜', riseCount: null, productName: '商品B', priceRange: '¥20', productUrl: 'https://example.test/product?id=2', shopName: '店铺B', userPaymentAmount: '', clickCount: '', clickConversionRate: '', orderCount: '', page: 1, rowIndex: 2, extraFields: { 热搜词: '示例词', 商品曝光人数: '2万-3万' } },
    ],
    failures: [],
  };
  const files = await exportTask(task);
  const json = JSON.parse(fs.readFileSync(files.jsonPath, 'utf8'));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(files.xlsxPath);
  const totalDetail = workbook.getWorksheet('总榜明细');
  const searchDetail = workbook.getWorksheet('搜索榜明细');
  assert.equal(json.results.length, task.stats.up + task.stats.first);
  assert.equal((totalDetail.rowCount - 6) + (searchDetail.rowCount - 6), json.results.length);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['任务汇总', '总榜明细', '搜索榜明细', '失败记录']);
  assert.equal(totalDetail.getCell('A1').value, '采集时间');
  assert.equal(totalDetail.getCell('B1').value, '2026-08-07 15:40:30（北京时间）');
  assert.equal(workbook.getWorksheet('任务汇总').getCell('A2').value, '2026-08-07 14:30:25（北京时间）');
  assert.equal(workbook.getWorksheet('任务汇总').getCell('B2').value, '2026-08-07 15:40:30（北京时间）');
  assert.equal(json.createdAt, '2026-08-07T06:30:25.000Z');
  assert.equal(json.completedAt, '2026-08-07T07:40:30.000Z');
  assert.equal(totalDetail.getCell('A6').value, '当前排名');
  const allHeaders = workbook.worksheets.flatMap((sheet) => sheet.getRow(sheet.name.endsWith('明细') ? 6 : 1).values);
  assert.equal(allHeaders.includes('任务编号'), false);
  assert.equal(allHeaders.includes('实际周期'), false);
  assert.equal(allHeaders.includes('趋势类型'), false);
  assert.equal(totalDetail.getRow(6).values.includes('热搜词'), false);
  assert.equal(searchDetail.getRow(6).values.includes('热搜词'), true);
  assert.equal(searchDetail.getCell(7, searchDetail.getRow(6).values.indexOf('商品链接')).value.hyperlink, 'https://example.test/product?id=2');
  fs.unlinkSync(files.jsonPath);
  fs.unlinkSync(files.xlsxPath);
});
