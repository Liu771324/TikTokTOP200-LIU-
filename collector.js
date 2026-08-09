'use strict';

const { chromium } = require('playwright-core');
const edge = require('./edge');
const { saveTask } = require('./task-store');
const { exportTask } = require('./export-excel');
const {
  cleanText,
  parseTrend,
  selectProductLinkCandidate,
  safeProductUrl,
  inferRank,
  choosePeriod,
  productKey,
  mapBusinessFields,
  hasPageAdvanced,
  runWithRetries,
} = require('./collector-utils');

const MAX_RANKING_TYPES = 6;
const OPERATION_RETRIES = 3;
const pageSizes = new WeakMap();

class StopRequestedError extends Error {
  constructor() {
    super('用户已停止任务');
    this.name = 'StopRequestedError';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectTargetPage() {
  const browser = await chromium.connectOverCDP(edge.CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Edge 调试会话中没有可用上下文');
  let page = context.pages().find((candidate) => candidate.url().includes('/merchandise-product-rank'));
  if (!page) {
    page = await context.newPage();
    await page.goto(edge.TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }
  if (!page.url().includes('/merchandise-product-rank')) {
    await page.goto(edge.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    const error = new Error('请先在调试版 Edge 打开的“商机中心”页面中登录抖店，完成后程序会自动进入 TOP200 页面');
    error.code = 'LOGIN_REQUIRED';
    await browser.close();
    throw error;
  }
  await page.bringToFront();
  return { browser, context, page };
}

async function visibleCascader(page) {
  const locator = page.locator('.aurora-cascader:visible, .ecom-cascader:visible').first();
  if (!(await locator.count())) throw new Error('未找到行业类目级联选择器');
  return locator;
}

async function readCascadeMenus(page) {
  return page.evaluate(() => {
    const visible = (element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const text = (element) => String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.aurora-cascader-menu, .ecom-cascader-menu'))
      .filter(visible)
      .map((menu) => Array.from(menu.querySelectorAll(':scope > li'))
        .filter(visible)
        .map((item) => ({
          text: text(item),
          expandable: item.className.includes('expand'),
          disabled: item.className.includes('disabled') || item.getAttribute('aria-disabled') === 'true',
        })));
  });
}

async function clickCascadeItem(page, depth, label) {
  const menus = page.locator('.aurora-cascader-menu:visible, .ecom-cascader-menu:visible');
  const menu = menus.nth(depth);
  const item = menu.locator(':scope > li').filter({ hasText: label });
  const exact = item.filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
  if (!(await exact.count())) throw new Error(`类目菜单第 ${depth + 1} 层未找到“${label}”`);
  await exact.click();
  await page.waitForTimeout(220);
}

async function discoverCategories(page, log = () => {}) {
  const cascader = await visibleCascader(page);
  await cascader.click();
  await page.waitForTimeout(500);
  const found = [];
  let visited = 0;

  async function walk(depth, prefix) {
    const menus = await readCascadeMenus(page);
    const items = menus[depth] || [];
    for (const item of items) {
      if (item.disabled || !item.text) continue;
      visited += 1;
      if (visited > 5000) throw new Error('类目节点超过安全上限，请刷新后重试');
      if (item.text === '全部') {
        if (prefix.length) found.push({ displayPath: prefix.join(' / '), segments: [...prefix, item.text] });
        continue;
      }
      const nextPrefix = [...prefix, item.text];
      if (!item.expandable) {
        found.push({ displayPath: nextPrefix.join(' / '), segments: nextPrefix });
        continue;
      }
      await clickCascadeItem(page, depth, item.text);
      await walk(depth + 1, nextPrefix);
    }
  }

  try {
    await walk(0, []);
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }
  const unique = [...new Map(found.map((category) => [category.displayPath, category])).values()];
  if (!unique.length) throw new Error('行业类目读取失败，请刷新页面后重试');
  log(`已读取 ${unique.length} 个可选行业类目`);
  return unique.sort((a, b) => a.displayPath.localeCompare(b.displayPath, 'zh-CN'));
}

async function readPeriods(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('input[type="radio"]')).map((input) => ({
    value: input.value,
    label: String(input.closest('label')?.innerText || '').replace(/\s+/g, ' ').trim(),
    checked: input.checked,
    disabled: input.disabled || input.closest('label')?.className.includes('disabled'),
  })).filter((period) => period.label));
}

async function discoverRankingTypes(page, log = () => {}) {
  const tabs = page.locator('[role="tab"]');
  const count = Math.min(await tabs.count(), MAX_RANKING_TYPES);
  if (!count) throw new Error('未找到 TOP200 榜单页签');
  const activeIndex = await page.evaluate(() => Array.from(document.querySelectorAll('[role="tab"]')).findIndex((tab) => tab.getAttribute('aria-selected') === 'true'));
  const rankingTypes = [];
  for (let index = 0; index < count; index += 1) {
    const currentTabs = page.locator('[role="tab"]');
    const name = cleanText(await currentTabs.nth(index).innerText());
    await currentTabs.nth(index).click();
    await page.waitForTimeout(2200);
    const periods = await readPeriods(page);
    rankingTypes.push({ name, periods, preferredPeriod: choosePeriod(periods)?.actualPeriod || null });
  }
  const restoreIndex = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
  await page.locator('[role="tab"]').nth(restoreIndex).click();
  await page.waitForTimeout(2200);
  log(`已读取 ${rankingTypes.length} 个榜单（已按确认排除后三个特殊榜）`);
  return rankingTypes;
}

async function discoverOptions(log = () => {}) {
  const { browser, page } = await connectTargetPage();
  try {
    const categories = await discoverCategories(page, log);
    const rankingTypes = await discoverRankingTypes(page, log);
    return { categories, rankingTypes, brandTypes: ['不限', '知名品牌', '非知名品牌'] };
  } finally {
    await browser.close();
  }
}

async function getTableState(page) {
  const state = await page.evaluate(() => {
    const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const text = (element) => String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    const tables = Array.from(document.querySelectorAll('table')).filter(visible);
    const table = tables.find((candidate) => text(candidate.querySelector('thead')).includes('排名')) || tables[0];
    if (!table) return { page: 0, headers: [], rows: [], fingerprint: '', hasNext: false, total: 0 };
    const headers = Array.from(table.querySelectorAll('thead th')).map(text);
    const rows = Array.from(table.querySelectorAll('tbody tr')).filter((row) => {
      if (!visible(row) || String(row.className).includes('measure')) return false;
      return row.querySelectorAll('td').length >= headers.length && headers.length > 0;
    });
    const productIndex = Math.max(0, headers.findIndex((header) => header === '商品' || header === '商品信息'));
    const shopIndex = headers.findIndex((header) => header.includes('店铺'));
    const activePage = document.querySelector('.aurora-pagination-item-active, .ecom-pagination-item-active');
    const pageNumber = Number(text(activePage) || 1);
    const snapshots = rows.map((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      const trendCell = cells[0];
      const value = trendCell?.querySelector('.cp-change-ratio-value, [class*="value-"]');
      const firstElement = Array.from(trendCell?.querySelectorAll('*') || []).find((element) => text(element) === '首次上榜');
      const upElement = trendCell?.querySelector('[class*="upIdentify"], .cp-change-ratio-value[class*="up-"]');
      const downElement = trendCell?.querySelector('[class*="downIdentify"], .cp-change-ratio-value[class*="down-"]');
      const equalElement = trendCell?.querySelector('[class*="equal"], .cp-change-ratio-trend-equal');
      const trendContainer = trendCell?.querySelector('[class*="changeRatioWrap"]')
        || value?.parentElement
        || firstElement
        || upElement?.parentElement
        || downElement?.parentElement
        || equalElement?.parentElement;
      const first = Boolean(firstElement);
      const up = Boolean(upElement);
      const down = Boolean(downElement);
      const equal = Boolean(equalElement);
      const rankText = text(trendCell?.querySelector('[class*="rank-"]'));
      const productCell = cells[productIndex];
      const candidates = Array.from(productCell?.querySelectorAll('[class*="name-"], [class*="name_"], [class*="Name-"], [class*="Name_"], [class*="title-"], [class*="title_"], [class*="Title-"], [class*="Title_"]') || [])
        .map((element) => text(element))
        .filter((valueText) => valueText && !valueText.includes('价格带'));
      const productCellText = text(productCell);
      const priceMatch = productCellText.match(/价格带\s*(.+)$/);
      const productName = candidates.sort((a, b) => b.length - a.length)[0]
        || productCellText.replace(/价格带\s*.+$/, '').trim();
      const shopCell = shopIndex >= 0 ? cells[shopIndex] : null;
      const shopCandidate = Array.from(shopCell?.querySelectorAll('[class*="name-"], [class*="name_"]') || []).map(text).find(Boolean);
      return {
        rankText,
        rowIndex: rowIndex + 1,
        cellTexts: cells.map(text),
        productName,
        priceRange: priceMatch ? priceMatch[1].trim() : '',
        shopName: shopCandidate || text(shopCell).split(/\r?\n/)[0],
        trend: {
          text: text(trendContainer),
          valueText: text(value),
          classes: `${trendContainer?.className || ''} ${value?.className || ''} ${upElement?.className || ''} ${downElement?.className || ''} ${equalElement?.className || ''}`,
          first,
          up,
          down,
          equal,
        },
      };
    });
    const pagination = document.querySelector('.aurora-pagination, .ecom-pagination');
    const next = pagination?.querySelector('.aurora-pagination-next, .ecom-pagination-next');
    const totalText = text(pagination?.querySelector('.aurora-pagination-total-text, .ecom-pagination-total-text'));
    const total = Number(totalText.replace(/\D/g, '')) || snapshots.length;
    return {
      page: pageNumber,
      headers,
      rows: snapshots,
      fingerprint: snapshots.map((row) => `${row.rankText}:${row.productName}:${row.cellTexts.slice(3, 6).join(':')}`).join('|'),
      hasNext: Boolean(next && !String(next.className).includes('disabled')),
      total,
    };
  });
  const previousPageSize = pageSizes.get(page) || 0;
  const pageSize = state.page <= 1 ? state.rows.length : Math.max(previousPageSize, state.rows.length);
  if (pageSize) pageSizes.set(page, pageSize);
  state.rows = state.rows.map((row) => ({ ...row, rank: inferRank(row.rankText, state.page, row.rowIndex, pageSize || row.rowIndex) }));
  state.fingerprint = state.rows.map((row) => `${row.rank}:${row.productName}:${row.cellTexts.slice(3, 6).join(':')}`).join('|');
  return state;
}

async function waitForStableTable(page, minimumWait = 1800) {
  await page.waitForTimeout(minimumWait);
  let previous = await getTableState(page);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(700);
    const current = await getTableState(page);
    if (current.rows.length && current.fingerprint === previous.fingerprint) return current;
    previous = current;
  }
  if (!previous.rows.length) throw new Error('页面没有可采集的榜单数据');
  return previous;
}

async function selectCategory(page, category) {
  const cascader = await visibleCascader(page);
  const current = cleanText(await cascader.innerText());
  if (current.replace(/\s*\/\s*/g, ' / ') === category.displayPath) return;
  await cascader.click();
  await page.waitForTimeout(400);
  for (let depth = 0; depth < category.segments.length; depth += 1) {
    await clickCascadeItem(page, depth, category.segments[depth]);
  }
  await page.waitForTimeout(3000);
  const selected = cleanText(await (await visibleCascader(page)).innerText());
  if (!selected || !selected.replace(/\s/g, '').includes(category.displayPath.replace(/\s/g, ''))) {
    throw new Error(`类目切换后校验失败：期望 ${category.displayPath}，实际 ${selected || '空'}`);
  }
}

async function selectBrand(page, brandType) {
  const formItem = page.locator('label[title="品牌类型"]').locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " aurora-form-item ") or contains(concat(" ", normalize-space(@class), " "), " ecom-form-item ")][1]');
  if (!(await formItem.count())) throw new Error('未找到品牌类型筛选器');
  const option = formItem.locator('[class*="tagItem"]').filter({ hasText: new RegExp(`^${brandType}$`) }).first();
  if (!(await option.count())) throw new Error(`页面没有品牌类型“${brandType}”`);
  if (!String(await option.getAttribute('class')).includes('active')) {
    await option.click();
    await page.waitForTimeout(3000);
  }
}

async function selectRanking(page, rankingType) {
  const tab = page.getByRole('tab', { name: rankingType, exact: true });
  if (!(await tab.count())) throw new Error(`页面没有榜单“${rankingType}”`);
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click();
    await page.waitForTimeout(3000);
  }
  if ((await tab.getAttribute('aria-selected')) !== 'true') throw new Error(`榜单“${rankingType}”切换失败`);
}

