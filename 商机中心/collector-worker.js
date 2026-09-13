'use strict';

const fs = require('node:fs');
const reportOutput = require('./report_output');

const originalSaveReports = reportOutput.saveReports;

reportOutput.saveReports = (payload, rootDir) => {
  const categoryPath = process.env.CATEGORY_PATH || process.env.CATEGORY_LABEL || payload.categoryLabel;
  const tag = (item) => ({ ...item, categoryPath });
  const tagged = {
    ...payload,
    categoryLabel: categoryPath,
    results: (payload.results || []).map(tag),
    failures: (payload.failures || []).map(tag),
    unparseableItems: (payload.unparseableItems || []).map(tag),
  };
  if (process.env.RESULT_FILE) {
    fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(tagged, null, 2), 'utf8');
  }
  if (process.env.SKIP_REPORT === '1') {
    return { latestPath: process.env.RESULT_FILE, archivePath: process.env.RESULT_FILE, jsonPath: process.env.RESULT_FILE, xlsxPath: null, partial: tagged.completion?.status === 'partial' };
  }
  return originalSaveReports(tagged, rootDir);
};

require('./collect_v4');
