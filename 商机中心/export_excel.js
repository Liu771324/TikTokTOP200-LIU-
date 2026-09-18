'use strict';

const ExcelJS = require('exceljs');
const fs = require('node:fs');
const path = require('node:path');
const { groupProducts } = require('./product_grouping');

const COLORS = {
  info: 'FFE9EDF2',
  header: 'FFDCE6F1',
};

function applyHeaderStyle(sheet, rowNumber, columnCount, fill = COLORS.header) {
  const row = sheet.getRow(rowNumber);
  row.height = 22;
  for (let column = 1; column <= columnCount; column += 1) {
    const cell = row.getCell(column);
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  }
}

function applyWidths(sheet, widths) {
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
}

function addAutoFilter(sheet, headerRow, columnCount, rowCount) {
  if (!columnCount) return;
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(headerRow, rowCount), column: columnCount },
  };
}

function appendDataSheet(workbook, name, rows, widths, options = {}) {
  const headerRow = options.headerRow || 1;
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: headerRow }],
  });
  sheet.addRows(rows);
  applyWidths(sheet, widths);
  applyHeaderStyle(sheet, headerRow, widths.length, options.headerFill || COLORS.header);
  addAutoFilter(sheet, headerRow, widths.length, rows.length);
  return sheet;
}

function appendInfoDataSheet(workbook, name, infoRows, header, dataRows, widths) {
  const blankRow = infoRows.length + 1;
  const headerRow = blankRow + 1;
  const rows = [...infoRows, [], header, ...dataRows];
  const sheet = appendDataSheet(workbook, name, rows, widths, { headerRow });
  infoRows.forEach(([, value], index) => {
    const rowNumber = index + 1;
    sheet.mergeCells(rowNumber, 2, rowNumber, widths.length);
    const labelCell = sheet.getCell(rowNumber, 1);
    labelCell.font = { bold: true };
    labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.info } };
    const valueCell = sheet.getCell(rowNumber, 2);
    valueCell.value = value;
    valueCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    sheet.getRow(rowNumber).height = 22;
  });
  sheet.getRow(blankRow).height = 8;
  return sheet;
}

function mergeProductGroupCells(sheet, values, firstRow, column = 2) {
  let start = 0;
  while (start < values.length) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[start]) end += 1;
    if (values[start] && values[start] !== '未归类' && end > start) {
      sheet.mergeCells(firstRow + start, column, firstRow + end, column);
      sheet.getCell(firstRow + start, column).alignment = { vertical: 'middle', horizontal: 'center' };
    }
    start = end + 1;
  }
}

function appendSummarySheet(workbook, payload) {
  const completion = payload.completion || {};
  const headers = ['任务名称', '任务编号', '采集时间', '采集状态', '区间覆盖', '类目进度', '达标商品', '增长结果', '失败记录', '耗时（秒）', '预筛选模式', '预筛选通过', '预筛选跳过', '打开详情'];
  const summary = [
    payload.taskName || payload.categoryLabel || '成交增长采集',
    payload.taskId || '-',
    payload.outputTime instanceof Date ? payload.outputTime.toLocaleString('zh-CN') : String(payload.outputTime || ''),
    completion.status === 'partial' ? `部分结果（${completion.message || '采集提前结束'}）` : '完整结果',
    completion.coverageComplete ? '已完成' : '未完成',
    `${payload.completedCategories ?? 1}/${payload.totalCategories ?? 1}`,
    payload.qualifyingCount || 0,
    payload.results?.length || 0,
    (payload.failures?.length || 0) + (payload.unparseableItems?.length || 0),
    payload.elapsedSeconds || 0,
    payload.only30dGrowth ? '仅红色向上箭头' : '未启用',
    payload.stats?.prefilterPassed || 0,
    payload.stats?.prefilterSkipped || 0,
    payload.stats?.detailsOpened ?? payload.qualifyingCount ?? 0,
  ];
  const categoryHeader = ['类目', '状态', '达标数', '结果数', '失败数', '区间覆盖'];
  const categoryRows = (payload.combinations || []).map((combination) => [
    combination.category?.displayPath || '',
    combination.status || '',
    combination.qualifyingCount || 0,
    combination.resultCount || 0,
    combination.failureCount || 0,
    combination.coverageComplete ? '已完成' : '未完成',
  ]);
  const rows = [headers, summary, [], categoryHeader, ...categoryRows];
  const sheet = workbook.addWorksheet('采集汇总', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });
  sheet.addRows(rows);
  applyWidths(sheet, [45, 36, 22, 24, 14, 12, 12, 12, 12, 14, 20, 12, 12, 12]);
  applyHeaderStyle(sheet, 1, headers.length, COLORS.info);
  applyHeaderStyle(sheet, 4, categoryHeader.length, COLORS.header);
  sheet.getRow(2).alignment = { vertical: 'middle', wrapText: true };
  sheet.getRow(3).height = 8;
  addAutoFilter(sheet, 4, categoryHeader.length, rows.length);
  return sheet;
}

