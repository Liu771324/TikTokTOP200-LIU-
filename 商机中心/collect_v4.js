const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const {
  calcYesterday,
  classifySalesBand,
  parseGrowth,
  parseRange,
  validateSalesBounds,
} = require('./collect_utils');
const { saveReports } = require('./report_output');
const { advancePageWithRetry, runAttempts, waitForStablePage } = require('./collector_retry');
const { stopRequested: isStopRequested, waitWhilePaused } = require('./collection_control');
const {
  areSalesValuesDescending,
  clickBusinessKeyword,
  clickSalesSorter,
  getBusinessTableState,
} = require('./business_table');

const CONFIG = {
  cdpUrl: process.env.CDP_URL || 'http://localhost:9222',
  pageUrl: 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter',
  categoryLabel: process.env.CATEGORY_LABEL || '传统滋补/药食同源食品',
  categorySearch: process.env.CATEGORY_SEARCH || '药食同源',
  minSales: process.env.MIN_SALES ?? 10000,
  maxSales: process.env.MAX_SALES ?? '',
  maxPages: process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity,
  maxItems: process.env.MAX_ITEMS ? Number(process.env.MAX_ITEMS) : Infinity,
  stopFile: process.env.STOP_FILE || '',
  pauseFile: path.join(__dirname, 'pause.flag'),
  productAttempts: 3,
  drawerWaitSchedule: [3000, 5000, 8000],
  detailWaitSchedule: [2000, 3000, 5000],
  retryBackoffSchedule: [2000, 4000],
  pageWaitSchedule: [3000, 5000, 8000],
  pageSettleMs: 2000,
};

async function checkPause() {
  await waitWhilePaused({ pauseFile: CONFIG.pauseFile, stopFile: CONFIG.stopFile });
}

function stopRequested() {
  return isStopRequested(CONFIG.stopFile);
}

// ─── 帮助函数 ───

// 纯固定等待：React SPA 翻页/切tab 时旧 DOM 仍在，条件等待会伪判就绪，
// 导致 hover+click 打在将被替换的旧元素上。固定等待虽然慢一点但结果稳定。
async function waitForRows(page, waitMs = 2000) {
  await page.waitForTimeout(waitMs);
}

async function getRows(page) {
  return (await getBusinessTableState(page)).rows;
}

async function getFirstKeyword(page) {
  const rows = await getRows(page);
  return rows[0]?.keyword || '';
}

// ─── 品类选择（适配 aurora 组件库） ───

async function selectCategory(page) {
  const current = await page.evaluate(() => document.querySelector('#category')?.value || '');
  if (current.includes(CONFIG.categorySearch)) return;

  // aurora 级联选择器：不需要先点 picker，直接在 #category 输入框里搜
  await page.evaluate(() => {
    const input = document.querySelector('#category');
    if (!input) throw new Error('未找到品类输入框');
    input.click();
    input.focus();
  });
  await page.waitForTimeout(800);

  // 输入搜索词触发下拉
  await page.evaluate((search) => {
    const input = document.querySelector('#category');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, search);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, CONFIG.categorySearch);
  await page.waitForTimeout(2000);

  // 点第一个菜单项（归一化空格比较：aurora 菜单文案带空格 "传统滋补 / 药食同源食品"）
  const selected = await page.evaluate((label) => {
    const normalize = (s) => (s ?? '').replace(/\s+/g, '');
    const target = normalize(label);
    const item = Array.from(document.querySelectorAll('.aurora-cascader-menu-item'))
      .find((candidate) => normalize(candidate.textContent) === target);
    if (!item) return false;
    item.click();
    return true;
  }, CONFIG.categoryLabel);
  if (!selected) throw new Error(`未找到目标品类：${CONFIG.categoryLabel}`);

  // 品类选中后表格会刷新
  await page.waitForTimeout(4000);
}

// ─── 列表视图切换（2026-08 新增：必须点「列表」才有数据表） ───

async function ensureListView(page) {
  // 检查数据表是否有内容
  const hasData = (await getBusinessTableState(page)).rows.length > 0;
  if (hasData) return;

  console.log('切换到列表视图…');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role=button], .aurora-btn'))
      .find((e) => e.innerText?.trim() === '列表');
    if (btn) btn.click();
  });
  await page.waitForTimeout(4000);
}

