// 仅供独立进程的生命周期验收使用：连接独立模拟浏览器，绝不连接用户的 9222。
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const browserModule = require('../browser');
browserModule.cdpReady = async () => true;
process.env.NO_OPEN = '1';
browserModule.connectEdge = async () => {
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  await context.route('https://fxg.jinritemai.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body>商品管理 订单管理</body>' }));
  await context.route('https://xiaozhu.huanhou.cn/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(`${__dirname}/platform.html`, 'utf8') }));
  const home = await context.newPage(); await home.goto(browserModule.HOME);
  const page = await context.newPage(); await page.goto(browserModule.QUERY);
  return browser;
};
