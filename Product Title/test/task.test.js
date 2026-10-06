'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupRows } = require('../workbook');
const { newTask, runTask } = require('../task');
const shops = [{ id: '1', name: '甲店' }, { id: '2', name: '乙店' }];
const input = () => groupRows([['原标题', '新标题'], ['原词', '新一'], ['', '新二'], ['', '新三'], ['', '新四'], ['第二组', '末组']]);
const products = n => Array.from({ length: n }, (_, i) => ({ id: String(9000 + i), shopId: shops[i % 2].id, shopName: shops[i % 2].name, title: `命中但不完全等于原词${i}` }));

test('空 A 沿用、重复原标题合并、正文空格保留、空 B 记录跳过', () => {
  const result = groupRows([['原标题', '新标题'], ['词', ' 新一 '], ['', ''], ['别词', '新二'], ['词', '新三']]);
  assert.deepEqual(result.groups.map(g => [g.original, g.titles]), [['词', [' 新一 ', '新三']], ['别词', ['新二']]]);
  assert.equal(result.skipped[0].row, 3);
});
test('尚无原标题的非空新标题及错误表头阻止执行', () => {
  assert.throws(() => groupRows([['原标题', '新标题'], ['', '孤立标题']]), /尚未出现原标题/);
  assert.throws(() => groupRows([['错误', '新标题']]), /第一行/);
});
for (const n of [0, 3, 4, 6]) {
  test(`4 个标题匹配 ${n} 件商品，跨店顺序分配并继续下一组`, async () => {
    const data = input(), task = newTask(shops, data), saved = [], calls = [];
    await runTask(task, data, {
      query: async (original, selected) => { calls.push(original); assert.deepEqual(selected, shops); return original === '原词' ? products(n) : []; },
      save: async item => { saved.push([item.id, item.target]); return { title: item.target }; },
    }, new AbortController().signal);
    assert.equal(task.status, 'complete');
    assert.equal(task.saved, Math.min(n, 4));
    assert.deepEqual(saved.map(s => s[1]), ['新一', '新二', '新三', '新四'].slice(0, n));
    assert.equal(task.groups[0].unused, Math.max(4 - n, 0));
    assert.equal(task.groups[0].unmodified, Math.max(n - 4, 0));
    assert.deepEqual(calls, ['原词', '第二组']);
  });
}
test('系统异常立即停止，保留已成功记录和待处理明细', async () => {
  const data = input(), task = newTask(shops, data), queried = [];
  await runTask(task, data, {
    query: async original => { queried.push(original); return products(3); },
    save: async item => { if (item.order === 2) throw new Error('重试仍失败'); return { title: item.target }; },
  }, new AbortController().signal);
  assert.equal(task.saved, 1); assert.equal(task.status, 'failed');
  assert.deepEqual(queried, ['原词']);
  assert.equal(task.stopPosition.productId, '9001');
  assert.equal(task.items[0].status, 'success'); assert.equal(task.items[2].status, 'unmodified');
  assert.equal(task.groups[0].unmodified, 2); assert.equal(task.groups[0].unused, 3);
});
test('单件明确失败消耗当前标题，继续下一商品和标题，并继续下一组', async () => {
  const data = input(), task = newTask(shops, data), queried = [], attempts = [];
  await runTask(task, data, {
    query: async original => { queried.push(original); return original === '原词' ? products(6) : products(1); },
    save: async item => {
      attempts.push([item.id, item.target]);
      if (item.original === '原词' && [1, 3].includes(item.order)) {
        const error = new Error('新标题预测类目与当前类目不一致'); error.itemRejected = true; throw error;
      }
      return { title: item.target };
    },
  }, new AbortController().signal);
  assert.equal(task.status, 'complete'); assert.equal(task.saved, 3); assert.equal(task.failed, 2);
  assert.equal(task.stopPosition, null); assert.deepEqual(queried, ['原词', '第二组']);
  assert.deepEqual(attempts, [['9000', '新一'], ['9001', '新二'], ['9002', '新三'], ['9003', '新四'], ['9000', '末组']]);
  assert.deepEqual(task.items.slice(0, 6).map(item => item.status), ['failed', 'success', 'failed', 'success', 'unmodified', 'unmodified']);
  assert.deepEqual(task.items.filter(item => item.status === 'failed').map(item => [item.id, item.shopName]), [['9000', '甲店'], ['9002', '甲店']]);
  assert.equal(task.groups[0].failed, 2); assert.equal(task.groups[0].unused, 0); assert.equal(task.groups[0].unmodified, 4);
});
test('保存结果未知仍停止，不作为明确失败跳过', async () => {
  const data = input(), task = newTask(shops, data); let attempts = 0;
  await runTask(task, data, { query: async () => products(3), save: async () => {
    attempts++; const error = new Error('保存结果无法确认'); error.uncertain = true; throw error;
  } }, new AbortController().signal);
  assert.equal(attempts, 1); assert.equal(task.status, 'failed'); assert.equal(task.items[0].status, 'uncertain');
});
test('请求停止后不保存后续商品，也不查询下一组', async () => {
  const data = input(), task = newTask(shops, data), controller = new AbortController(); let saves = 0;
  await runTask(task, data, {
    query: async () => products(3),
    save: async item => { saves++; controller.abort(); return { title: item.target }; },
  }, controller.signal);
  assert.equal(task.saved, 1); assert.equal(saves, 1); assert.equal(task.status, 'stopped');
});
test('查询失败不保存、不执行后续原标题', async () => {
  const data = input(), task = newTask(shops, data); let saves = 0;
  await runTask(task, data, { query: async () => { throw new Error('店铺查询失败'); }, save: async () => { saves++; } }, new AbortController().signal);
  assert.equal(saves, 0); assert.equal(task.groups.length, 1); assert.equal(task.status, 'failed');
});
test('已为目标标题的商品不计入实际保存数', async () => {
  const data = input(), task = newTask(shops, data);
  await runTask(task, data, {
    query: async original => original === '原词' ? products(1) : [],
    save: async item => ({ title: item.target, already: true }),
  }, new AbortController().signal);
  assert.equal(task.status, 'complete'); assert.equal(task.saved, 0); assert.equal(task.unchanged, 1);
  assert.equal(task.groups[0].unmodified, 1); assert.equal(task.groups[0].unused, 3);
});
test('空白间隔后仍读取后续数据行', async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const ExcelJS = require('exceljs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'title-reader-'));
  const filename = path.join(directory, 'gap.xlsx');
  try {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['原标题', '新标题']); sheet.addRow(['原词', '新一']); sheet.getCell('B10').value = '新二';
    await workbook.xlsx.writeFile(filename);
    const data = await require('../workbook').readWorkbook(filename);
    assert.deepEqual(data.groups[0].rows, [2, 10]); assert.equal(data.titleCount, 2);
  } finally { await fs.rm(filename, { force: true }); await fs.rmdir(directory); }
});
