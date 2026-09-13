function parseNumber(text) {
  const value = String(text ?? '').trim();
  if (!value) return 0;
  if (value.includes('亿')) return Number.parseFloat(value.replace('亿', '')) * 100000000;
  if (value.includes('万')) return Number.parseFloat(value.replace('万', '')) * 10000;
  return Number.parseFloat(value);
}

function parseRange(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw === '-') return { min: 0, max: 0 };
  const cleaned = raw.replace(/¥/g, '').replace(/,/g, '');
  if (cleaned.includes('小于')) {
    const max = parseNumber(cleaned.replace('小于', ''));
    return { min: 0, max: Number.isFinite(max) ? max : 0 };
  }

  const parts = cleaned.split('-').map(parseNumber);
  if (parts.length === 2 && parts.every(Number.isFinite)) {
    return { min: parts[0], max: parts[1] };
  }
  const value = parts[0];
  return Number.isFinite(value) ? { min: value, max: value } : { min: 0, max: 0 };
}

function parseRangeStrict(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw === '-') return null;

  const cleaned = raw.replace(/¥/g, '').replace(/,/g, '').replace(/\s+/g, '');
  const numberPattern = '\\d+(?:\\.\\d+)?(?:万|亿)?';
  let match = cleaned.match(new RegExp(`^小于(${numberPattern})$`));
  if (match) {
    const max = parseNumber(match[1]);
    return Number.isFinite(max) ? { min: 0, max } : null;
  }

  match = cleaned.match(new RegExp(`^(${numberPattern})(?:-(${numberPattern}))?$`));
  if (!match) return null;
  const min = parseNumber(match[1]);
  const max = parseNumber(match[2] || match[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min, max };
}

function validateSalesBounds(minValue, maxValue) {
  if (minValue === '' || minValue == null) {
    return { ok: false, message: '最低金额不能为空' };
  }
  const minSales = Number(minValue);
  if (!Number.isFinite(minSales) || minSales < 0) {
    return { ok: false, message: '最低金额必须是大于或等于 0 的有限数字' };
  }

  const hasMax = maxValue !== '' && maxValue != null;
  const maxSales = hasMax ? Number(maxValue) : null;
  if (hasMax && (!Number.isFinite(maxSales) || maxSales < 0)) {
    return { ok: false, message: '最高金额必须是大于或等于 0 的有限数字' };
  }
  if (maxSales != null && minSales > maxSales) {
    return { ok: false, message: '最低金额不能高于最高金额' };
  }
  return { ok: true, minSales, maxSales };
}

function classifySalesBand(text, bounds) {
  const range = parseRangeStrict(text);
  if (!range) return 'invalid';
  if (bounds.maxSales != null && range.max > bounds.maxSales) return 'above';
  if (range.min < bounds.minSales) return 'below';
  return 'within';
}

function parseGrowth(text) {
  const raw = String(text ?? '').trim();
  if (raw === '增速快') return { kind: 'fast', percent: null, display: '增速快' };
  if (raw === '持平') return { kind: 'flat', percent: 0, display: '0%' };

  const lowerBound = raw.endsWith('+');
  const percent = Number.parseFloat(raw.replace(/[+%]/g, ''));
  if (!Number.isFinite(percent)) return { kind: 'invalid', percent: null, display: raw };
  if (percent <= 0) return { kind: 'non-positive', percent, display: raw };
  if (lowerBound) return { kind: 'lower-bound', percent, display: `>${percent}%` };
  return { kind: 'normal', percent, display: `${percent}%` };
}

function formatNum(value) {
  if (value >= 100000000) return `${trimZeros(value / 100000000)}亿`;
  if (value >= 10000) return `${trimZeros(value / 10000)}万`;
  return String(Math.round(value));
}

function trimZeros(value) {
  return Number(value.toFixed(1)).toString();
}

function formatRange(range) {
  if (range.min === range.max) return `¥${formatNum(range.min)}`;
  return `¥${formatNum(range.min)}-${formatNum(range.max)}`;
}

function calcYesterday(todayText, growth) {
  const parsedGrowth = typeof growth === 'number'
    ? { kind: 'normal', percent: growth, display: `${growth}%` }
    : growth;
  const today = parseRange(todayText);
  if (!parsedGrowth || !Number.isFinite(parsedGrowth.percent) || parsedGrowth.percent <= 0) return '-';

  const factor = 1 + parsedGrowth.percent / 100;
  if (parsedGrowth.kind === 'lower-bound') {
    return `小于¥${formatNum(today.max / factor)}（增幅${parsedGrowth.display}）`;
  }
  if (parsedGrowth.kind !== 'normal') return '-';
  return formatRange({ min: today.min / factor, max: today.max / factor });
}

function escapeMarkdownCell(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
}

module.exports = {
  calcYesterday,
  escapeMarkdownCell,
  formatNum,
  formatRange,
  parseGrowth,
  parseRange,
  parseRangeStrict,
  classifySalesBand,
  validateSalesBounds,
};