// ─── 排序 ───

async function ensureDescendingBySales(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const table = await getBusinessTableState(page);
    if (table.index < 0) throw new Error('未找到包含“搜索词”和“成交金额”的商机数据表');
    const values = table.rows.slice(0, 8).map((row) => row.salesAmount);
    console.log(`排序确认 ${attempt}: ${table.sortDirection}｜${values.join(' → ')}`);
    if (table.sortDirection === 'descending' && areSalesValuesDescending(values)) return;

    const clicked = await clickSalesSorter(page, table.index);
    if (!clicked) throw new Error('未找到"成交金额"排序控件');
    await page.waitForTimeout(3000);
  }
  throw new Error('无法确认成交金额已降序，已停止以避免截取错误商品');
}

// ─── 分页（2026-08 aurora 新版：底部 .aurora-pagination，顶部假分页忽略） ───

async function getCurrentPage(page) {
  return page.evaluate(() => {
    const active = document.querySelector('.aurora-pagination-item-active');
    return active ? parseInt(active.textContent?.trim(), 10) : 1;
  });
}

async function getPageState(page) {
  const table = await getBusinessTableState(page);
  const paginationState = await page.evaluate(() => {
    const active = document.querySelector('.aurora-pagination-item-active');
    const pageNumber = active ? parseInt(active.textContent?.trim(), 10) : 1;
    const pagination = document.querySelector('.aurora-pagination');
    const paginationText = pagination?.innerText?.replace(/,/g, '') || '';
    const pageNumbers = Array.from(pagination?.querySelectorAll('[class*=aurora-pagination-item-]') || [])
      .map((item) => {
        const classMatch = String(item.className).match(/aurora-pagination-item-(\d+)/);
        return classMatch ? Number(classMatch[1]) : Number(item.textContent?.trim());
      }).filter(Number.isFinite);
    const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : (pagination ? null : 1);
    const explicitPageSize = paginationText.match(/(\d+)\s*(?:条|个)\s*\/\s*页/);
    const pageSize = explicitPageSize ? Number(explicitPageSize[1]) : null;
    const hasNext = !!document.querySelector('.aurora-pagination-next:not(.aurora-pagination-disabled)');
    return {
      page: Number.isFinite(pageNumber) ? pageNumber : 1,
      hasNext,
      pageSize,
      totalPages,
      isLastPage: pagination ? (totalPages != null && pageNumber === totalPages) : true,
    };
  });
  return {
    ...paginationState,
    fingerprint: table.rows.map((row) => `${row.keyword}::${row.salesAmount}`).join('|'),
    rawRowCount: table.rawRowCount,
    completeRowCount: table.rows.length,
    loading: table.loading,
  };
}

async function ensureStableDataPage(page, expectedRowCount, pageNum) {
  const result = await waitForStablePage({
    expectedRowCount,
    getState: () => getPageState(page),
    wait: (waitMs) => page.waitForTimeout(waitMs),
    onAttempt: ({ attempt, waitMs, state }) => {
      console.log(`第 ${pageNum} 页完整性确认 ${attempt}/3：${state.completeRowCount}/${state.rawRowCount} 行，等待 ${waitMs}ms`);
    },
  });
  if (!result.ok) {
    throw new Error(`第 ${pageNum} 页数据不完整：${result.reason}。为避免漏掉商品，本轮已停止`);
  }
  return result.state;
}

async function ensureFirstPage(page) {
  const current = await getCurrentPage(page);
  if (current === 1) return;
  await page.evaluate(() => {
    const page1 = document.querySelector('.aurora-pagination-item-1');
    if (page1) page1.click();
  });
  await page.waitForTimeout(2000);
}

async function goToPage(page, targetPage, waitMs = 2000) {
  const current = await getCurrentPage(page);
  if (current === targetPage) return;

  const beforeKeyword = await getFirstKeyword(page);
  await page.evaluate((target) => {
    const item = document.querySelector('.aurora-pagination-item-' + target);
    if (item) item.click();
  }, targetPage);
  await page.waitForTimeout(waitMs);

  // 验证内容确实变了
  const afterKeyword = await getFirstKeyword(page);
  if (afterKeyword === beforeKeyword) {
    await page.waitForTimeout(2000);
  }
}

