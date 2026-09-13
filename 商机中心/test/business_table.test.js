const test = require('node:test');
const assert = require('node:assert/strict');

const {
  areSalesValuesDescending,
  findBusinessTable,
} = require('../business_table');

test('findBusinessTable locates the sales table even when it is the only tbody', () => {
  const tables = [{
    index: 0,
    headers: ['搜索词', '热卖商品参考', '热度', '成交金额', '成交增速'],
  }];

  assert.equal(findBusinessTable(tables).index, 0);
});

test('findBusinessTable ignores unrelated tables instead of relying on a fixed index', () => {
  const tables = [
    { index: 0, headers: ['热搜榜'] },
    { index: 1, headers: ['类目榜'] },
    { index: 2, headers: ['热卖榜'] },
    { index: 3, headers: ['搜索词', '成交金额', '成交增速'] },
  ];

  assert.equal(findBusinessTable(tables).index, 3);
});

test('areSalesValuesDescending accepts equal bands but rejects an ascending step', () => {
  assert.equal(areSalesValuesDescending([
    '¥7500万-¥1亿',
    '¥5000万-¥7500万',
    '¥5000万-¥7500万',
  ]), true);
  assert.equal(areSalesValuesDescending([
    '¥5000万-¥7500万',
    '¥7500万-¥1亿',
    '¥2500万-¥5000万',
  ]), false);
});