async function selectPreferredPeriod(page) {
  const periods = await readPeriods(page);
  const choice = choosePeriod(periods);
  if (!choice) throw new Error('当前榜单既不支持实时，也不支持近1天');
  const input = page.locator(`input[type="radio"][value="${choice.value}"]`).first();
  if (!(await input.count())) throw new Error(`未找到周期“${choice.actualPeriod}”`);
  if (!(await input.isChecked())) {
    await input.locator('xpath=ancestor::label[1]').click();
    await page.waitForTimeout(3000);
  }
  if (!(await input.isChecked())) throw new Error(`周期“${choice.actualPeriod}”切换失败`);
  return choice;
}

async function goToFirstPage(page) {
  const state = await getTableState(page);
  if (state.page <= 1) return;
  const first = page.locator('.aurora-pagination-item-1, .ecom-pagination-item-1').first();
  if (!(await first.count())) throw new Error('未找到分页第1页按钮');
  await first.click();
  await page.waitForTimeout(2500);
  const restored = await getTableState(page);
  if (restored.page !== 1) throw new Error('无法返回榜单第1页');
}

async function advancePage(page, before) {
  for (let attempt = 1; attempt <= OPERATION_RETRIES; attempt += 1) {
    const current = await getTableState(page);
    if (hasPageAdvanced(before, current)) return current;
    if (current.page > before.page) {
      await page.waitForTimeout(1600);
      continue;
    }
    const next = page.locator('.aurora-pagination-next:not(.aurora-pagination-disabled), .ecom-pagination-next:not(.ecom-pagination-disabled)').first();
    if (!(await next.count())) return null;
    await next.click();
    await page.waitForTimeout(2200);
  }
  const after = await getTableState(page);
  if (hasPageAdvanced(before, after)) return after;
  throw new Error(`第 ${before.page} 页翻页后未确认页码和商品内容同时变化`);
}

