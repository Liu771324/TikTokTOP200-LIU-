'use strict';

function decideGrowthPrefilter(enabled, growthTrend) {
  if (!enabled) return { openDetail: true, reason: 'disabled' };
  if (growthTrend === 'up') return { openDetail: true, reason: 'up' };
  return { openDetail: false, reason: growthTrend || 'unknown' };
}

function ensureGrowthColumn(table, enabled) {
  if (enabled && !(table?.growthColumnIndex >= 0)) {
    throw new Error('已开启近30天预筛选，但商机数据表缺少“成交增速”列');
  }
}

function countClassified(stats = {}) {
  return ['normal', 'fast', 'down', 'flat', 'unparseable', 'unavailable', 'prefilterSkipped']
    .reduce((sum, key) => sum + (stats[key] || 0), 0);
}

module.exports = { countClassified, decideGrowthPrefilter, ensureGrowthColumn };
