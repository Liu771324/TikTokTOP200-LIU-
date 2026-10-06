const { chromium } = require('playwright-core');
const { ShopBrowser } = require('../browser');
const { readWorkbook } = require('../workbook');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const adapter = new ShopBrowser(browser);
  const ready = await adapter.prepare();
  if (ready.status !== 'ready') throw new Error(ready.message);
  const ids = await adapter.page.locator('.selectShop:checked').evaluateAll(es => es.map(e => e.dataset.shopid));
  const shops = ready.shops.filter(s => ids.includes(s.id));
  if (!shops.length) throw new Error('真实查询验收：页面未选择店铺，跳过查询');
  const input = await readWorkbook();
  const groups = [];
  for (const group of input.groups) {
    const products = await adapter.query(group.original, shops, new AbortController().signal);
    groups.push({ original: group.original, productCount: products.length,
      titleCount: group.titles.length, products: products.map(p => ({ id: p.id, shopId: p.shopId, shopName: p.shopName })),
      counts: await adapter.page.locator('.title-len-bar').allTextContents() });
  }
  console.log(JSON.stringify({ readonly: true, saveClicks: 0, shops, groups }, null, 2));
  // 只结束检查进程，不调用 Browser.close 或关闭任何已有标签页。
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