async function goNextPage(page) {
  const hasNext = await page.evaluate(() => {
    const next = document.querySelector('.aurora-pagination-next:not(.aurora-pagination-disabled)');
    return !!next;
  });
  if (!hasNext) return { ok: true, hasNext: false };

  const before = await getPageState(page);
  const result = await advancePageWithRetry({
    before,
    attempts: 3,
    waitSchedule: CONFIG.pageWaitSchedule,
    settleMs: CONFIG.pageSettleMs,
    getState: () => getPageState(page),
    clickNext: () => page.evaluate(() => {
      const next = document.querySelector('.aurora-pagination-next:not(.aurora-pagination-disabled)');
      if (!next) return false;
      next.click();
      return true;
    }),
    wait: (waitMs) => page.waitForTimeout(waitMs),
    onAttempt: ({ attempt, waitMs, current }) => {
      console.log(`翻页到第 ${before.page + 1} 页：尝试 ${attempt}/3，等待 ${waitMs}ms（当前页码 ${current.page}）`);
    },
  });

  if (!result.ok) {
    throw new Error(`分页未完成：${result.reason}。为避免生成不完整报告，本轮已停止`);
  }
  return { ok: true, hasNext: true, page: result.state.page, attempts: result.attempts };
}

// ─── 抽屉操作 ───

async function closeDrawer(page) {
  const open = await page.locator('.aurora-drawer-open').count();
  if (!open) return true;

  const waits = [600, 1000, 2000];
  for (const waitMs of waits) {
    const clicked = await page.evaluate(() => {
      const closeBtn = document.querySelector('.aurora-drawer-open .aurora-drawer-close');
      if (closeBtn) { closeBtn.click(); return true; }
      const drawer = document.querySelector('.aurora-drawer-open');
      const altClose = drawer?.querySelector('button[class*=close], [class*=close]');
      if (altClose) { altClose.click(); return true; }
      return false;
    });
    if (!clicked) await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(waitMs);
    if (!(await page.locator('.aurora-drawer-open').count())) return true;
  }
  return false;
}

async function openProductDrawer(page, keyword, waitMs = 3000) {
  const closed = await closeDrawer(page);
  if (!closed) return { ok: false, reason: '上一个商品抽屉未能完全关闭' };
  const table = await getBusinessTableState(page);
  const clicked = table.index >= 0 && await clickBusinessKeyword(page, table.index, keyword);
  if (!clicked) return { ok: false, reason: '当前页未找到商品' };

  await page.waitForTimeout(waitMs);
  const drawerState = await page.evaluate((target) => {
    const drawer = document.querySelector('.aurora-drawer-open');
    if (!drawer) return { open: false, matches: false };
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    return { open: true, matches: normalize(drawer.innerText).includes(normalize(target)) };
  }, keyword);
  if (!drawerState.open) return { ok: false, reason: `等待 ${waitMs}ms 后抽屉仍未打开` };
  if (!drawerState.matches) return { ok: false, reason: '已打开的抽屉与当前商品不一致' };
  return { ok: true };
}

// ─── 详情提取 ───

