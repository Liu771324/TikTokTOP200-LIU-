'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('每个组合先切换榜单，再设置并校验目标行业类目', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'collector.js'), 'utf8');
  const start = source.indexOf('async function collectCombination');
  const end = source.indexOf('const period = await selectPreferredPeriod(page);', start);
  const setup = source.slice(start, end);
  const rankingIndex = setup.indexOf('await selectRanking(page, combination.rankingType);');
  const categoryIndex = setup.indexOf('await selectCategory(page, combination.category);');
  assert.ok(rankingIndex >= 0 && categoryIndex >= 0);
  assert.ok(rankingIndex < categoryIndex, '榜单切换可能重置类目，因此必须在切榜后重新设置并校验类目');
});
