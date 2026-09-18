'use strict';

const GENERIC_TERMS = [
  '礼盒', '组合装', '包装', '新品', '纯正', '正品', '官方', '旗舰',
  '爆款', '特价', '包邮', '送礼', '家庭装', '独立装', '零食',
  '新疆', '若羌', '云南', '贵州', '四川', '甘肃', '河南',
  '无硫', '九蒸', '九晒', '干货', '滋补', '新货', '煲汤',
  '无核', '去核', '去皮', '免洗', '即食', '特级', '香甜', '酥脆', '拉丝',
  '粒',
];

const FORBIDDEN_GROUPS = new Set([
  ...GENERIC_TERMS,
  '果干',
  '梅干',
]);

const PRODUCT_FAMILIES = [
  { value: '话梅', aliases: ['话梅干', '话梅粒', '话梅'] },
  { value: '西梅干', aliases: ['西梅干'] },
  { value: '葡萄干', aliases: ['葡萄干'] },
  { value: '芒果', aliases: ['芒果干', '芒果片', '芒果'] },
  { value: '地黄', aliases: ['熟地黄', '熟地', '地黄'] },
  { value: '铁皮石斛', aliases: ['铁皮石斛', '铁皮枫斗'] },
  { value: '天麻', aliases: ['天麻片', '天麻'] },
  { value: '麦冬', aliases: ['麦冬'] },
];

function normalizeProductName(value) {
  let normalized = String(value || '')
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?\s*(?:kg|g|ml|l|克|千克|公斤|斤|毫升|升|袋|盒|罐|瓶|件|支)/giu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const terms = [...GENERIC_TERMS].sort((left, right) => right.length - left.length);
  for (const term of terms) normalized = normalized.replaceAll(term, '');
  return normalized;
}

function candidateSubstrings(name) {
  const values = new Set();
  const maxLength = Math.min(8, name.length);
  for (let length = 2; length <= maxLength; length += 1) {
    for (let start = 0; start + length <= name.length; start += 1) {
      const value = name.slice(start, start + length);
      if (!FORBIDDEN_GROUPS.has(value)) values.add(value);
    }
  }
  return values;
}

function buildCandidates(names) {
  const byValue = new Map();
  names.forEach((name, productIndex) => {
    for (const value of candidateSubstrings(name)) {
      const candidate = byValue.get(value) || {
        value,
        support: new Set(),
        firstProduct: productIndex,
        firstPosition: name.indexOf(value),
      };
      candidate.support.add(productIndex);
      byValue.set(value, candidate);
    }
  });

  const repeated = [...byValue.values()].filter((candidate) => candidate.support.size >= 2);
  const bySupport = new Map();
  for (const candidate of repeated) {
    const signature = [...candidate.support].join(',');
    const current = bySupport.get(signature);
    if (!current
      || candidate.value.length > current.value.length
      || (candidate.value.length === current.value.length
        && (candidate.firstProduct < current.firstProduct
          || (candidate.firstProduct === current.firstProduct && candidate.firstPosition < current.firstPosition)))) {
      bySupport.set(signature, candidate);
    }
  }
  return [...bySupport.values()];
}

function buildFamilyCandidates(names) {
  return PRODUCT_FAMILIES.map((family) => {
    const support = new Set();
    let firstProduct = Number.POSITIVE_INFINITY;
    let firstPosition = Number.POSITIVE_INFINITY;

    names.forEach((name, productIndex) => {
      const positions = family.aliases
        .map((alias) => name.indexOf(alias))
        .filter((position) => position >= 0);
      if (positions.length === 0) return;
      support.add(productIndex);
      if (productIndex < firstProduct) {
        firstProduct = productIndex;
        firstPosition = Math.min(...positions);
      }
    });

    return { ...family, support, firstProduct, firstPosition, explicit: true };
  }).filter((candidate) => candidate.support.size > 0);
}

function groupProducts(products = []) {
  const names = products.map((item) => normalizeProductName(item.keyword));
  const uniqueNames = [...new Set(names)];
  const nameIndexes = new Map(uniqueNames.map((name, index) => [name, index]));
  const candidates = [
    ...buildCandidates(uniqueNames),
    ...buildFamilyCandidates(uniqueNames),
  ];
  const assigned = products.map((item, productIndex) => {
    const nameIndex = nameIndexes.get(names[productIndex]);
    const allMatches = candidates.filter((candidate) => candidate.support.has(nameIndex));
    const explicitMatches = allMatches.filter((candidate) => candidate.explicit);
    const matches = allMatches.filter((candidate) => candidate.explicit
      || !explicitMatches.some((explicit) => explicit.aliases.some((alias) => alias.includes(candidate.value))));
    matches.sort((left, right) => right.support.size - left.support.size
      || left.firstProduct - right.firstProduct
      || left.firstPosition - right.firstPosition
      || Number(Boolean(right.explicit)) - Number(Boolean(left.explicit))
      || right.value.length - left.value.length);
    const singleProductGroup = names[productIndex].length === 2 ? names[productIndex] : '';
    return { ...item, productGroup: matches[0]?.value || singleProductGroup || '未归类' };
  });

  const buckets = new Map();
  assigned.forEach((item, index) => {
    const key = item.productGroup === '未归类' ? `未归类:${index}` : item.productGroup;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  });
  return [...buckets.values()].flat();
}

module.exports = { GENERIC_TERMS, groupProducts, normalizeProductName };