async function getDetail(page, waitMs = 2000) {
  // 切「近1天」tab
  const tabClicked = await page.evaluate(() => {
    const drawer = document.querySelector('.aurora-drawer-open');
    if (!drawer) return false;
    // aurora radio button label: span.aurora-radio-button-label
    const candidates = Array.from(drawer.querySelectorAll('*'))
      .filter((e) => e.innerText?.trim() === '近1天' && e.children.length <= 1
        && !e.className.includes('drawer-body') && !e.className.includes('drawer-content'));
    const btn = candidates.find((e) => e.tagName === 'BUTTON' || e.tagName === 'LABEL'
      || e.className.includes('radio') || e.className.includes('button'))
      || candidates[0];
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!tabClicked) return { ok: false, reason: '未找到“近1天”选项' };
  await page.waitForTimeout(waitMs);

  // 读取成交金额和增幅（innerText 文本解析，已验证在新版仍有效）
  return page.evaluate(() => {
    const drawer = document.querySelector('.aurora-drawer-open');
    if (!drawer) return { ok: false, reason: '读取时抽屉已关闭' };
    const text = drawer.innerText;
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

    // 指标卡里的描述标签（坑8：增速快 等会夹在指标名和数值之间，读值时要跳过）
    const metricTag = new Set(['增速快', '持平', '需求大', '需求小', '竞争大', '竞争小', '热度高', '热度中', '热度低']);
    const metricLabel = (line) => ['成交金额', '搜索次数', '需供比', '在线商品量', '在线商家量', '商机详细分析'].includes(line);

    // 找「成交金额」→ 跳过标签行，取第一个非标签行（就是金额）
    const salesIdx = lines.indexOf('成交金额');
    if (salesIdx < 0) return { ok: false, reason: '未找到“成交金额”指标' };
    let salesAmount = '';
    for (let i = salesIdx + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (metricLabel(line) || line === '较上周期') break;
      if (metricTag.has(line)) continue;
      salesAmount = line;
      break;
    }
    // 找下一个「较上周期」→ 下一行（跳过描述标签，但保留 增速快/持平 作为增幅值）
    const periodIdx = lines.indexOf('较上周期', salesIdx);
    let periodChange = '';
    if (periodIdx >= 0) {
      for (let i = periodIdx + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (metricLabel(line)) break;
        if (['需求大', '需求小', '竞争大', '竞争小', '热度高', '热度中', '热度低'].includes(line)) continue;
        periodChange = line;
        break;
      }
    }

    // 判断趋势方向 ⚠️ 不能用百分比符号判断（较上周期值永远不带正负号）
    // 必须从 DOM 的 CSS 类名/颜色判断方向：trendArrowUp=涨 / trendArrowDown=跌
    let trendDir = '';
    if (periodChange === '持平' || periodChange === '0.00%') {
      trendDir = 'flat';
    } else if (periodChange === '增速快') {
      trendDir = 'fast';
    } else if (periodChange) {
      // 找到「成交金额」所在的 metricCard
      const card = Array.from(drawer.querySelectorAll('[class*=metricCard]'))
        .find((c) => c.innerText.includes('成交金额'));
      if (card) {
        const isUp = card.querySelector('[class*=trendArrowUp]') ||
                     card.querySelector('[class*=trendValuePositive]');
        const isDown = card.querySelector('[class*=trendArrowDown]') ||
                       card.querySelector('[class*=trendValueNegative]');
        if (isUp) trendDir = 'up';
        else if (isDown) trendDir = 'down';
        else trendDir = 'flat';
      }
    }
    if (!salesAmount) return { ok: false, reason: '成交金额尚未加载' };
    if (!periodChange) return { ok: false, reason: '较上周期增幅尚未加载' };
    return { ok: true, detail: { salesAmount, periodChange, trendDir } };
  });
}

async function readProductWithRetries(page, row, position) {
  const outcome = await runAttempts({
    attempts: CONFIG.productAttempts,
    operation: async (attempt) => {
      await checkPause();
      const drawerWaitMs = CONFIG.drawerWaitSchedule[attempt - 1];
      const detailWaitMs = CONFIG.detailWaitSchedule[attempt - 1];
      console.log(`[${position}] ${row.keyword}｜尝试 ${attempt}/${CONFIG.productAttempts}`);

      try {
        const opened = await openProductDrawer(page, row.keyword, drawerWaitMs);
        if (!opened.ok) return opened;
        return await getDetail(page, detailWaitMs);
      } finally {
        await closeDrawer(page);
      }
    },
    onRetry: async ({ attempt, result }) => {
      const backoffMs = CONFIG.retryBackoffSchedule[attempt - 1] || 2000;
      console.log(`[${position}] ${row.keyword}｜尝试 ${attempt} 失败：${result.reason}，${backoffMs}ms 后重试`);
      await closeDrawer(page);
      await page.waitForTimeout(backoffMs);
    },
  });

  if (outcome.ok && outcome.attempts > 1) {
    console.log(`[${position}] ${row.keyword}｜第 ${outcome.attempts} 次重试成功`);
  }
  return outcome;
}

// ─── 主流程（2026-08 适配：逐页顺序处理，替代旧 goToPage 跳转） ───

async function main() {
  const startTime = Date.now();
  let browser;
  try {
    const bounds = validateSalesBounds(CONFIG.minSales, CONFIG.maxSales);
    if (!bounds.ok) throw new Error(bounds.message);
    CONFIG.minSales = bounds.minSales;
    CONFIG.maxSales = bounds.maxSales;
    if (!(CONFIG.maxPages > 0) || !(CONFIG.maxItems > 0)) {
      throw new Error('MAX_PAGES 和 MAX_ITEMS 必须是大于 0 的数字');
    }

    browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
    const context = browser.contexts()[0];
    const page = context?.pages().find((candidate) => candidate.url().includes('jinritemai.com')) || context?.pages()[0];
    if (!page) throw new Error('CDP 已连接，但没有可用浏览器页面');

    await page.goto(CONFIG.pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (page.url().includes('/login')) throw new Error('未检测到抖店登录态，请先在 Edge 中完成登录');
    await page.waitForTimeout(3500);

    // 1. 选品类 + 切换列表视图
    await selectCategory(page);
    await ensureListView(page);
    // 2. 回到第1页
    await ensureFirstPage(page);
    // 3. 按成交金额降序排列
    await ensureDescendingBySales(page);
    await ensureFirstPage(page);

    const results = [];
    const failures = [];
    const unparseableItems = [];
    const stats = {
      normal: 0,
      fast: 0,
      down: 0,
      flat: 0,
      unparseable: 0,
      unavailable: 0,
      retrySuccess: 0,
    };
    let qualifyingCount = 0;
    let expectedPageSize = null;
    let completion = { status: 'complete', reason: 'range-complete', message: '金额区间扫描完成', coverageComplete: false };
    let scanFinished = false;

    // 4. 逐页处理：不再"先收集后跳转"，而是当前页达标商品直接打开抽屉处理
    for (let pageNum = 1; !scanFinished; pageNum += 1) {
      await checkPause();
      if (stopRequested()) {
        completion = { status: 'partial', reason: 'user-stopped', message: '用户手动停止', coverageComplete: false, stoppedAtPage: pageNum };
        break;
      }
      const stablePage = await ensureStableDataPage(page, expectedPageSize, pageNum);
      if (expectedPageSize == null) expectedPageSize = stablePage.pageSize || stablePage.completeRowCount;
      const rows = await getRows(page);
      if (rows.length !== stablePage.completeRowCount) {
        throw new Error(`第 ${pageNum} 页在确认后又发生变化（确认 ${stablePage.completeRowCount} 行，实际 ${rows.length} 行），本轮已停止`);
      }

      let pageQualifying = 0;
      for (const row of rows) {
        if (stopRequested()) {
          completion = { status: 'partial', reason: 'user-stopped', message: '用户手动停止', coverageComplete: false, stoppedAtPage: pageNum };
          scanFinished = true;
          break;
        }
        const band = classifySalesBand(row.salesAmount, bounds);
        if (band === 'invalid') {
          throw new Error(`第 ${pageNum} 页商品“${row.keyword}”的成交金额无法解析：${row.salesAmount}`);
        }
        if (band === 'above') continue;
        if (band === 'below') {
          completion.coverageComplete = true;
          scanFinished = true;
          break;
        }
        if (qualifyingCount >= CONFIG.maxItems) {
          completion = { status: 'partial', reason: 'max-items', message: `达到 MAX_ITEMS=${CONFIG.maxItems}`, coverageComplete: false, stoppedAtPage: pageNum };
          scanFinished = true;
          break;
        }
        pageQualifying += 1;
        qualifyingCount += 1;

        const readResult = await readProductWithRetries(page, row, qualifyingCount);
        if (!readResult.ok) {
          stats.unavailable += 1;
          failures.push({
            keyword: row.keyword,
            page: pageNum,
            attempts: readResult.attempts,
            reason: readResult.reason,
          });
          console.log(`[${qualifyingCount}] ${row.keyword}｜三次后仍无数据：${readResult.reason}`);
          continue;
        }
        if (readResult.attempts > 1) stats.retrySuccess += 1;

        const detail = readResult.detail;
        if (detail.trendDir === 'down') {
          stats.down += 1;
          console.log(`[${qualifyingCount}] ${row.keyword}｜下跌`);
          continue;
        }
        if (detail.trendDir === 'flat' || detail.periodChange === '持平') {
          stats.flat += 1;
          console.log(`[${qualifyingCount}] ${row.keyword}｜持平`);
          continue;
        }

        const growth = parseGrowth(detail.periodChange);
        if (growth.kind === 'fast') {
          stats.fast += 1;
          results.push({ keyword: row.keyword, totalSales: row.salesAmount, yesterday: '-', today: detail.salesAmount, growth: growth.display, category: 'fast', page: pageNum, attempts: readResult.attempts });
          console.log(`[${qualifyingCount}] ${row.keyword}｜✓ 增速快`);
        } else if (growth.kind === 'normal' || growth.kind === 'lower-bound') {
          stats.normal += 1;
          results.push({
            keyword: row.keyword,
            totalSales: row.salesAmount,
            yesterday: calcYesterday(detail.salesAmount, growth),
            today: detail.salesAmount,
            growth: growth.display,
            category: 'normal',
            page: pageNum,
            attempts: readResult.attempts,
          });
          console.log(`[${qualifyingCount}] ${row.keyword}｜✓ ${growth.display}`);
        } else {
          stats.unparseable += 1;
          const reason = `较上周期值无法解析：${detail.periodChange || '-'}`;
          unparseableItems.push({ keyword: row.keyword, page: pageNum, attempts: readResult.attempts, reason });
          console.log(`[${qualifyingCount}] ${row.keyword}｜${reason}`);
        }

        if (stopRequested()) {
          completion = { status: 'partial', reason: 'user-stopped', message: '用户手动停止', coverageComplete: false, stoppedAtPage: pageNum };
          scanFinished = true;
          break;
        }
      }

      console.log(`第 ${pageNum} 页：${pageQualifying} 条达标 / 累计 ${qualifyingCount} 条达标 / ${results.length} 条增长`);

      // 停止条件
      if (scanFinished) break;
      if (pageNum >= CONFIG.maxPages) {
        const stillHasNext = await page.evaluate(() => !!document.querySelector('.aurora-pagination-next:not(.aurora-pagination-disabled)'));
        if (stillHasNext) {
          completion = { status: 'partial', reason: 'max-pages', message: `达到 MAX_PAGES=${CONFIG.maxPages}`, coverageComplete: false, stoppedAtPage: pageNum };
        } else {
          completion.coverageComplete = true;
        }
        break;
      }
      const nextPage = await goNextPage(page);
      if (!nextPage.hasNext) {
        completion.coverageComplete = true;
        break;
      }
    }

    const classifiedCount = stats.normal + stats.fast + stats.down + stats.flat + stats.unparseable + stats.unavailable;
    if (classifiedCount !== qualifyingCount) {
      throw new Error(`完整性校验失败：已归类 ${classifiedCount} 条，达标商品 ${qualifyingCount} 条。为避免生成错误报告，本轮已停止`);
    }

    const outputTime = new Date();
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    const paths = await saveReports({
      categoryLabel: CONFIG.categoryLabel,
      minSales: CONFIG.minSales,
      maxSales: CONFIG.maxSales,
      results,
      qualifyingCount,
      elapsedSeconds,
      failures,
      unparseableItems,
      stats,
      outputTime,
      completion,
    });
    const outcome = completion.status === 'partial' ? '已停止，部分报告已生成' : '完成';
    console.log(`\n${outcome}：${qualifyingCount} 条全部归类，${results.length} 条增长，${stats.retrySuccess} 条重试成功，${stats.unavailable} 条三次后无数据`);
    console.log(`报告：${paths.latestPath}`);
    console.log(`归档：${paths.archivePath}`);
  } finally {
    await browser?.close().catch(() => {});
    if (CONFIG.stopFile) {
      try { fs.unlinkSync(CONFIG.stopFile); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(`采集失败：${error.message}`);
  process.exitCode = 1;
});

