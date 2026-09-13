'use strict';

const { chromium } = require('playwright-core');
const edge = require('./edge');

const PAGE_URL = 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter';
const CATEGORY_ENDPOINT = '/api/commop/business_chance_center/shop_full_category/list';
const MAX_CATEGORY_NODES = 10000;

function cleanSegment(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeCategory(category) {
  const segments = Array.isArray(category?.segments)
    ? category.segments.map(cleanSegment).filter(Boolean)
    : String(category?.displayPath || '').split(/\s*\/\s*/).map(cleanSegment).filter(Boolean);
  if (!segments.length) return null;
  const valuePath = Array.isArray(category?.valuePath)
    ? category.valuePath.map((value) => String(value))
    : [];
  return { displayPath: segments.join(' / '), segments, valuePath };
}

function flattenCategoryTree(tree) {
  const found = [];
  let visited = 0;

  function walk(nodes, segments = [], valuePath = []) {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const label = cleanSegment(node?.label);
      if (!label) continue;
      visited += 1;
      if (visited > MAX_CATEGORY_NODES) throw new Error('类目节点超过安全上限，请稍后重试');
      const nextSegments = [...segments, label];
      const nextValues = [...valuePath, String(node.value ?? '')].filter(Boolean);
      found.push({ displayPath: nextSegments.join(' / '), segments: nextSegments, valuePath: nextValues });
      if (Array.isArray(node.children) && node.children.length) walk(node.children, nextSegments, nextValues);
    }
  }

  walk(tree);
  return [...new Map(found.map((category) => [category.displayPath, category])).values()];
}

async function readCategoryTree(page) {
  return page.evaluate(async ({ endpoint }) => {
    const resourceUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .reverse()
      .find((name) => name.includes(endpoint));
    if (!resourceUrl) throw new Error('页面尚未加载完整类目数据，请稍后重新读取');
    const response = await fetch(resourceUrl, { credentials: 'include' });
    if (!response.ok) throw new Error(`类目接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== 0 || !Array.isArray(payload.data)) {
      throw new Error(payload.base_resp?.status_message || '类目接口返回格式异常');
    }
    return payload.data;
  }, { endpoint: CATEGORY_ENDPOINT });
}

async function discoverCategories({ cdpUrl = edge.CDP_URL } = {}) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Edge 调试会话中没有可用上下文');
    let page = context.pages().find((candidate) => candidate.url().includes('NewBusinessCenter'));
    if (!page) {
      page = context.pages().find((candidate) => candidate.url().includes('jinritemai.com'));
      if (!page) throw new Error('未找到已登录的抖店页面');
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
    }
    if (page.url().includes('/login')) {
      const error = new Error('请先在调试版 Edge 中登录抖店，再重新读取类目');
      error.code = 'LOGIN_REQUIRED';
      throw error;
    }
    const tree = await readCategoryTree(page);
    const categories = flattenCategoryTree(tree)
      .sort((a, b) => a.displayPath.localeCompare(b.displayPath, 'zh-CN'));
    if (!categories.length) throw new Error('商机中心没有返回可选类目');
    return { categories, discoveredAt: new Date().toISOString() };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  CATEGORY_ENDPOINT,
  discoverCategories,
  flattenCategoryTree,
  normalizeCategory,
  readCategoryTree,
};
