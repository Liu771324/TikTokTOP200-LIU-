'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('历史任务和结果下拉框使用可读任务名称并保留 taskId 提示', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<th>任务名称<\/th>/);
  assert.match(html, /t\.taskName/);
  assert.match(html, /title="\$\{escapeHtml\(t\.taskId\)\}"/);
  assert.doesNotMatch(html, /<option value="\$\{t\.taskId\}">\$\{t\.taskId\}<\/option>/);
});
