const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { generateExcelFromMarkdown } = require('../export_excel');
const { buildMarkdown, saveReports } = require('../report_output');

function payload(overrides = {}) {
  return {
    categoryLabel: '传统滋补/测试类目',
    minSales: 10000,
    maxSales: 250000,
    results: [{ keyword: '测试商品', totalSales: '¥10万-¥25万', yesterday: '¥1万', today: '¥2万', growth: '100%' }],
    qualifyingCount: 1,
    elapsedSeconds: 12,
    failures: [],
    unparseableItems: [],
    stats: { normal: 1, fast: 0, down: 0, flat: 0, unparseable: 0, unavailable: 0, retrySuccess: 0 },
    outputTime: new Date('2026-08-13T06:00:00Z'),
    completion: { status: 'partial', reason: 'user-stopped', message: '用户手动停止', coverageComplete: false, stoppedAtPage: 6 },
    ...overrides,
  };
}

test('部分报告明确区分已处理完整性与区间覆盖', () => {
  const markdown = buildMarkdown(payload());
  assert.match(markdown, /> 采集状态: 部分结果（用户手动停止）/);
  assert.match(markdown, /> 区间覆盖: 未完成/);
  assert.match(markdown, /完整性: 1\/1/);
  assert.match(markdown, /近30天成交金额展示档位完整落入 ¥10,000—¥250,000/);
});

test('部分报告的状态会进入 Excel 头部', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-center-report-'));
  const mdPath = path.join(dir, 'partial.md');
  const xlsxPath = path.join(dir, 'partial.xlsx');
  fs.writeFileSync(mdPath, buildMarkdown(payload()), 'utf8');
  await generateExcelFromMarkdown(mdPath, xlsxPath);

  const workbook = XLSX.readFile(xlsxPath);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['成交增长'], { header: 1 });
  assert.deepEqual(rows[0], ['采集时间', '2026/8/13 14:00:00']);
  assert.deepEqual(rows[3], ['采集状态', '部分结果（用户手动停止）']);
  assert.deepEqual(rows[4], ['区间覆盖', '未完成']);
  const styledWorkbook = new ExcelJS.Workbook();
  await styledWorkbook.xlsx.readFile(xlsxPath);
  const styledSheet = styledWorkbook.getWorksheet('成交增长');
  assert.equal(styledSheet.getCell('A1').fill.fgColor.argb, 'FFE9EDF2');
  assert.equal(styledSheet.getCell('A8').fill.fgColor.argb, 'FFDCE6F1');
  assert.equal(styledSheet.getCell('B1').isMerged, true);
  assert.equal(styledSheet.views[0].state, 'frozen');
  assert.equal(styledSheet.views[0].ySplit, 8);
  assert.match(styledSheet.autoFilter, /^A8:G/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('部分报告使用独立文件且不覆盖上一份完整报告', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-center-save-'));
  const fullMd = path.join(dir, '选品报告-成交增长.md');
  const fullXlsx = path.join(dir, '选品报告-成交增长.xlsx');
  fs.writeFileSync(fullMd, '上一份完整报告', 'utf8');
  fs.writeFileSync(fullXlsx, '上一份完整 Excel', 'utf8');
  const paths = await saveReports(payload(), dir);
  assert.equal(fs.readFileSync(fullMd, 'utf8'), '上一份完整报告');
  assert.equal(fs.readFileSync(fullXlsx, 'utf8'), '上一份完整 Excel');
  assert.equal(path.basename(paths.latestPath), '选品报告-成交增长-部分.md');
  assert.equal(path.basename(paths.xlsxPath), '选品报告-成交增长-部分.xlsx');
  assert.match(path.basename(paths.archivePath), /^成交增长-部分-/);
  assert.match(path.basename(paths.jsonPath), /^成交增长-部分-/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('多类目合并报告包含类目列、进度和三个 Excel 工作表', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-center-batch-report-'));
  const batch = payload({
    taskId: 'business-test',
    taskName: '测试批量任务',
    categoryLabels: ['传统滋补 / 药食同源食品', '传统滋补 / 枸杞及其制品'],
    completedCategories: 1,
    totalCategories: 2,
    results: [
      { keyword: '茯苓', categoryPath: '传统滋补 / 药食同源食品', totalSales: '¥10万-¥25万', yesterday: '¥1万', today: '¥2万', growth: '100%' },
    ],
    failures: [
      { keyword: '枸杞', categoryPath: '传统滋补 / 枸杞及其制品', page: 2, attempts: 3, reason: '详情未加载' },
    ],
    completion: { status: 'partial', reason: 'user-stopped', message: '用户手动停止', coverageComplete: false },
  });
  const markdown = buildMarkdown(batch);
  assert.match(markdown, /> 类目进度: 1\/2/);
  assert.match(markdown, /\| # \| 类目 \| 产品名称 \|/);
  assert.match(markdown, /传统滋补 \/ 药食同源食品/);
  const paths = await saveReports(batch, dir);
  const workbook = XLSX.readFile(paths.xlsxPath);
  assert.deepEqual(workbook.SheetNames, ['采集汇总', '成交增长', '失败记录']);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['成交增长'], { header: 1 });
  assert.deepEqual(rows[0].slice(0, 3), ['#', '类目', '产品名称']);
  assert.equal(rows[1][1], '传统滋补 / 药食同源食品');
  const styledWorkbook = new ExcelJS.Workbook();
  await styledWorkbook.xlsx.readFile(paths.xlsxPath);
  const summarySheet = styledWorkbook.getWorksheet('采集汇总');
  const resultSheet = styledWorkbook.getWorksheet('成交增长');
  assert.equal(summarySheet.getCell('A1').fill.fgColor.argb, 'FFE9EDF2');
  assert.equal(summarySheet.getCell('A4').fill.fgColor.argb, 'FFDCE6F1');
  assert.equal(summarySheet.views[0].ySplit, 4);
  assert.equal(resultSheet.getCell('A1').fill.fgColor.argb, 'FFDCE6F1');
  assert.equal(resultSheet.views[0].ySplit, 1);
  assert.match(resultSheet.autoFilter, /^A1:G/);
  fs.rmSync(dir, { recursive: true, force: true });
});
