// 稳定基准脚本 — 纯固定等待版（2026-07-29 验证：100条/75增长+19增速快/542秒）
// auxo 组件库版本，在旧站点结构上能稳定跑通。
// 用途：当新版脚本出问题时，用这个在老结构上验证"逻辑没问题，是站点改版导致的"。
// 注意：此脚本针对 auxo 组件，当前（2026-08）站点已迁移到 aurora，直接运行会失败。
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('node:path');

function parseRange(text) {
  if (!text || text === '-' || text.includes('小于')) return { min: 0, max: 0 };
  const cleaned = text.replace(/¥/g, '').replace(/,/g, '');
  function toNum(s) {
    s = s.trim();
    if (!s) return 0;
    if (s.includes('亿')) return parseFloat(s.replace('亿', '')) * 100000000;
    if (s.includes('万')) return parseFloat(s.replace('万', '')) * 10000;
    return parseFloat(s);
  }
  const parts = cleaned.split('-');
  if (parts.length === 2) return { min: toNum(parts[0]), max: toNum(parts[1]) };
  const v = toNum(cleaned);
  return { min: v, max: v };
}

function calcYesterday(todayText, changeText) {
  const today = parseRange(todayText);
  const change = parseFloat(changeText.replace('%', '')) || 0;
  if (change === 0) return todayText;
  const factor = 1 + change / 100;
  const yMin = today.min / factor;
  const yMax = today.max / factor;
  return formatRange({ min: yMin, max: yMax });
}

function formatRange(r) {
  if (r.min === 0 && r.max === 0) return '-';
  if (r.min === r.max) return '¥' + formatNum(r.min);
  return '¥' + formatNum(r.min) + '-' + formatNum(r.max);
}

