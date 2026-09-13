'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright-core');

process.env.PORT = '8081';
const { server } = require('../server');

(async () => {
  if (!server.listening) await once(server, 'listening');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.goto('http://127.0.0.1:8081', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#discoverBtn');
    assert.equal(await page.title(), '抖店商机中心 · 批量采集');
    assert.equal(await page.getByRole('button', { name: '创建批量任务并开始' }).isDisabled(), true);

    await page.getByRole('button', { name: '读取 / 刷新类目' }).click();
    await page.waitForFunction(() => document.querySelector('#categorySummary')?.textContent.includes('已读取'), null, { timeout: 30000 });
    const summary = await page.locator('#categorySummary').innerText();
    const discoveredCount = Number(summary.match(/已读取 (\d+) 个类目/)?.[1]);
    assert.ok(discoveredCount > 5000, `真实类目数量异常：${summary}`);

    await page.locator('#categorySearch').fill('药食同源');
    await page.waitForTimeout(100);
    assert.ok(await page.locator('.category-row').count() > 0);
    await page.locator('.category-row input').first().check();
    assert.equal(await page.locator('#selectedCount').innerText(), '已选 1 个');
    assert.equal(await page.getByRole('button', { name: '创建批量任务并开始' }).isEnabled(), true);
    assert.equal(await page.locator('#taskList').isVisible(), true);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
