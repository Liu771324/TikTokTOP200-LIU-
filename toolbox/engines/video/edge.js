'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter';
const TARGET_URL = 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank';
const TARGET_PATH = '/shop/chance/merchandise-product-rank';
const DEBUG_DIR = path.join(process.env.TEMP || process.env.TMP || __dirname, 'edge-debug-video');

const cdpAddress = new URL(CDP_URL);
if (!['http:', 'ws:'].includes(cdpAddress.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(cdpAddress.hostname.toLowerCase()) ||
    cdpAddress.username || cdpAddress.password) {
  throw new Error('CDP_URL 只能指向本机回环地址');
}

function findEdgePath() {
  if (process.env.EDGE_PATH) {
    const candidate = path.resolve(process.env.EDGE_PATH);
    if (fs.existsSync(candidate) && path.basename(candidate).toLowerCase() === 'msedge.exe') return candidate;
    throw new Error('EDGE_PATH 不是有效的 msedge.exe 路径');
  }
  for (const root of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ]) {
    try {
      const output = execFileSync('reg.exe', ['query', root, '/ve'], { encoding: 'utf8', windowsHide: true });
      const candidate = output.split(/\r?\n/).find((line) => /REG_SZ/i.test(line))?.replace(/^.*?REG_SZ\s+/i, '').trim();
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch { /* Edge may be installed elsewhere. */ }
  }
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || 'C:\\', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((candidate) => fs.existsSync(candidate)) || null;
}

function isCdpReady() {
  return new Promise((resolve) => {
    const request = http.get(`http://${cdpAddress.host}/json/version`, { timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function ensureEdgeDebug() {
  if (await isCdpReady()) return { status: 'ready' };
  const edgePath = findEdgePath();
  if (!edgePath) throw new Error('未找到 Microsoft Edge，请设置 EDGE_PATH 为 msedge.exe 的完整路径后重启服务');
  const child = spawn(edgePath, [
    `--remote-debugging-port=${cdpAddress.port || '9222'}`,
    `--user-data-dir=${DEBUG_DIR}`,
    LOGIN_URL,
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  let launchError = null;
  child.on('error', (error) => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (launchError) throw new Error(`调试版 Edge 启动失败：${launchError.message}`);
    if (await isCdpReady()) return { status: 'launched' };
  }
  throw new Error('调试版 Edge 未能连接到 9222 端口，请检查 Edge 窗口和端口占用');
}

let browserConnection = null;
let connectingBrowser = null;
async function getBrowser() {
  if (browserConnection?.isConnected()) return browserConnection;
  if (!connectingBrowser) {
    connectingBrowser = chromium.connectOverCDP(CDP_URL, { timeout: 10000 })
      .then((browser) => {
        browserConnection = browser;
        browser.on('disconnected', () => { if (browserConnection === browser) browserConnection = null; });
        return browser;
      })
      .finally(() => { connectingBrowser = null; });
  }
  return connectingBrowser;
}

let opening = null;
function openVideoRanking() {
  if (!opening) opening = openVideoRankingOnce().finally(() => { opening = null; });
  return opening;
}

async function openVideoRankingOnce() {
  console.log('正在打开调试版 Edge...');
  const edgeState = await ensureEdgeDebug();
  console.log(`调试版 Edge 已连接：${edgeState.status}`);
  const browser = await getBrowser();
  console.log('已建立 Edge CDP 会话');
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Edge 调试会话中没有可用上下文');
    let page = context.pages().find((candidate) => candidate.url().includes(TARGET_PATH));
    if (!page) {
      page = context.pages().find((candidate) => candidate.url().startsWith('https://fxg.jinritemai.com/') &&
        (candidate.url().includes('/ffa/bu/NewBusinessCenter') || candidate.url().includes('/login'))) ||
        (edgeState.status === 'launched' ? context.pages()[0] : null) || await context.newPage();
      console.log('正在进入商机中心...');
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      if (new URL(page.url()).pathname.startsWith('/login')) {
        await page.bringToFront();
        return { ok: false, needLogin: true, message: '请先在商机中心登录抖店，完成后点击“打开短视频榜”。' };
      }
      console.log('正在进入罗盘商品榜...');
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    if (!page.url().includes(TARGET_PATH)) {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.bringToFront();
      return { ok: false, needLogin: true, message: '罗盘要求重新登录。请在商机中心完成登录，再点击“打开短视频榜”。' };
    }
    const tab = page.getByRole('tab', { name: '短视频榜', exact: true });
    console.log('正在切换短视频榜...');
    try { await tab.waitFor({ state: 'visible', timeout: 15000 }); }
    catch {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.bringToFront().catch(() => {});
      return { ok: false, needLogin: true, message: '罗盘未显示短视频榜。请先在商机中心完成登录或验证，再点击“打开短视频榜”。' };
    }
    if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
    await page.waitForFunction(() => {
      if (location.pathname.startsWith('/login')) return true;
      const selected = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
        .some((candidate) => (candidate.innerText || candidate.textContent || '').trim() === '短视频榜');
      const table = Array.from(document.querySelectorAll('table')).some((candidate) =>
        (candidate.querySelector('thead')?.innerText || '').includes('带货短视频'));
      return selected && table;
    }, undefined, { timeout: 20000 });
    if (!page.url().includes(TARGET_PATH)) {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.bringToFront();
      return { ok: false, needLogin: true, message: '罗盘登录已过期。请在商机中心完成登录，再点击“打开短视频榜”。' };
    }
    await page.bringToFront();
    return { ok: true, pageUrl: page.url() };
  } catch (error) {
    if (!browser.isConnected() || /Target page, context or browser has been closed/i.test(error.message)) {
      throw new Error('调试版 Edge 已断开，请检查浏览器窗口与 9222 端口后重试');
    }
    throw error;
  }
}

async function connectTargetPage() {
  const browser = await getBrowser();
  const context = browser.contexts()[0];
  const candidates = context?.pages().filter((candidate) => candidate.url().includes(TARGET_PATH)) || [];
  if (!candidates.length) {
    throw new Error('未找到罗盘商品榜页面，请点击采集页的“打开短视频榜”');
  }
  const activeLabels = [];
  for (const page of candidates) {
    const state = await page.evaluate(() => {
      const activeTabs = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'));
      const labels = activeTabs.map((tab) => (tab.innerText || tab.textContent || '').replace(/\s+/g, ' ').trim());
      const table = Array.from(document.querySelectorAll('table')).find((candidate) =>
        (candidate.querySelector('thead')?.innerText || '').includes('带货短视频'));
      return { labels, hasVideoTable: Boolean(table) };
    });
    activeLabels.push(...state.labels);
    if (state.labels.some((label) => label.includes('短视频榜')) && state.hasVideoTable) {
      await page.bringToFront();
      return { page };
    }
  }
  throw new Error(`当前页面不是短视频榜（激活标签：${activeLabels.join('、') || '未识别'}）`);
}

module.exports = { CDP_URL, TARGET_PATH, connectTargetPage, findEdgePath, openVideoRanking };
