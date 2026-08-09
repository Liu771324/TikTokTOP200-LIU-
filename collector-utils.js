'use strict';

const BASE_FIXED_HEADERS = new Map([
  ['商品', 'productName'],
  ['商品信息', 'productName'],
  ['店铺名称', 'shopName'],
  ['店铺信息', 'shopName'],
]);

const GENERIC_METRIC_HEADERS = new Map([
  ['用户支付金额', 'userPaymentAmount'],
  ['点击次数', 'clickCount'],
  ['成交件数', 'orderCount'],
  ['商品成交件数', 'orderCount'],
  ['点击成交转化率', 'clickConversionRate'],
]);

const GENERIC_METRIC_RANKINGS = new Set(['总榜', '商品卡榜', '达人带货榜']);

const ACTION_HEADERS = new Set(['操作']);
const CONTEXT_ONLY_HEADERS = new Set(['直播账号', '带货账号', '带货短视频']);

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseTrend(snapshot = {}) {
  const text = cleanText(snapshot.text);
  const valueText = cleanText(snapshot.valueText);
  const classes = cleanText(snapshot.classes).toLowerCase();

  if (snapshot.first || text.includes('首次上榜')) {
    return { trendType: 'first', trendText: '首次上榜', riseCount: null };
  }
  if (snapshot.up || /(^|[-_\s])up([-_\s]|$)|upidentify/.test(classes)) {
    const match = valueText.match(/\d+/) || text.match(/\d+/);
    if (!match) return { trendType: 'unparseable', trendText: text || valueText, riseCount: null };
    const riseCount = Number(match[0]);
    return { trendType: 'up', trendText: `↑ ${riseCount}`, riseCount };
  }
  if (snapshot.down || /(^|[-_\s])down([-_\s]|$)|downidentify/.test(classes)) {
    return { trendType: 'down', trendText: valueText ? `↓ ${valueText}` : text, riseCount: null };
  }
  if (snapshot.equal || text.includes('持平') || classes.includes('equal')) {
    return { trendType: 'equal', trendText: '持平', riseCount: null };
  }
  if (!text || text === '-' || valueText === '-') {
    return { trendType: 'none', trendText: text || valueText || '', riseCount: null };
  }
  return { trendType: 'unparseable', trendText: text || valueText, riseCount: null };
}

function trendSnapshotFromHtml(markup) {
  const html = String(markup || '');
  const classes = Array.from(html.matchAll(/class=["']([^"']+)["']/gi)).map((match) => match[1]).join(' ');
  const valueMatch = html.match(/class=["'][^"']*(?:cp-change-ratio-value|value-[^"']*)[^"']*["'][^>]*>([^<]*)</i);
  const allText = cleanText(html.replace(/<[^>]+>/g, ' '));
  const first = allText.includes('首次上榜');
  const up = /upidentify|(?:^|[-_\s])up(?:[-_\s]|$)/i.test(classes);
  const down = /downidentify|(?:^|[-_\s])down(?:[-_\s]|$)/i.test(classes);
  const equal = /equal/i.test(classes) || allText.includes('持平');
  const hasTrendContainer = /changeRatioWrap/i.test(classes);
  const hasTrend = first || up || down || equal || hasTrendContainer || Boolean(valueMatch);
  const valueText = cleanText(valueMatch?.[1]);
  const text = !hasTrend ? '' : first ? '首次上榜' : valueText || (equal ? '持平' : '');
  return {
    text,
    valueText,
    classes,
    first,
    up,
    down,
    equal,
  };
}

function selectProductLinkCandidate(candidates = [], productName = '') {
  const expected = cleanText(productName);
  const eligible = candidates.filter((candidate) => {
    const classes = cleanText(candidate.classes).toLowerCase();
    return !/ecom-popover-open|qrcode|qr-code|二维码/.test(classes) && cleanText(candidate.text) && !cleanText(candidate.text).includes('价格带');
  });
  if (!eligible.length) return null;
  return eligible
    .map((candidate) => {
      const text = cleanText(candidate.text);
      const classes = cleanText(candidate.classes).toLowerCase();
      let score = candidate.href ? 20 : 0;
      if (expected && text === expected) score += 100;
      else if (expected && (text.includes(expected) || expected.includes(text))) score += 50;
      if (/name|title/.test(classes)) score += 10;
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score || cleanText(b.text).length - cleanText(a.text).length)[0];
}

function safeProductUrl(url) {
  try {
    const parsed = new URL(cleanText(url));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function inferRank(rankText, pageNumber, rowIndex, pageSize) {
  const explicit = Number(cleanText(rankText));
  if (explicit > 0) return explicit;
  return (Math.max(1, Number(pageNumber) || 1) - 1) * Math.max(1, Number(pageSize) || 1) + Math.max(1, Number(rowIndex) || 1);
}

function choosePeriod(periods = []) {
  const available = periods.filter((period) => !period.disabled);
  const realtime = available.find((period) => period.value === 'realTime' || cleanText(period.label) === '实时');
  if (realtime) return { requestedPeriod: '实时', actualPeriod: cleanText(realtime.label) || '实时', value: realtime.value };
  const oneDay = available.find((period) => period.value === 'one' || cleanText(period.label) === '近1天');
  if (oneDay) return { requestedPeriod: '实时', actualPeriod: cleanText(oneDay.label) || '近1天', value: oneDay.value };
  return null;
}

function normalizeProductUrl(url) {
  const safeUrl = safeProductUrl(url);
  if (!safeUrl) return '';
  try {
    const parsed = new URL(safeUrl);
    const id = parsed.searchParams.get('id');
    return id ? `${parsed.origin}${parsed.pathname}?id=${id}` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function productKey(record) {
  const normalizedUrl = normalizeProductUrl(record.productUrl);
  return normalizedUrl || `${cleanText(record.productName)}\u0000${cleanText(record.shopName)}`;
}

function mapBusinessFields(headers, cellTexts, rankingType = '') {
  const mapped = {
    productName: '',
    shopName: '',
    userPaymentAmount: '',
    clickCount: '',
    clickConversionRate: '',
    orderCount: '',
    extraFields: {},
  };
  const fixedHeaders = new Map(BASE_FIXED_HEADERS);
  if (!rankingType || GENERIC_METRIC_RANKINGS.has(rankingType)) {
    for (const [header, field] of GENERIC_METRIC_HEADERS) fixedHeaders.set(header, field);
  }
  headers.forEach((header, index) => {
    const name = cleanText(header);
    const value = cleanText(cellTexts[index]);
    if (!name || name === '排名' || name === '趋势' || ACTION_HEADERS.has(name) || CONTEXT_ONLY_HEADERS.has(name)) return;
    const fixedName = fixedHeaders.get(name);
    if (fixedName) mapped[fixedName] = value;
    else mapped.extraFields[name] = value;
  });
  return mapped;
}

function hasPageAdvanced(before, after) {
  return Boolean(before && after && after.page > before.page && after.fingerprint && after.fingerprint !== before.fingerprint);
}

function createCombinationId(categoryPath, rankingType) {
  return `${categoryPath}::${rankingType}`;
}

async function runWithRetries(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 1);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (options.onFailure) await options.onFailure(error, attempt, attempt === attempts);
      if (attempt === attempts) throw error;
    }
  }
  throw lastError;
}

module.exports = {
  cleanText,
  parseTrend,
  trendSnapshotFromHtml,
  selectProductLinkCandidate,
  safeProductUrl,
  inferRank,
  choosePeriod,
  normalizeProductUrl,
  productKey,
  mapBusinessFields,
  hasPageAdvanced,
  createCombinationId,
  runWithRetries,
};
