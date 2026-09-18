'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { escapeMarkdownCell } = require('./collect_utils');
const { generateExcelReport } = require('./export_excel');
const { countClassified } = require('./growth_prefilter');
const { groupProducts } = require('./product_grouping');

function reportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function completionLabel(completion) {
  if (completion?.status !== 'partial') return '完整结果';
  return `部分结果（${completion.message || '采集提前结束'}）`;
}

function formatBound(value) {
  return `¥${Number(value).toLocaleString('zh-CN')}`;
}

function itemCategory(item, payload) {
  return item.categoryPath || payload.categoryLabel || '';
}

function buildMarkdown(payload) {
  const {
    categoryLabel,
    minSales,
    maxSales,
    results = [],
    qualifyingCount = 0,
    elapsedSeconds = 0,
    failures = [],
    unparseableItems = [],
    stats = {},
    outputTime,
    completion = { status: 'complete', coverageComplete: true },
  } = payload;
  const classifiedCount = countClassified(stats);
  const groupedResults = groupProducts(results);
  const rangeText = maxSales == null
    ? `${formatBound(minSales)} 以上`
    : `${formatBound(minSales)}—${formatBound(maxSales)}`;
  const totalCategories = payload.totalCategories || payload.categoryLabels?.length || 1;
  const completedCategories = payload.completedCategories ?? (completion.coverageComplete ? totalCategories : 0);
  const title = payload.taskName || categoryLabel || '成交增长采集任务';
  const categorySummary = totalCategories > 1 ? `${totalCategories} 个类目（合并报告）` : categoryLabel;
  const lines = [
    `# ${title} — 成交增长选品报告${completion.status === 'partial' ? '（部分结果）' : ''}`,
    '',
    `> 采集时间: ${outputTime.toLocaleString('zh-CN')}`,
    `> 品类: ${categorySummary}`,
    `> 筛选: 近30天成交金额展示档位完整落入 ${rangeText}，今日成交 > 昨日`,
    `> 近30天预筛选: ${payload.only30dGrowth ? '已启用（仅红色向上箭头）' : '未启用'}`,
    `> 采集状态: ${completionLabel(completion)}`,
    `> 区间覆盖: ${completion.coverageComplete ? '已完成' : '未完成'}`,
  ];
  if (payload.taskId) lines.push(`> 任务编号: ${payload.taskId}`);
  if (payload.totalCategories || payload.categoryLabels) lines.push(`> 类目进度: ${completedCategories}/${totalCategories}`);
  const prefilterStats = payload.only30dGrowth
    ? ` | 预筛选通过: ${stats.prefilterPassed || 0} 条 | 预筛选跳过: ${stats.prefilterSkipped || 0} 条 | 实际打开详情: ${stats.detailsOpened || 0} 条`
    : '';
  lines.push(`> 采集: ${qualifyingCount} 条${prefilterStats} | 正常增长: ${stats.normal || 0} 条 | 增速快: ${stats.fast || 0} 条 | 下跌: ${stats.down || 0} 条 | 持平: ${stats.flat || 0} 条 | 无法解析: ${stats.unparseable || 0} 条 | 重试成功: ${stats.retrySuccess || 0} 条 | 三次后无数据: ${stats.unavailable || 0} 条 | 完整性: ${classifiedCount}/${qualifyingCount} | 耗时: ${elapsedSeconds} 秒`);

  if (completion.status === 'partial') {
    lines.push(`> 停止原因: ${completion.message || completion.reason || '采集提前结束'}`);
    if (completion.stoppedAtPage) lines.push(`> 停止页码: 第 ${completion.stoppedAtPage} 页`);
  }
  if (payload.combinations?.length) {
    lines.push('', '## 类目执行情况', '', '| 类目 | 状态 | 达标 | 结果 | 失败 | 区间覆盖 |', '|------|------|------|------|------|----------|');
    for (const combination of payload.combinations) {
      lines.push(`| ${escapeMarkdownCell(combination.category?.displayPath)} | ${escapeMarkdownCell(combination.status)} | ${combination.qualifyingCount || 0} | ${combination.resultCount || 0} | ${combination.failureCount || 0} | ${combination.coverageComplete ? '已完成' : '未完成'} |`);
    }
  }

  lines.push('', '## 成交增长明细', '', '| # | 产品分组 | 类目 | 产品名称 | 近30天总成交 | 昨日成交 | 今日成交 | 较昨日增长 |', '|---|----------|------|----------|-------------|----------|----------|------------|');
  groupedResults.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${escapeMarkdownCell(item.productGroup)} | ${escapeMarkdownCell(itemCategory(item, payload))} | ${escapeMarkdownCell(item.keyword)} | ${escapeMarkdownCell(item.totalSales)} | ${escapeMarkdownCell(item.yesterday)} | ${escapeMarkdownCell(item.today)} | ${escapeMarkdownCell(item.growth)} |`);
  });
  if (unparseableItems.length) {
    lines.push('', '## 无法解析', '', '| 类目 | 产品名称 | 原因 |', '|------|----------|------|');
    unparseableItems.forEach((item) => lines.push(`| ${escapeMarkdownCell(itemCategory(item, payload))} | ${escapeMarkdownCell(item.keyword)} | ${escapeMarkdownCell(item.reason)} |`));
  }
  if (failures.length) {
    lines.push('', '## 未完成采集', '', '| 类目 | 产品名称 | 原因 |', '|------|----------|------|');
    failures.forEach((item) => {
      const page = item.page ? `第${item.page}页，` : '';
      const attempts = item.attempts ? `尝试${item.attempts}次：` : '';
      lines.push(`| ${escapeMarkdownCell(itemCategory(item, payload))} | ${escapeMarkdownCell(item.keyword || '-')} | ${escapeMarkdownCell(`${page}${attempts}${item.reason || item.error || '-'}`)} |`);
    });
  }
  return `${lines.join('\n')}\n`;
}

function taskWorkerPayload(payload) {
  if (!process.env.RESULT_FILE && process.env.SKIP_REPORT !== '1') return payload;
  const categoryPath = process.env.CATEGORY_PATH || process.env.CATEGORY_LABEL || payload.categoryLabel;
  if (!categoryPath) return payload;
  const tag = (item) => ({ ...item, categoryPath: item.categoryPath || categoryPath });
  return {
    ...payload,
    categoryLabel: categoryPath,
    results: (payload.results || []).map(tag),
    failures: (payload.failures || []).map(tag),
    unparseableItems: (payload.unparseableItems || []).map(tag),
  };
}

async function saveReports(inputPayload, rootDir = __dirname) {
  let payload = taskWorkerPayload(inputPayload);
  if (process.env.RESULT_FILE) fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  if (process.env.SKIP_REPORT === '1') {
    return { archivePath: process.env.RESULT_FILE, latestPath: process.env.RESULT_FILE, jsonPath: process.env.RESULT_FILE, xlsxPath: null, partial: payload.completion?.status === 'partial' };
  }
  payload = { ...payload, results: groupProducts(payload.results || []) };
  const reportDir = path.join(rootDir, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const partial = payload.completion?.status === 'partial';
  const timestamp = reportTimestamp(payload.outputTime);
  const stem = partial ? '成交增长-部分' : '成交增长';
  const latestStem = partial ? '选品报告-成交增长-部分' : '选品报告-成交增长';
  const markdown = buildMarkdown(payload);
  const archivePath = path.join(reportDir, `${stem}-${timestamp}.md`);
  const latestPath = path.join(rootDir, `${latestStem}.md`);
  const jsonPath = path.join(reportDir, `${stem}-${timestamp}.json`);
  const xlsxPath = path.join(rootDir, `${latestStem}.xlsx`);
  fs.writeFileSync(archivePath, markdown, 'utf8');
  fs.writeFileSync(latestPath, markdown, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  await generateExcelReport(payload, xlsxPath);
  return { archivePath, latestPath, jsonPath, xlsxPath, partial };
}

module.exports = { buildMarkdown, completionLabel, reportTimestamp, saveReports, taskWorkerPayload };
