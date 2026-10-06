'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { failureWorkbook } = require('../report');

test('失败 Excel 仅记录失败和待核对商品，长 ID 和标题作为文本原样保留', async () => {
  const failed = { id: '3845984014255128772', shopId: '000263623599', shopName: '馋果小铺', status: 'failed', skipped: true,
    reason: '新标题预测类目与当前类目不一致', original: '查询词', before: '原标题', target: '=原样标题', excelRow: 2, attempts: 2 };
  const task = { items: [failed, { ...failed, id: '3845984014255128773', shopName: '甲店', status: 'uncertain', skipped: false },
    { ...failed, status: 'success' }, { ...failed, status: 'unmodified' }] };
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await failureWorkbook(task));
  const sheet = book.getWorksheet('失败商品');
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell('A2').value, failed.id); assert.equal(sheet.getCell('A2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('B2').value, '馋果小铺'); assert.equal(sheet.getCell('C2').value, '000263623599');
  assert.equal(sheet.getCell('D2').value, '失败跳过'); assert.equal(sheet.getCell('E2').value, failed.reason);
  assert.equal(sheet.getCell('H2').value, '=原样标题'); assert.equal(sheet.getCell('H2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('D3').value, '结果待核对');
});
