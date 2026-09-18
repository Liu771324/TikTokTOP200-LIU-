const test = require('node:test');
const assert = require('node:assert/strict');

const {
  areSalesValuesDescending,
  classifyGrowthTrend,
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

test('成交增速方向只读取趋势 DOM 状态而不读取百分比正负号', () => {
  assert.equal(classifyGrowthTrend({ classNames: 'trendArrowUp trendValuePositive', labels: '', text: '25.4%' }), 'up');
  assert.equal(classifyGrowthTrend({ classNames: 'trendArrowDown trendValueNegative', labels: '', text: '25.4%' }), 'down');
  assert.equal(classifyGrowthTrend({ classNames: '', labels: '', text: '-25.4%' }), 'unknown');
});

test('真实列表 SVG 使用红色向上和绿色向下箭头表达方向', () => {
  assert.equal(classifyGrowthTrend({ arrowFills: ['#FF3B52'], text: '1.08%' }), 'up');
  assert.equal(classifyGrowthTrend({ arrowFills: ['#00C87F'], text: '50.41%' }), 'down');
});