async function generateExcelReport(payload, xlsxPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '抖店商机中心采集系统';
  workbook.created = payload.outputTime instanceof Date ? payload.outputTime : new Date();
  appendSummarySheet(workbook, payload);

  const groupedResults = groupProducts(payload.results || []);
  const resultRows = [['#', '产品分组', '类目', '产品名称', '近30天总成交', '昨日成交', '今日成交', '较昨日增长']];
  for (const [index, item] of groupedResults.entries()) {
    resultRows.push([
      index + 1,
      item.productGroup || '未归类',
      item.categoryPath || payload.categoryLabel || '',
      item.keyword || '',
      item.totalSales || '',
      item.yesterday || '',
      item.today || '',
      item.growth || '',
    ]);
  }
  const resultSheet = appendDataSheet(workbook, '成交增长', resultRows, [6, 16, 45, 32, 18, 18, 18, 18]);
  resultSheet.getColumn(1).alignment = { vertical: 'middle', horizontal: 'center' };
  resultSheet.getColumn(2).alignment = { vertical: 'middle', horizontal: 'center' };
  for (let column = 5; column <= 8; column += 1) {
    resultSheet.getColumn(column).alignment = { vertical: 'middle', horizontal: 'center' };
  }
  mergeProductGroupCells(resultSheet, groupedResults.map((item) => item.productGroup), 2);

  const failureRows = [['类目', '页码', '产品名称', '阶段', '原因', '重试次数']];
  for (const item of payload.unparseableItems || []) {
    failureRows.push([
      item.categoryPath || payload.categoryLabel || '',
      item.page || '',
      item.keyword || '',
      '数据解析',
      item.reason || '',
      Math.max(0, (item.attempts || 1) - 1),
    ]);
  }
  for (const item of payload.failures || []) {
    failureRows.push([
      item.categoryPath || payload.categoryLabel || '',
      item.page || '',
      item.keyword || '',
      item.stage || '商品详情',
      item.reason || item.error || '',
      Math.max(0, (item.attempts || 1) - 1),
    ]);
  }
  const failureSheet = appendDataSheet(
    workbook,
    '失败记录',
    failureRows,
    [45, 10, 32, 16, 50, 12],
    { headerFill: COLORS.info },
  );
  failureSheet.getColumn(2).alignment = { vertical: 'middle', horizontal: 'center' };
  failureSheet.getColumn(5).alignment = { vertical: 'middle', wrapText: true };
  failureSheet.getColumn(6).alignment = { vertical: 'middle', horizontal: 'center' };
  await workbook.xlsx.writeFile(xlsxPath);
  return payload.results?.length || 0;
}

async function generateExcelFromMarkdown(mdPath, xlsxPath) {
  const md = fs.readFileSync(mdPath, 'utf8');
  const lines = md.split('\n');
  let time = '';
  let category = '';
  let filter = '';
  let collectionStatus = '';
  let coverage = '';
  let statLine = '';
  for (const line of lines) {
    if (line.startsWith('> 采集时间:')) time = line.replace('> 采集时间:', '').trim();
    else if (line.startsWith('> 品类:')) category = line.replace('> 品类:', '').trim();
    else if (line.startsWith('> 筛选:')) filter = line.replace('> 筛选:', '').trim();
    else if (line.startsWith('> 采集状态:')) collectionStatus = line.replace('> 采集状态:', '').trim();
    else if (line.startsWith('> 区间覆盖:')) coverage = line.replace('> 区间覆盖:', '').trim();
    else if (line.startsWith('> 采集:')) statLine = line.replace('> 采集:', '').trim();
  }

  const rows = [];
  for (const line of lines) {
    const eight = line.match(/^\|\s*(\d+)\s*\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|$/);
    const seven = line.match(/^\|\s*(\d+)\s*\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|$/);
    const six = line.match(/^\|\s*(\d+)\s*\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|(.*?)\|$/);
    if (eight) rows.push(eight.slice(1).map((value) => value.trim()));
    else if (seven) rows.push(seven.slice(1).map((value) => value.trim()));
    else if (six) rows.push(six.slice(1).map((value) => value.trim()));
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '抖店商机中心采集系统';
  const infoLines = [
    ['采集时间', time],
    ['品类', category],
    ['筛选', filter],
    ['采集状态', collectionStatus],
    ['区间覆盖', coverage],
    ['采集统计', statLine],
  ];
  const hasProductGroup = rows.some((row) => row.length === 8);
  const hasCategory = hasProductGroup || rows.some((row) => row.length === 7);
  const header = hasProductGroup
    ? ['#', '产品分组', '类目', '产品名称', '近30天总成交', '昨日成交', '今日成交', '较昨日增长']
    : hasCategory
      ? ['#', '类目', '产品名称', '近30天总成交', '昨日成交', '今日成交', '较昨日增长']
    : ['#', '产品名称', '近30天总成交', '昨日成交', '今日成交', '较昨日增长'];
  const sheet = appendInfoDataSheet(
    workbook,
    '成交增长',
    infoLines,
    header,
    rows,
    hasProductGroup
      ? [6, 16, 45, 32, 18, 18, 18, 18]
      : (hasCategory ? [6, 45, 32, 18, 18, 18, 18] : [6, 32, 18, 18, 18, 18]),
  );
  sheet.getColumn(1).alignment = { vertical: 'middle', horizontal: 'center' };
  if (hasProductGroup) mergeProductGroupCells(sheet, rows.map((row) => row[1]), infoLines.length + 3);
  await workbook.xlsx.writeFile(xlsxPath);
  return rows.length;
}

if (require.main === module) {
  const mdPath = process.argv[2] || path.join(__dirname, '选品报告-成交增长.md');
  const xlsxPath = process.argv[3] || path.join(__dirname, '选品报告-成交增长.xlsx');
  generateExcelFromMarkdown(mdPath, xlsxPath)
    .then((count) => console.log(`Excel 已保存：${count} 条增长 -> ${xlsxPath}`))
    .catch((error) => {
      console.error(`Excel 生成失败：${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { generateExcelFromMarkdown, generateExcelReport };