async function resolveProductUrl(context, page, rowIndex, productIndex, productName) {
  let attempted = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const rows = page.locator('table:visible tbody tr.aurora-table-row, table:visible tbody tr.ecom-table-row');
    const row = rows.nth(rowIndex - 1);
    const productCell = row.locator('td').nth(productIndex);
    const candidates = productCell.locator('a[href], [class*="name-"], [class*="name_"], [class*="Name-"], [class*="Name_"], [class*="title-"], [class*="title_"], [class*="Title-"], [class*="Title_"]');
    const snapshots = await candidates.evaluateAll((elements) => elements.map((element, index) => {
      const anchor = element.closest('a[href]');
      return {
        index,
        text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
        href: anchor?.href || '',
        classes: `${element.className || ''} ${anchor?.className || ''}`,
      };
    }));
    const candidate = selectProductLinkCandidate(snapshots, productName);
    if (!candidate) return { url: '', attempted: false };
    if (candidate.href) return { url: safeProductUrl(candidate.href), attempted: true };
    attempted = true;
    const before = new Set(context.pages());
    const target = candidates.nth(candidate.index);
    try {
      if (attempt === 1) await target.click();
      else await target.dblclick();
    } catch {
      continue;
    }
    await page.waitForTimeout(1000 + attempt * 400);
    const opened = context.pages().find((candidate) => !before.has(candidate));
    if (opened) {
      await opened.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      const url = opened.url();
      await opened.close().catch(() => {});
      const safeUrl = safeProductUrl(url);
      if (safeUrl) return { url: safeUrl, attempted: true };
    }
  }
  return { url: '', attempted };
}

