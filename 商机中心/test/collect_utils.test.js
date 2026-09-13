const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRange,
  parseRangeStrict,
  parseGrowth,
  calcYesterday,
  escapeMarkdownCell,
  classifySalesBand,
  validateSalesBounds,
} = require('../collect_utils');

test('解析人民币区间及万、亿单位', () => {
  assert.deepEqual(parseRange('¥1万-¥1.5万'), { min: 10000, max: 15000 });
  assert.deepEqual(parseRange('¥2.5亿-¥3亿'), { min: 250000000, max: 300000000 });
  assert.deepEqual(parseRange('小于¥50'), { min: 0, max: 50 });
});

test('普通增长可反推昨日成交区间', () => {
  assert.equal(calcYesterday('¥1万-¥1.5万', 25), '¥8000-1.2万');
});

test('增速快和封顶增长不生成伪精确昨日成交额', () => {
  assert.deepEqual(parseGrowth('增速快'), { kind: 'fast', percent: null, display: '增速快' });
  assert.deepEqual(parseGrowth('999.99%+'), { kind: 'lower-bound', percent: 999.99, display: '>999.99%' });
  assert.equal(calcYesterday('¥10万-¥25万', parseGrowth('999.99%+')), '小于¥2.3万（增幅>999.99%）');
});

test('Markdown 单元格会转义竖线和换行', () => {
  assert.equal(escapeMarkdownCell('沙棘|原浆\n礼盒'), '沙棘\\|原浆 礼盒');
});

test('金额档位必须完整落入设置区间才采集', () => {
  const bounds = { minSales: 10000, maxSales: 250000 };
  assert.equal(classifySalesBand('¥25万-¥50万', bounds), 'above');
  assert.equal(classifySalesBand('¥10万-¥25万', bounds), 'within');
  assert.equal(classifySalesBand('¥1万-¥1.5万', bounds), 'within');
  assert.equal(classifySalesBand('¥7500-¥1万', bounds), 'below');
});

test('金额区间包含上下边界并支持不设置最高金额', () => {
  assert.equal(classifySalesBand('¥1万', { minSales: 10000, maxSales: 10000 }), 'within');
  assert.equal(classifySalesBand('¥1000万-¥2500万', { minSales: 10000, maxSales: null }), 'within');
});

test('严格金额解析不会把空值和乱码当成零元', () => {
  assert.equal(parseRangeStrict(''), null);
  assert.equal(parseRangeStrict('-'), null);
  assert.equal(parseRangeStrict('加载中'), null);
  assert.deepEqual(parseRangeStrict('小于¥50'), { min: 0, max: 50 });
  assert.equal(parseRangeStrict('¥2万-¥1万'), null);
});

test('金额上下限校验保留合法的零并拒绝倒置区间', () => {
  assert.deepEqual(validateSalesBounds(0, ''), { ok: true, minSales: 0, maxSales: null });
  assert.deepEqual(validateSalesBounds('10000', '250000'), { ok: true, minSales: 10000, maxSales: 250000 });
  assert.equal(validateSalesBounds(250000, 10000).ok, false);
  assert.equal(validateSalesBounds(-1, 10000).ok, false);
  assert.equal(validateSalesBounds('abc', 10000).ok, false);
});
