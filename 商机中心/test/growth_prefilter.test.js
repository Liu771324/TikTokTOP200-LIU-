const test = require('node:test');
const assert = require('node:assert/strict');
const { countClassified, decideGrowthPrefilter, ensureGrowthColumn } = require('../growth_prefilter');

test('预筛选关闭时所有金额达标商品仍打开详情', () => {
  assert.deepEqual(decideGrowthPrefilter(false, 'unknown'), { openDetail: true, reason: 'disabled' });
});

test('预筛选开启时只有红色向上趋势进入详情', () => {
  assert.equal(decideGrowthPrefilter(true, 'up').openDetail, true);
  assert.equal(decideGrowthPrefilter(true, 'down').openDetail, false);
  assert.equal(decideGrowthPrefilter(true, 'flat').openDetail, false);
  assert.equal(decideGrowthPrefilter(true, 'unknown').openDetail, false);
});

test('预筛选开启但缺少成交增速列时明确失败', () => {
  assert.throws(
    () => ensureGrowthColumn({ growthColumnIndex: -1 }, true),
    /缺少“成交增速”列/,
  );
  assert.doesNotThrow(() => ensureGrowthColumn({ growthColumnIndex: -1 }, false));
});

test('预筛选跳过计入完整性但不计入详情失败', () => {
  const stats = {
    normal: 1,
    fast: 0,
    down: 0,
    flat: 0,
    unparseable: 0,
    unavailable: 0,
    prefilterSkipped: 2,
  };

  assert.equal(countClassified(stats), 3);
  assert.equal(stats.unavailable, 0);
});
