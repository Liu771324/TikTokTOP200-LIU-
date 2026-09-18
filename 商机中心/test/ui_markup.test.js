const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('页面提供默认不勾选的近30天增长预筛选并提交布尔参数', () => {
  const checkbox = html.match(/<input[^>]+id="only30dGrowth"[^>]*>/)?.[0] || '';
  assert.match(checkbox, /type="checkbox"/);
  assert.doesNotMatch(checkbox, /\schecked(?:\s|=|>)/);
  assert.match(html, /only30dGrowth:el\('only30dGrowth'\)\.checked/);
});