async function collectCombination({ context, page, task, combination, control, log }) {
  await control.waitIfPaused();
  control.throwIfStopped();
  await selectRanking(page, combination.rankingType);
  await selectCategory(page, combination.category);
  await selectBrand(page, task.parameters.brandType);
  const period = await selectPreferredPeriod(page);
  await goToFirstPage(page);
  let state = await waitForStableTable(page);
  combination.headers = state.headers;
  const productIndex = state.headers.findIndex((header) => header === '商品' || header === '商品信息');
  if (productIndex < 0) throw new Error('表头中未找到商品列');

  const local = { scanned: 0, up: 0, first: 0, excluded: 0, unparseable: 0, duplicates: 0 };
  const seen = new Set();
  const records = [];
  let endedReason = '';

  while (local.scanned < task.parameters.rankLimit) {
    await control.waitIfPaused();
    control.throwIfStopped();
    Object.assign(task.current, {
      page: state.page,
      scanned: local.scanned,
      up: local.up,
      first: local.first,
    });
    saveTask(task);
    log(`第 ${state.page} 页：读取 ${state.rows.length} 条，累计扫描 ${local.scanned}`);
    for (const row of state.rows) {
      if (row.rank > task.parameters.rankLimit || local.scanned >= task.parameters.rankLimit) break;
      local.scanned += 1;
      const trend = parseTrend(row.trend);
      if (trend.trendType === 'unparseable') {
        local.unparseable += 1;
        task.failures.push({
          combinationId: combination.id,
          categoryPath: combination.category.displayPath,
          rankingType: combination.rankingType,
          actualPeriod: period.actualPeriod,
          page: state.page,
          stage: '趋势解析',
          error: `无法识别趋势：${trend.trendText || '空'}`,
          retries: 0,
          at: new Date().toISOString(),
        });
        continue;
      }
      if (!['up', 'first'].includes(trend.trendType)) {
        local.excluded += 1;
        continue;
      }

      const mapped = mapBusinessFields(state.headers, row.cellTexts, combination.rankingType);
      mapped.productName = row.productName || mapped.productName;
      mapped.shopName = row.shopName || mapped.shopName;
      const linkResult = await resolveProductUrl(context, page, row.rowIndex, productIndex, mapped.productName);
      const productUrl = linkResult.url;
      if (!productUrl && linkResult.attempted) {
        task.failures.push({
          combinationId: combination.id,
          categoryPath: combination.category.displayPath,
          rankingType: combination.rankingType,
          actualPeriod: period.actualPeriod,
          page: state.page,
          stage: '商品链接',
          error: `未取得商品链接：${mapped.productName}`,
          retries: 2,
          at: new Date().toISOString(),
        });
      }
      const record = {
        taskId: task.taskId,
        collectedAt: new Date().toISOString(),
        categoryPath: combination.category.displayPath,
        brandType: task.parameters.brandType,
        rankingType: combination.rankingType,
        requestedPeriod: period.requestedPeriod,
        actualPeriod: period.actualPeriod,
        rank: row.rank,
        ...trend,
        productName: mapped.productName,
        priceRange: row.priceRange,
        productUrl,
        shopName: mapped.shopName,
        userPaymentAmount: mapped.userPaymentAmount,
        clickCount: mapped.clickCount,
        clickConversionRate: mapped.clickConversionRate,
        orderCount: mapped.orderCount,
        page: state.page,
        rowIndex: row.rowIndex,
        extraFields: mapped.extraFields,
        combinationId: combination.id,
      };
      const key = productKey(record);
      if (seen.has(key)) {
        local.duplicates += 1;
        continue;
      }
      seen.add(key);
      records.push(record);
      local[trend.trendType] += 1;
      await page.waitForTimeout(350);
    }

    Object.assign(task.current, {
      page: state.page,
      scanned: local.scanned,
      up: local.up,
      first: local.first,
    });
    saveTask(task);

    if (local.scanned >= task.parameters.rankLimit) {
      endedReason = '已检查原始前200名';
      break;
    }
    if (!state.hasNext) {
      endedReason = state.total < task.parameters.rankLimit ? `页面实际仅 ${state.total} 条` : '已到最后一页';
      break;
    }
    const nextState = await advancePage(page, state);
    if (!nextState) {
      endedReason = '分页已结束';
      break;
    }
    state = await waitForStableTable(page, 700);
  }

  return { records, period, local, endedReason };
}

