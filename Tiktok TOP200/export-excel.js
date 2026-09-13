'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { REPORT_DIR, atomicWriteJson } = require('./task-store');

function safeFileStamp(iso) {
  const date = new Date(iso || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatBeijingDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (part) => String(part).padStart(2, '0');
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}（北京时间）`;
}

function buildSummaryRows(task) {
  const base = {
    开始时间: formatBeijingDateTime(task.createdAt),
    结束时间: formatBeijingDateTime(task.completedAt),
    品牌类型: task.parameters.brandType,
  };
  return task.combinations.map((combination) => ({
    ...base,
    行业类目: combination.category.displayPath,
    榜单类型: combination.rankingType,
    状态: combination.status,
    扫描数量: combination.scanned || 0,
    上升数量: combination.up || 0,
    首次上榜数量: combination.first || 0,
    排除数量: combination.excluded || 0,
    解析异常: combination.unparseable || 0,
    失败原因: combination.error || '',
  }));
}

function buildDetailRows(task, rankingType) {
  const records = task.results.filter((record) => !rankingType || record.rankingType === rankingType);
  const categoryCount = new Set(records.map((record) => record.categoryPath).filter(Boolean)).size
    || new Set((task.parameters.categories || []).map((category) => category.displayPath || category)).size;
  const includeCategory = categoryCount > 1;
  const metricFields = [
    ['用户支付金额', 'userPaymentAmount'],
    ['点击次数', 'clickCount'],
    ['点击成交转化率', 'clickConversionRate'],
    ['商品成交件数', 'orderCount'],
  ].filter(([, key]) => records.some((record) => record[key] !== '' && record[key] != null));
  const extraHeaders = [...new Set(records.flatMap((record) => Object.keys(record.extraFields || {})))];
  return records.map((record) => ({
    ...(includeCategory ? { 行业类目: record.categoryPath } : {}),
    当前排名: record.rank,
    趋势原文: record.trendText,
    上升名次: record.riseCount ?? '',
    商品名称: record.productName,
    '价格/价格带': record.priceRange,
    商品链接: record.productUrl,
    店铺名称: record.shopName,
    ...Object.fromEntries(metricFields.map(([header, key]) => [header, record[key] || ''])),
    页面号: record.page,
    页内序号: record.rowIndex,
    ...Object.fromEntries(extraHeaders.map((header) => [header, record.extraFields?.[header] || ''])),
  }));
}

function buildFailureRows(task) {
  return task.failures.map((failure) => ({
    行业类目: failure.categoryPath || '',
    榜单类型: failure.rankingType || '',
    页面号: failure.page || '',
    阶段: failure.stage || '',
    错误原因: failure.error || '',
    重试次数: failure.retries ?? '',
    记录时间: formatBeijingDateTime(failure.at),
  }));
}

function worksheetName(rankingType) {
  return `${String(rankingType || '榜单').replace(/[\\/*?:[\]]/g, '').slice(0, 29)}明细`.slice(0, 31);
}

function appendRankingWorksheet(workbook, task, rankingType) {
  const rows = buildDetailRows(task, rankingType);
  const fallbackHeaders = ['当前排名', '趋势原文', '上升名次', '商品名称', '价格/价格带', '商品链接', '店铺名称', '页面号', '页内序号'];
  const headers = Object.keys(rows[0] || {}).length ? Object.keys(rows[0]) : fallbackHeaders;
  const sheet = workbook.addWorksheet(worksheetName(rankingType), { views: [{ state: 'frozen', ySplit: 6 }] });
  const combinations = task.combinations.filter((item) => item.rankingType === rankingType);
  const categories = [...new Set(combinations.map((item) => item.category.displayPath))];
  const failures = task.failures.filter((item) => item.rankingType === rankingType).length;
  const totals = combinations.reduce((sum, item) => ({
    scanned: sum.scanned + (item.scanned || 0),
    up: sum.up + (item.up || 0),
    first: sum.first + (item.first || 0),
    excluded: sum.excluded + (item.excluded || 0),
    unparseable: sum.unparseable + (item.unparseable || 0),
    saved: sum.saved + (item.saved || 0),
  }), { scanned: 0, up: 0, first: 0, excluded: 0, unparseable: 0, saved: 0 });
  const infoRows = [
    ['采集时间', formatBeijingDateTime(task.completedAt || task.createdAt)],
    ['品类', categories.join('；') || ''],
    ['筛选', `品牌类型：${task.parameters.brandType}；榜单：${rankingType}`],
    ['采集统计', `扫描 ${totals.scanned}；上升 ${totals.up}；首次上榜 ${totals.first}；排除 ${totals.excluded}；无法解析 ${totals.unparseable}；保存 ${rows.length || totals.saved}；失败 ${failures}`],
  ];
  const maxColumn = Math.max(6, headers.length);
  infoRows.forEach(([label, value], index) => {
    const rowNumber = index + 1;
    sheet.getCell(rowNumber, 1).value = label;
    sheet.getCell(rowNumber, 2).value = value;
    sheet.mergeCells(rowNumber, 2, rowNumber, maxColumn);
    sheet.getCell(rowNumber, 1).font = { bold: true };
    sheet.getCell(rowNumber, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EDF2' } };
    sheet.getCell(rowNumber, 2).alignment = { vertical: 'middle', wrapText: true };
  });
  sheet.getRow(5).height = 8;
  sheet.getRow(6).values = headers;
  sheet.getRow(6).font = { bold: true };
  sheet.getRow(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
  rows.forEach((row) => sheet.addRow(headers.map((header) => row[header] ?? '')));
  headers.forEach((header, index) => {
    const values = rows.map((row) => String(row[header] ?? ''));
    const width = Math.max(header.length * 2 + 2, ...values.slice(0, 100).map((value) => Math.min(45, value.length + 2)), 12);
    sheet.getColumn(index + 1).width = Math.min(45, width);
  });
  if (headers.length) sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: Math.max(6, rows.length + 6), column: headers.length } };
  const linkColumn = headers.indexOf('商品链接') + 1;
  if (linkColumn > 0) {
    rows.forEach((row, index) => {
      if (!row.商品链接) return;
      const cell = sheet.getCell(index + 7, linkColumn);
      cell.value = { text: row.商品链接, hyperlink: row.商品链接, tooltip: '打开商品' };
      cell.font = { color: { argb: 'FF1966FF' }, underline: true };
    });
  }
  return { sheet, headers, rows };
}

function appendWorksheet(workbook, name, rows, fallbackHeaders) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = Object.keys(rows[0] || {}).length ? Object.keys(rows[0]) : fallbackHeaders;
  sheet.columns = headers.map((header, index) => ({
    header,
    key: `column${index}`,
    width: Math.min(45, Math.max(12, header.length * 2 + 2, ...rows.slice(0, 100).map((row) => String(row[header] ?? '').length + 2))),
  }));
  rows.forEach((row) => {
    sheet.addRow(Object.fromEntries(headers.map((header, index) => [`column${index}`, row[header] ?? ''])));
  });
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EDF2' } };
  if (headers.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
  return { sheet, headers };
}

async function exportTask(task) {
  const stamp = safeFileStamp(task.completedAt || task.createdAt);
  const base = `TOP200-${stamp}-${task.taskId}`;
  const jsonPath = path.join(REPORT_DIR, `${base}.json`);
  const xlsxPath = path.join(REPORT_DIR, `${base}.xlsx`);

  atomicWriteJson(jsonPath, task);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '抖音商品 TOP200 采集系统';
  workbook.created = new Date(task.createdAt);
  const summaryRows = buildSummaryRows(task);
  const failureRows = buildFailureRows(task);
  appendWorksheet(workbook, '任务汇总', summaryRows, ['开始时间', '结束时间', '行业类目', '品牌类型', '榜单类型', '状态', '扫描数量', '上升数量', '首次上榜数量', '排除数量', '解析异常', '失败原因']);
  for (const rankingType of task.parameters.rankingTypes) appendRankingWorksheet(workbook, task, rankingType);
  appendWorksheet(workbook, '失败记录', failureRows, ['行业类目', '榜单类型', '页面号', '阶段', '错误原因', '重试次数', '记录时间']);
  await workbook.xlsx.writeFile(xlsxPath);
  if (!fs.existsSync(jsonPath) || !fs.existsSync(xlsxPath)) throw new Error('报告文件生成失败');
  return { jsonPath, xlsxPath };
}

module.exports = { formatBeijingDateTime, buildSummaryRows, buildDetailRows, buildFailureRows, worksheetName, exportTask };
