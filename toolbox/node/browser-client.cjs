'use strict';
// Verified with Playwright 1.58.2 against an owned Edge blank-page session.
// CDP browser.close disconnects this client's transport; never send Browser.close.
async function connect(context) {
  if (!context.browser?.endpoint) throw Object.assign(new Error('需要受管浏览器会话。'), { code: 'BROWSER_DISCONNECTED' });
  const { chromium } = require('playwright-core');
  const browser = await chromium.connectOverCDP(context.browser.endpoint);
  return { browser, disconnect: () => browser.close() };
}

async function selectPage(browser, pageId, accepts) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!accepts(page.url())) continue;
      if (!pageId) return page;
      const session = await context.newCDPSession(page);
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo.targetId === pageId) return page;
      } finally { await session.detach(); }
    }
  }
  throw Object.assign(new Error('页面已关闭或来源不支持，请在受管浏览器打开正确页面。'), { code: 'BROWSER_DISCONNECTED' });
}

module.exports = { connect, selectPage };
