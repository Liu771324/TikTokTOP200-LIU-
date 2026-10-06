'use strict';
const ExcelJS = require('exceljs');

function failureRows(task) {
  return task.items.filter(item => ['failed', 'uncertain'].includes(item.status)).map(item => [
    String(item.id), item.shopName, String(item.shopId), item.status === 'uncertain' ? '结果待核对' : item.skipped ? '失败跳过' : '失败停止',
    item.reason, item.original, item.before, item.target, item.excelRow || '', item.attempts,
  ]);
}

async function failureWorkbook(task) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('失败商品');
  sheet.columns = [
    ['商品 ID', 24], ['店铺名', 20], ['店铺 ID', 18], ['处理状态', 16], ['失败原因', 60],
    ['原标题查询词', 48], ['修改前标题', 48], ['目标新标题', 48], ['表格行号', 12], ['保存尝试', 12],
  ].map(([header, width]) => ({ header, width }));
  for (const row of failureRows(task)) sheet.addRow(row);
  sheet.getColumn(1).numFmt = '@'; sheet.getColumn(3).numFmt = '@';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: `J${sheet.rowCount}` };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172B42' } };
  sheet.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; });
  return book.xlsx.writeBuffer();
}

module.exports = { failureRows, failureWorkbook };