function formatNum(n) {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return Math.round(n).toString();
}

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const page = browser.contexts()[0].pages()[0];
  const startTime = Date.now();

  // ── Step 1: Check page state ──
  console.log('=== Step 1: 确认品类 ===');
  const catVal = await page.evaluate(() => document.querySelector('#category')?.value);
  console.log('品类:', catVal || '(未检测到)');

  // ── Step 2: Sort by 成交金额 descending ──
  console.log('\n=== Step 2: 成交金额降序 ===');
  await page.evaluate(() => {
    const headers = document.querySelectorAll('th.auxo-table-column-has-sorters');
    for (const th of headers) {
      if (th.textContent?.includes('成交金额')) {
        const inner = th.querySelector('.auxo-table-column-sorter-inner');
        if (inner) inner.click();
        return;
      }
    }
  });
  await page.waitForTimeout(3000);

  const orderCheck = await page.evaluate(() => {
    const tbody = document.querySelectorAll('.auxo-table-tbody')[3];
    const rows = tbody?.querySelectorAll('tr');
    if (!rows || rows.length < 3) return 'no data';
    const r1 = rows[1]?.querySelectorAll('td')[3]?.innerText?.trim();
    const r2 = rows[2]?.querySelectorAll('td')[3]?.innerText?.trim();
    return { first: r1, second: r2 };
  });
  console.log('Top 2:', JSON.stringify(orderCheck));

  // ── Step 3: Collect products with 成交金额 > 2500 ──
  console.log('\n=== Step 3: 翻页收集 > ¥2500 的产品 ===');
  let qualifying = [];
  let pageNum = 1;

  while (pageNum <= 20) {
    const products = await page.evaluate(() => {
      const results = [];
      const tbody = document.querySelectorAll('.auxo-table-tbody')[3];
      if (!tbody) return results;
      const rows = tbody.querySelectorAll('tr');
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const cells = row.querySelectorAll('td');
        if (cells.length < 6) continue;
        const keyword = cells[0]?.querySelector('.name-PRUTXd')?.innerText?.trim() || cells[0]?.innerText?.trim()?.split('\n')[0]?.trim() || '';
        const salesAmount = cells[3]?.innerText?.trim() || '';
        if (keyword && salesAmount) results.push({ keyword, salesAmount });
      }
      return results;
    });

    for (const p of products) {
      const range = parseRange(p.salesAmount);
      if (range.min >= 2500) qualifying.push({ ...p, page: pageNum });
    }

    console.log(`  第${pageNum}页: ${products.length}条, 累计达标: ${qualifying.length}`);

    const last = products[products.length - 1];
    if (last) {
      const r = parseRange(last.salesAmount);
      if (r.max <= 2500 && r.min <= 2500) {
        console.log('  已到 ≤¥2500 区间，停止翻页');
        break;
      }
    }

    const hasNext = await page.evaluate(() => {
      const btn = document.querySelector('.auxo-pagination-next:not(.auxo-pagination-disabled)');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!hasNext) break;
    await page.waitForTimeout(2000);
    pageNum++;
  }

  console.log(`\n达标产品共 ${qualifying.length} 条\n`);

  // ── Step 4: Click each product, extract 近1天 data ──
  console.log('=== Step 4: 逐产品提取近1天成交数据 ===\n');

  let results = [];
  let skippedNoDrawer = 0;
  let skippedNoGrowth = 0;

  for (let i = 0; i < qualifying.length; i++) {
    const p = qualifying[i];
    process.stdout.write(`[${i + 1}/${qualifying.length}] ${p.keyword.padEnd(28)} `);

    await page.evaluate((targetPage) => {
      const items = document.querySelectorAll('.auxo-pagination-item');
      for (const item of items) {
        if (item.textContent?.trim() === String(targetPage)) { item.click(); return; }
      }
    }, p.page);
    await page.waitForTimeout(800);

    const clicked = await page.evaluate((kw) => {
      const tbody = document.querySelectorAll('.auxo-table-tbody')[3];
      if (!tbody) return false;
      const names = tbody.querySelectorAll('.name-PRUTXd');
      for (const name of names) {
        if (name.innerText?.trim() === kw) {
          name.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          setTimeout(() => name.click(), 300);
          return true;
        }
      }
      return false;
    }, p.keyword);
    await page.waitForTimeout(2500);

    const drawerOpen = await page.evaluate(() => !!document.querySelector('.auxo-drawer-open'));
    if (!drawerOpen) {
      console.log('❌ 抽屉未开');
      skippedNoDrawer++;
      continue;
    }

    await page.evaluate(() => {
      const drawer = document.querySelector('.auxo-drawer-open');
      if (!drawer) return;
      const all = drawer.querySelectorAll('*');
      for (const el of all) {
        if (el.textContent?.trim() === '近1天' && el.children.length <= 1) {
          el.click(); return;
        }
      }
    });
    await page.waitForTimeout(1500);

    const detail = await page.evaluate(() => {
      const drawer = document.querySelector('.auxo-drawer-open');
      if (!drawer) return null;
      const text = drawer.innerText;
      const start = text.indexOf('数据概览');
      const end = text.indexOf('商机详细分析');
      const section = text.substring(start > 0 ? start : 0, end > 0 ? end : start + 800);

      let salesAmount = '', periodChange = '';
      let foundSales = false;
      const lines = section.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '成交金额' && !foundSales) {
          foundSales = true;
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j].trim();
            if (next && next !== '较上周期') { salesAmount = next; break; }
          }
        }
        if (foundSales && line === '较上周期' && !periodChange) {
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j].trim();
            if (next && next !== '成交金额') { periodChange = next; break; }
          }
          break;
        }
      }
      return { salesAmount, periodChange };
    });

    await page.evaluate(() => {
      const closeBtn = document.querySelector('.auxo-drawer-open .anticon-close');
      if (closeBtn) closeBtn.parentElement?.click();
    });
    await page.waitForTimeout(600);

    if (!detail || !detail.salesAmount) {
      console.log('⚠ 无数据');
      skippedNoDrawer++;
      continue;
    }

    const change = parseFloat(detail.periodChange?.replace('%', '') || '0');
    if (change <= 0) {
      console.log(`${detail.salesAmount.padEnd(14)} ${detail.periodChange.padEnd(8)} -`);
      skippedNoGrowth++;
      continue;
    }

    const yesterday = calcYesterday(detail.salesAmount, detail.periodChange);
    console.log(`近30天:${p.salesAmount.padEnd(14)} 今日:${detail.salesAmount.padEnd(14)} 昨日:${yesterday.padEnd(14)} +${detail.periodChange}`);

    results.push({
      keyword: p.keyword,
      totalSales: p.salesAmount,
      yesterday: yesterday,
      today: detail.salesAmount,
      growth: detail.periodChange
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n=== Step 5: 生成报告 ===`);
  console.log(`耗时: ${elapsed}秒`);
  console.log(`结果: ${results.length}条 (抽屉失败:${skippedNoDrawer}, 未增长:${skippedNoGrowth})`);

  let md = '# 传统滋补/药食同源食品 — 成交增长选品报告\n\n';
  md += `> 采集时间: ${new Date().toLocaleString('zh-CN')}\n`;
  md += `> 品类: 传统滋补/药食同源食品\n`;
  md += `> 筛选: 近30天成交金额 > ¥2500 + 今日成交 > 昨日\n`;
  md += `> 耗时: ${elapsed}秒 | 达标:${qualifying.length} | 增长:${results.length} | 抽屉失败:${skippedNoDrawer} | 未增长:${skippedNoGrowth}\n\n`;
  md += '| # | 产品名称 | 近30天总成交 | 昨日成交 | 今日成交 | 较昨日增长 |\n';
  md += '|---|----------|-------------|----------|----------|----------|\n';
  results.forEach((p, i) => {
    md += `| ${i + 1} | ${p.keyword} | ${p.totalSales} | ${p.yesterday} | ${p.today} | +${p.growth} |\n`;
  });

  fs.writeFileSync(path.join(__dirname, '选品报告-成交增长.md'), md);
  console.log('报告已保存: 选品报告-成交增长.md');

  console.log('\n========== 结果摘要 ==========');
  results.forEach((p, i) => {
    console.log(`${i + 1}. ${p.keyword.padEnd(25)} 总:${p.totalSales.padEnd(16)} 昨:${p.yesterday.padEnd(16)} 今:${p.today.padEnd(16)} +${p.growth}`);
  });

  await browser.close();
})();