function recomputeTaskStats(task) {
  const completed = task.combinations.filter((item) => item.status === 'completed');
  task.stats = {
    totalCombinations: task.combinations.length,
    completedCombinations: completed.length,
    scanned: completed.reduce((sum, item) => sum + (item.scanned || 0), 0),
    up: completed.reduce((sum, item) => sum + (item.up || 0), 0),
    first: completed.reduce((sum, item) => sum + (item.first || 0), 0),
    excluded: completed.reduce((sum, item) => sum + (item.excluded || 0), 0),
    unparseable: completed.reduce((sum, item) => sum + (item.unparseable || 0), 0),
    duplicates: completed.reduce((sum, item) => sum + (item.duplicates || 0), 0),
  };
}

async function runTask(task, control, log = () => {}, options = {}) {
  const only = options.onlyCombinationIds ? new Set(options.onlyCombinationIds) : null;
  if (only) {
    task.results = task.results.filter((record) => !only.has(record.combinationId));
    task.failures = task.failures.filter((failure) => !only.has(failure.combinationId));
    for (const combination of task.combinations) if (only.has(combination.id)) combination.status = 'pending';
  }
  task.status = 'running';
  task.completedAt = null;
  saveTask(task);

  const { browser, context, page } = await connectTargetPage();
  try {
    for (const combination of task.combinations) {
      if (combination.status === 'completed' || (only && !only.has(combination.id))) continue;
      control.throwIfStopped();
      task.current = { combinationId: combination.id, categoryPath: combination.category.displayPath, rankingType: combination.rankingType };
      combination.status = 'running';
      saveTask(task);
      log(`开始组合：${combination.category.displayPath} × ${combination.rankingType}`);
      try {
        const result = await runWithRetries(
          async (attempt) => {
            combination.attempts = attempt;
            task.current = {
              combinationId: combination.id,
              categoryPath: combination.category.displayPath,
              rankingType: combination.rankingType,
              retryAttempt: attempt,
            };
            saveTask(task);
            return collectCombination({ context, page, task, combination, control, log });
          },
          {
            attempts: OPERATION_RETRIES,
            onFailure: async (error, attempt, finalAttempt) => {
              if (error instanceof StopRequestedError) throw error;
              task.failures = task.failures.filter((failure) => failure.combinationId !== combination.id);
              combination.error = error.message;
              saveTask(task);
              if (!finalAttempt) {
                log(`组合第 ${attempt} 次采集失败，等待后从第1页重试：${error.message}`);
                await control.waitIfPaused();
                control.throwIfStopped();
                await page.waitForTimeout(1500 * attempt);
              }
            },
          },
        );
        task.results.push(...result.records);
        Object.assign(combination, result.local, {
          saved: result.records.length,
          requestedPeriod: result.period.requestedPeriod,
          actualPeriod: result.period.actualPeriod,
          endedReason: result.endedReason,
          status: 'completed',
          completedAt: new Date().toISOString(),
          error: '',
        });
        log(`完成组合：扫描 ${result.local.scanned}，上升 ${result.local.up}，首次 ${result.local.first}，尝试 ${combination.attempts} 次`);
      } catch (error) {
        if (error instanceof StopRequestedError) throw error;
        combination.status = 'failed';
        combination.error = error.message;
        task.failures.push({
          combinationId: combination.id,
          categoryPath: combination.category.displayPath,
          rankingType: combination.rankingType,
          actualPeriod: combination.actualPeriod || '',
          page: (await getTableState(page).catch(() => ({ page: 0 }))).page,
          stage: '组合采集',
          error: error.message,
          retries: Math.max(0, OPERATION_RETRIES - 1),
          at: new Date().toISOString(),
        });
        log(`组合失败，继续下一项：${error.message}`);
      }
      task.current = null;
      recomputeTaskStats(task);
      saveTask(task);
    }
    task.current = null;
    task.completedAt = new Date().toISOString();
    task.status = 'completed';
    recomputeTaskStats(task);
    task.reportFiles = await exportTask(task);
    saveTask(task);
    log(`任务完成：扫描 ${task.stats.scanned}，保存 ${task.results.length}，失败记录 ${task.failures.length}`);
    return task;
  } catch (error) {
    task.current = null;
    task.status = error instanceof StopRequestedError ? 'stopped' : 'failed';
    task.lastError = error.message;
    saveTask(task);
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = {
  StopRequestedError,
  connectTargetPage,
  discoverOptions,
  getTableState,
  waitForStableTable,
  runTask,
};
