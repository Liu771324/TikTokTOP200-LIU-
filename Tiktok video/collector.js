'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const legacyEdge = require('./edge');
const fingerprintModule = require('./video-fingerprint');
const { visualOverlapPercent, openingSubjectOverlapPercent } = fingerprintModule;
const legacyStore = require('./task-store');

function createCollector(runtime = {}) {
const { ROOT, VIDEO_DIR } = legacyStore;
const atomicWrite = runtime.atomicWrite || legacyStore.atomicWrite;
const saveTask = runtime.saveTask || legacyStore.saveTask;
const appendLog = runtime.appendLog || legacyStore.appendLog;
const connectTargetPage = runtime.connectTargetPage || legacyEdge.connectTargetPage;
const createVideoFingerprinter = runtime.createVideoFingerprinter || fingerprintModule.createVideoFingerprinter;
const checkCancelled = () => { if (runtime.isCancelled?.()) throw Object.assign(new Error('操作已停止。'), { code: 'CANCELLED' }); };


const applyOptions = runtime.applyOptions || defaultApplyOptions;
const ensureVideoRanking = runtime.ensureVideoRanking || defaultEnsureVideoRanking;
const tableState = runtime.tableState || defaultTableState;
const nextPage = runtime.nextPage || defaultNextPage;
const readNamingCaptions = runtime.readNamingCaptions || defaultReadNamingCaptions;
const blockingIssue = runtime.blockingIssue || defaultBlockingIssue;
const PERIODS = new Map([['实时', 'realTime'], ['近1天', 'one'], ['近7天', 'seven'], ['近30天', 'thirty']]);
const BRANDS = ['不限', '知名品牌', '非知名品牌'];
const VIDEO_HASH_INDEX = path.join(ROOT, 'data', 'video-hashes.json');
const MEDIA_CHUNK_BINDING = `__videoCollectorWriteMediaChunk_${crypto.randomUUID().replace(/-/g, '')}`;
const mediaChunkWriters = new Map();
const mediaChunkPages = new WeakSet();

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function captionFingerprint(value) {
  const caption = cleanText(value).toLocaleLowerCase();
  return caption ? crypto.createHash('sha256').update(caption).digest('hex') : null;
}

function captionFingerprintForVideo(file) {
  const caption = path.join(path.dirname(file), `${path.parse(file).name}.txt`);
  return fs.existsSync(caption) ? captionFingerprint(fs.readFileSync(caption, 'utf8')) : null;
}

function findCaptionMatch(captionHash, dedupeIndex) {
  if (!captionHash) return null;
  return Object.values(dedupeIndex).find((entry) => entry.captionHash === captionHash) || null;
}

async function retryOnce(operation) {
  try { return await operation(); }
  catch (error) {
    if (error.code === 'CANCELLED') throw error;
    checkCancelled();
    await pause(600);
    return operation();
  }
}

async function readPageOptions(page) {
  const periods = await page.evaluate((known) => Array.from(document.querySelectorAll('[role="tab"]')).flatMap((tab) => {
    if (!(tab.offsetWidth || tab.offsetHeight || tab.getClientRects().length)) return [];
    const label = (tab.innerText || tab.textContent || '').replace(/\s+/g, ' ').trim();
    if (!known.includes(label)) return [];
    return [{ label, value: ({ '实时': 'realTime', '近1天': 'one', '近7天': 'seven', '近30天': 'thirty' })[label], disabled: tab.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(tab.className)) }];
  }), [...PERIODS.keys()]);
  const brands = await page.evaluate((values) => {
    const label = Array.from(document.querySelectorAll('label')).find((item) => item.getAttribute('title') === '品牌类型');
    const row = label?.parentElement?.parentElement?.parentElement;
    return Array.from(row?.querySelectorAll('[data-btm]') || []).map((item) => (item.innerText || '').trim()).filter((text) => values.includes(text));
  }, BRANDS);
  const activeCategory = await page.locator('.aurora-cascader:visible, .ecom-cascader:visible').evaluateAll((items) => items.map((item) => item.innerText.trim()));
  return { periods: periods.filter((item) => !item.disabled), brands: [...new Set(brands)], activeCategory };
}

async function openIndustryCascade(page) {
  const control = page.locator('.aurora-cascader:visible, .ecom-cascader:visible').first();
  if (!(await control.count())) throw new Error('未找到行业类目选择器');
  await control.click();
  await page.waitForTimeout(350);
  return control;
}

async function menuState(page, depth) {
  return page.evaluate((index) => Array.from(document.querySelectorAll('.aurora-cascader-menu, .ecom-cascader-menu'))
    .filter((menu) => menu.offsetWidth || menu.offsetHeight || menu.getClientRects().length)
    .map((menu) => Array.from(menu.querySelectorAll(':scope > li')).filter((item) => item.offsetWidth || item.offsetHeight || item.getClientRects().length)
      .map((item) => ({ text: (item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim(), expandable: /expand/.test(item.className), disabled: /disabled/.test(item.className) || item.getAttribute('aria-disabled') === 'true' })))[index] || [], depth);
}

async function clickMenuItem(page, depth, label) {
  const menus = page.locator('.aurora-cascader-menu:visible, .ecom-cascader-menu:visible');
  const menu = menus.nth(depth);
  const candidates = menu.locator(':scope > li');
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const item = candidates.nth(index);
    if (cleanText(await item.innerText()) === label) { await item.click(); await pause(220); return; }
  }
  throw new Error(`类目菜单第 ${depth + 1} 层未找到“${label}”`);
}

async function discoverCategories(page, log = () => {}) {
  await openIndustryCascade(page);
  const results = [];
  let visited = 0;
  async function walk(depth, prefix) {
    const items = await menuState(page, depth);
    for (const item of items) {
      if (!item.text || item.disabled) continue;
      visited += 1;
      if (visited > 3000) throw new Error('类目节点超过安全上限，已停止读取');
      if (item.text === '全部') {
        if (prefix.length) results.push(prefix.join(' / '));
        continue;
      }
      const next = [...prefix, item.text];
      if (!item.expandable) { results.push(next.join(' / ')); continue; }
      await clickMenuItem(page, depth, item.text);
      await walk(depth + 1, next);
    }
  }
  try { await walk(0, []); } finally { await page.keyboard.press('Escape').catch(() => {}); }
  const categories = [...new Set(results)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (!categories.length) throw new Error('没有读取到可选行业类目');
  log(`已读取 ${categories.length} 个行业类目`);
  return categories;
}

async function discoverOptions(log = () => {}) {
  const { page } = await connectTargetPage();
  await ensureVideoRanking(page);
  const original = await readPageOptions(page);
  let categories;
  try { categories = await discoverCategories(page, log); }
  finally {
    const originalCategory = original.activeCategory[0];
    if (originalCategory) await selectCategory(page, originalCategory);
  }
  const state = await readPageOptions(page);
  if (!state.periods.length) throw new Error('没有读取到页面可用的榜单周期');
  if (!state.brands.length) throw new Error('没有读取到页面可用的品牌类型');
  return { categories, brandTypes: state.brands, periods: state.periods, currentCategory: original.activeCategory[0] || '' };
}

async function selectCategory(page, value) {
  const category = page.locator('.aurora-cascader:visible, .ecom-cascader:visible').first();
  await category.click();
  await page.waitForTimeout(200);
  const segments = value.split(' / ');
  for (let depth = 0; depth < segments.length; depth += 1) await clickMenuItem(page, depth, segments[depth]);
  const finalMenu = await menuState(page, segments.length);
  if (finalMenu.some((item) => item.text === '全部' && !item.disabled)) await clickMenuItem(page, segments.length, '全部');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  const selected = cleanText(await category.innerText());
  if (selected !== value && selected !== `${value} / 全部`) throw new Error(`行业类目切换未生效：${selected}`);
}

async function defaultEnsureVideoRanking(page) {
  checkCancelled();
  const tab = page.getByRole('tab', { name: '短视频榜', exact: true });
  await tab.waitFor({ state: 'visible', timeout: 15000 });
  checkCancelled();
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await page.waitForFunction(() => {
    const visible = (item) => Boolean(item && (item.offsetWidth || item.offsetHeight || item.getClientRects().length));
    const selected = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
      .some((item) => visible(item) && (item.innerText || item.textContent || '').trim() === '短视频榜');
    const table = Array.from(document.querySelectorAll('table')).some((item) => visible(item)
      && (item.querySelector('thead')?.innerText || '').includes('带货短视频'));
    return selected && table;
  }, undefined, { timeout: 20000 });
  checkCancelled();
  if (await tab.getAttribute('aria-selected') !== 'true') throw new Error('短视频榜未成功激活');
  const state = await waitForStableTable(page);
  checkCancelled();
  if (!state.hasVideoTable) throw new Error('短视频榜表格没有加载');
  return state;
}

async function defaultApplyOptions(page, parameters) {
  await ensureVideoRanking(page);
  await selectCategory(page, parameters.category);

  const brandLabel = page.locator('label[title="品牌类型"]');
  const brandRow = brandLabel.locator('xpath=../../..');
  const brand = brandRow.getByText(parameters.brandType, { exact: true }).first();
  if (!(await brand.count())) throw new Error(`页面找不到品牌选项“${parameters.brandType}”`);
  if (!/activeItem/.test((await brand.getAttribute('class')) || '')) await brand.click();

  const period = page.getByRole('tab', { name: parameters.period, exact: true });
  if (!(await period.count())) throw new Error(`页面没有“${parameters.period}”周期选项`);
  await period.click();
  await page.waitForTimeout(1800);
  const firstPage = page.locator('.aurora-pagination-item-1, .ecom-pagination-item-1').first();
  if (await firstPage.count()) await firstPage.click().catch(() => {});
  const activePeriod = await period.getAttribute('aria-selected');
  if (activePeriod !== 'true') throw new Error(`周期“${parameters.period}”未成功激活`);
  const selectedBrand = await brand.getAttribute('class');
  if (!/activeItem/.test(selectedBrand || '')) throw new Error(`品牌类型“${parameters.brandType}”未成功激活`);
  const state = await waitForStableTable(page);
  if (!state.hasVideoTable || (!state.rows.length && state.total > 0)) throw new Error('筛选后短视频榜表格没有加载');
  return state;
}

async function defaultTableState(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.aurora-table-row, tr.ecom-table-row'))
      .filter((row) => row.offsetWidth || row.offsetHeight || row.getClientRects().length);
    const parsed = rows.map((row, index) => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      const trendCell = cells[0];
      const trendValue = trendCell?.querySelector('.cp-change-ratio-value, [class*=tagItem-]');
      const trendText = (trendValue?.innerText || trendCell?.innerText || '').replace(/\s+/g, ' ').trim();
      const trendClasses = Array.from(trendCell?.querySelectorAll('*') || []).map((item) => String(item.className || '')).join(' ').toLowerCase();
      let trend = 'unparseable';
      if (/首次上榜/.test(trendText)) trend = 'first';
      else if (/(^|[-_\s])up([-_\s]|$)|upidentify/.test(trendClasses) || /上升|↑|↗/.test(trendText)) trend = /\d/.test(trendText) ? 'up' : 'unparseable';
      else if (/(^|[-_\s])down([-_\s]|$)|downidentify|equal/.test(trendClasses) || /下降|持平|横线/.test(trendText) || !trendText || /^[-—–]$/.test(trendText)) trend = 'other';
      const info = (cells[1]?.innerText || '').split(/\n价格带/)[0].trim();
      const nameNode = cells[1]?.querySelector('[class*=name-]');
      const productName = (nameNode?.innerText || info).trim();
      const shopNode = cells[3]?.querySelector('[class*=name-]');
      const shopName = (shopNode?.innerText || cells[3]?.innerText || '').trim();
      const videoCell = cells[2];
      const cards = Array.from(videoCell?.querySelectorAll('[class*=videoWrapper-]') || [])
        .filter((card) => card.offsetWidth || card.offsetHeight || card.getClientRects().length)
        .filter((card) => !/more|expand/i.test(String(card.className)) && !/^\s*\+\d+\s*$/.test(card.innerText || ''));
      const extraCount = Number((videoCell?.querySelector('[class*=moreVideo-]')?.innerText || '').match(/\+(\d+)/)?.[1] || 0);
      return { trendText, trend, productName, shopName, videoCount: cards.length + extraCount, rowIndex: index };
    });
    const pager = document.querySelector('.aurora-pagination, .ecom-pagination');
    const pageNumber = Number((pager?.querySelector('.aurora-pagination-item-active, .ecom-pagination-item-active')?.innerText || '1').trim()) || 1;
    const totalText = pager?.querySelector('[class*=pagination-total]')?.innerText || '';
    const total = Number((totalText.match(/[\d,]+/) || ['0'])[0].replace(/,/g, '')) || parsed.length;
    const headers = Array.from(document.querySelectorAll('table thead')).map((head) => head.innerText || '').join(' ');
    const loading = Boolean(document.querySelector('.aurora-spin-spinning, .ecom-spin-spinning, [aria-busy="true"]'));
    return { rows: parsed, page: pageNumber, total, hasVideoTable: headers.includes('带货短视频'), loading };
  });
}

async function defaultBlockingIssue(page) {
  return page.evaluate(() => {
    if (!location.pathname.includes('/shop/chance/merchandise-product-rank')) return '罗盘页面已离开短视频榜，可能需要重新登录';
    const visible = (item) => item.offsetWidth || item.offsetHeight || item.getClientRects().length;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .aurora-modal, .ecom-modal')).filter(visible);
    const text = dialogs.map((item) => item.innerText || '').join(' ');
    if (/验证码|滑动验证|请完成验证|人机验证/.test(text) ||
        Array.from(document.querySelectorAll('iframe')).some((frame) => visible(frame) && /captcha|verify/i.test(frame.src))) return '页面出现验证，请在 Edge 中手动完成后续跑';
    if (/访问受限|操作频繁|访问过于频繁|请求过于频繁|登录已失效|请重新登录/.test(text)) return '页面出现访问限制或登录失效，请在 Edge 中恢复后续跑';
    return '';
  });
}

function tableFingerprint(state) {
  return JSON.stringify([state.page, state.total, state.rows.map((row) => [row.productName, row.trendText])]);
}

async function waitForStableTable(page, minimumWait = 1500) {
  await page.waitForTimeout(minimumWait);
  const deadline = Date.now() + 15000;
  let previous = '';
  let matches = 0;
  while (Date.now() < deadline) {
    const issue = await blockingIssue(page);
    if (issue) throw new Error(issue);
    const state = await tableState(page);
    const fingerprint = tableFingerprint(state);
    if ((state.rows.length || state.total === 0) && !state.loading && fingerprint === previous) matches += 1;
    else matches = 0;
    if (matches >= 2) return state;
    previous = fingerprint;
    await page.waitForTimeout(600);
  }
  throw new Error('榜单表格未在限定时间内稳定');
}

async function defaultNextPage(page, current) {
  const next = page.locator('.aurora-pagination-next:not(.aurora-pagination-disabled), .ecom-pagination-next:not(.ecom-pagination-disabled)').first();
  if (!(await next.count())) return false;
  await next.click();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const state = await tableState(page);
    if (state.page === current.page + 1 && state.rows.length && tableFingerprint(state) !== tableFingerprint(current)) {
      const stable = await waitForStableTable(page, 500);
      if (stable.page === current.page + 1 && tableFingerprint(stable) !== tableFingerprint(current)) return true;
    }
  }
  throw new Error(`翻页校验失败：期望从第 ${current.page} 页进入下一页`);
}

function allowedTrend(trend, mode) {
  return trend === 'first' || (mode === 'up_and_first' && trend === 'up');
}

function safePart(value, max = 80) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[ .]+$/g, '');
  const result = Array.from(cleaned).slice(0, max).join('').replace(/[ .]+$/g, '') || '视频';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `_${result}` : result;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function listVideoFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return listVideoFiles(file);
    return entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp4' ? [file] : [];
  });
}

function resolveVideoPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return null;
  const root = path.resolve(VIDEO_DIR);
  const file = path.resolve(root, relativePath);
  return file.startsWith(`${root}${path.sep}`) ? file : null;
}

async function prepareVideoHashIndex(task, control, fingerprinter) {
  let savedIndex = {};
  if (fs.existsSync(VIDEO_HASH_INDEX)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(VIDEO_HASH_INDEX, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) savedIndex = parsed;
    } catch (error) {
      appendLog(task, `全局去重索引无法读取，将重新建立：${error.message}`);
    }
  }
  const previousByPath = new Map();
  for (const [hash, entry] of Object.entries(savedIndex)) {
    if (!/^[a-f0-9]{64}$/i.test(hash) || !entry || typeof entry !== 'object') continue;
    if (resolveVideoPath(entry.path)) previousByPath.set(entry.path, { hash, entry });
  }

  const files = listVideoFiles(VIDEO_DIR);
  appendLog(task, `正在检查 ${files.length} 个已保存视频，建立全局去重索引`);
  const index = {};
  let duplicateCount = 0;
  for (const file of files) {
    await control.waitIfPaused();
    control.throwIfStopped();
    const relativePath = path.relative(VIDEO_DIR, file);
    const stat = fs.statSync(file);
    const previous = previousByPath.get(relativePath);
    const hash = previous && previous.entry.size === stat.size && previous.entry.mtimeMs === stat.mtimeMs
      ? previous.hash : await sha256File(file);
    const captionHash = captionFingerprintForVideo(file);
    const exactMatch = index[hash];
    if (exactMatch) {
      if (removeExistingDuplicate(file, task, exactMatch, '文件哈希相同')) duplicateCount += 1;
      continue;
    }
    let fingerprint = previous?.entry.fingerprint || null;
    if (!fingerprint) {
      try { fingerprint = await fingerprinter?.fingerprintFile(file); }
      catch (error) { appendLog(task, `视频视觉指纹读取失败，将只按文件哈希去重：${relativePath}；${error.message}`); }
    }
    const visualMatch = fingerprint && findVisualMatch(fingerprint, index);
    if (visualMatch && removeExistingDuplicate(file, task, visualMatch.entry, `${visualMatch.percent}%画面重合`)) {
      duplicateCount += 1;
      continue;
    }
    const captionMatch = findCaptionMatch(captionHash, index);
    let indexedCaptionHash = captionHash;
    if (captionMatch && removeDuplicateCaption(file, task, captionMatch)) indexedCaptionHash = null;
    index[hash] = { path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs, fingerprint, captionHash: indexedCaptionHash };
  }
  atomicWrite(VIDEO_HASH_INDEX, index);
  task.progress.duplicatesSkipped = (task.progress.duplicatesSkipped || 0) + duplicateCount;
  if (duplicateCount) appendLog(task, `现有文件中清理了 ${duplicateCount} 个重复视频及对应文案；保留每组第一份`);
  return index;
}

function removeExistingDuplicate(file, task, retained, reason) {
  try { fs.unlinkSync(file); }
  catch (error) {
    appendLog(task, `重复视频无法删除，仍保留文件：${file}；${error.message}`);
    return false;
  }
  const caption = path.join(path.dirname(file), `${path.parse(file).name}.txt`);
  if (fs.existsSync(caption)) {
    try { fs.unlinkSync(caption); }
    catch (error) { appendLog(task, `重复视频的文案无法删除：${caption}；${error.message}`); }
  }
  if (!fs.readdirSync(path.dirname(file)).length) fs.rmdirSync(path.dirname(file));
  appendLog(task, `已清理重复视频（${reason}）：${path.relative(VIDEO_DIR, file)}；保留 ${retained.path}`);
  return true;
}

function removeDuplicateCaption(file, task, retained) {
  const caption = path.join(path.dirname(file), `${path.parse(file).name}.txt`);
  if (!fs.existsSync(caption)) return true;
  try { fs.unlinkSync(caption); }
  catch (error) {
    appendLog(task, `重复文案无法删除，仍保留文件：${caption}；${error.message}`);
    return false;
  }
  appendLog(task, `文案完全一致，仅删除重复文案并保留不同视频：${path.relative(VIDEO_DIR, file)}；文案保留于 ${retained.path.replace(/\.mp4$/i, '.txt')}`);
  return true;
}

function findVisualMatch(fingerprint, dedupeIndex) {
  let best = null;
  for (const entry of Object.values(dedupeIndex)) {
    if (!fingerprint || !entry.fingerprint) continue;
    const existingPath = entry.fingerprint && resolveVideoPath(entry.path);
    if (!existingPath || !fs.existsSync(existingPath)) continue;
    const openingPercent = openingSubjectOverlapPercent(fingerprint, entry.fingerprint);
    const sequencePercent = visualOverlapPercent(fingerprint, entry.fingerprint);
    const match = openingPercent >= 80
      ? { percent: openingPercent, reason: '开头人物或主体画面' }
      : sequencePercent >= 80 ? { percent: sequencePercent, reason: '较短视频主体内容' } : null;
    if (match && (!best || match.percent > best.percent)) best = { entry, ...match };
  }
  return best;
}

function productKey(product) {
  return crypto.createHash('sha256').update(`${product.productName}\n${product.shopName}`).digest('hex').slice(0, 16);
}

function productDirectoryPath(dirname) {
  if (!dirname || dirname !== safePart(dirname, 150)) throw new Error('商品目录名无效');
  const directory = path.resolve(VIDEO_DIR, dirname);
  if (!directory.startsWith(`${path.resolve(VIDEO_DIR)}${path.sep}`)) throw new Error('商品目录不在视频根目录内');
  return directory;
}

function hasDirectoryContents(dirname) {
  const directory = productDirectoryPath(dirname);
  if (!fs.existsSync(directory)) return false;
  if (fs.readdirSync(directory).length) return true;
  fs.rmdirSync(directory);
  return false;
}

const productNameNoise = [
  '官方旗舰店', '旗舰店', '专营店', '专卖店', '正品保证', '全国包邮', '厂家直销', '原装进口', '口岸直发',
  '小分子易吸收', '老少皆宜', '试吃一罐', '拍一发二', '买一送一', '发两瓶', '发6罐', '拍2盒送礼袋', '开盖即食',
  '独立包装', '免煮冲泡', '免煮', '冲泡', '即食', '上班', '懒人', '营养', '早餐', '代餐',
  '流量扶持', '俄罗斯', '加拿大', '小分子', '易吸收', '试吃', '拍一发', '拍2盒', '精选', '优选', '爆款', '推荐',
  '好物', '同款', '活动', '冲饮', '进口', '流量', '口岸', '纯', '_TT', 'TT',
];

function cleanProductName(value) {
  let cleaned = String(value || '').normalize('NFKC')
    .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, '');
  for (const term of productNameNoise) cleaned = cleaned.replaceAll(term, '');
  return cleaned
    .replace(/\d+(?:\.\d+)?\s*(?:kg|g|斤|两|ml|毫升|l|升|盒|瓶|罐|袋|包|件)?/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

const genericSharedNames = new Set(['早餐', '代餐', '营养', '即食', '冲泡', '食材', '干货', '推荐', '好物', '上新', '新品']);

function sharedProductNameAcrossCaptions(productName, captions) {
  const productChars = Array.from(cleanProductName(productName));
  const cleanedCaptions = captions.map(cleanProductName).filter(Boolean);
  if (cleanedCaptions.length >= 2) {
    for (let length = Math.min(24, productChars.length); length >= 2; length -= 1) {
      for (let start = 0; start + length <= productChars.length; start += 1) {
        const candidate = productChars.slice(start, start + length).join('');
        if (genericSharedNames.has(candidate)) continue;
        if (cleanedCaptions.every((caption) => caption.includes(candidate))) return safePart(candidate, 24);
      }
    }
  }
  return safePart(productChars.join(''), 24);
}

function sharedProductName(productName, videoName) {
  const productChars = Array.from(cleanProductName(productName));
  const video = cleanProductName(videoName);
  for (let length = Math.min(24, productChars.length); length >= 2; length -= 1) {
    for (let start = 0; start + length <= productChars.length; start += 1) {
      const candidate = productChars.slice(start, start + length).join('');
      if (!genericSharedNames.has(candidate) && video.includes(candidate)) return safePart(candidate, 24);
    }
  }
  return safePart(productChars.join(''), 24);
}

function outputDirectory(task, rank, product, shortName) {
  task.checkpoint.productDirs ||= {};
  const checkpointDirectory = task.checkpoint.productDirs[rank];
  if (checkpointDirectory && hasDirectoryContents(checkpointDirectory)) return productDirectoryPath(checkpointDirectory);
  if (checkpointDirectory) delete task.checkpoint.productDirs[rank];
  const id = productKey(product);
  const base = safePart(shortName || product.productName || id, 24);
  const indexFile = path.join(ROOT, 'data', 'product-directories.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  if (index[id] && hasDirectoryContents(index[id])) {
    task.checkpoint.productDirs[rank] = index[id];
    return productDirectoryPath(index[id]);
  }
  const used = new Set([
    ...Object.entries(index).filter(([otherId, dirname]) => otherId !== id && fs.existsSync(path.join(VIDEO_DIR, dirname))).map(([, dirname]) => dirname),
    ...Object.values(task.checkpoint.productDirs),
  ]);
  let dirname = base;
  if (used.has(dirname) || fs.existsSync(path.join(VIDEO_DIR, dirname))) dirname = `${base}_${id.slice(0, 8)}`;
  let suffix = 2;
  while (used.has(dirname) || fs.existsSync(path.join(VIDEO_DIR, dirname))) dirname = `${base}_${id.slice(0, 8)}_${suffix++}`;
  index[id] = dirname;
  atomicWrite(indexFile, index);
  task.checkpoint.productDirs[rank] = dirname;
  return productDirectoryPath(dirname);
}

function uniqueStem(directory, stem) {
  let candidate = stem;
  let suffix = 2;
  while (fs.existsSync(path.join(directory, `${candidate}.mp4`)) || fs.existsSync(path.join(directory, `${candidate}.txt`))) candidate = `${stem}_${suffix++}`;
  return candidate;
}

function isMp4(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(12);
    return fs.readSync(handle, header, 0, header.length, 0) >= 8 && header.toString('ascii', 4, 8) === 'ftyp';
  } finally { fs.closeSync(handle); }
}

async function downloadMedia(page, url, destination, expectedType) {
  const address = new URL(url);
  if (address.protocol !== 'https:') throw new Error('播放器返回非 HTTPS 媒体地址');
  return retryOnce(async () => {
    checkCancelled();
    const transferId = crypto.randomUUID();
    let descriptor = null;
    let bytesWritten = 0;
    let created = false;
    const cancelTimer = runtime.isCancelled ? setInterval(() => {
      if (runtime.isCancelled()) page.evaluate((id) => window.__collectorTransfers?.get(id)?.abort(), transferId).catch(() => {});
    }, 100) : null;
    try {
      if (!mediaChunkPages.has(page)) {
        await page.exposeBinding(MEDIA_CHUNK_BINDING, async (_source, id, encoded) => {
          const writer = mediaChunkWriters.get(id);
          if (!writer) throw new Error('媒体写入目标已关闭');
          await writer(encoded);
        });
        mediaChunkPages.add(page);
      }
      mediaChunkWriters.set(transferId, async (encoded) => {
        checkCancelled();
        const chunk = Buffer.from(encoded, 'base64');
        if (descriptor === null) { descriptor = fs.openSync(destination, 'wx'); created = true; }
        let offset = 0;
        while (offset < chunk.length) offset += fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
        bytesWritten += chunk.length;
      });
      const mime = await page.evaluate(async ({ mediaUrl, mediaType, binding, transferId }) => {
        window.__collectorTransfers ||= new Map();
        const controller = new AbortController();
        window.__collectorTransfers.set(transferId, controller);
        const timer = setTimeout(() => controller.abort(), 120000);
        try {
        let response;
        try { response = await fetch(mediaUrl, { signal: controller.signal }); }
        catch (error) { throw new Error(`媒体请求失败：${error.message}`); }
        if (response.status !== 200 || !response.body) throw new Error(`媒体下载未返回完整文件：HTTP ${response.status}`);
        const type = (response.headers.get('content-type') || '').toLowerCase();
        if (!type.startsWith(mediaType) && !type.startsWith('application/octet-stream')) throw new Error(`媒体类型无效：${type || '未知'}`);
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            let binary = '';
            for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
            await window[binding](transferId, btoa(binary));
          }
        } finally { reader.releaseLock(); }
        return type;
        } finally { clearTimeout(timer); window.__collectorTransfers.delete(transferId); }
      }, { mediaUrl: address.href, mediaType: expectedType, binding: MEDIA_CHUNK_BINDING, transferId });
      checkCancelled();
      if (descriptor !== null) { fs.closeSync(descriptor); descriptor = null; }
      if (!bytesWritten || !fs.statSync(destination).size) throw new Error('下载文件为空');
      return mime;
    } catch (error) {
      if (descriptor !== null) { fs.closeSync(descriptor); descriptor = null; }
      if (created && fs.existsSync(destination)) fs.unlinkSync(destination);
      checkCancelled();
      throw error;
    } finally {
      if (cancelTimer) clearInterval(cancelTimer);
      mediaChunkWriters.delete(transferId);
    }
  });
}

async function runFfmpeg(args, destination, action) {
  checkCancelled();
  const binary = runtime.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  // Reserve the output exclusively before allowing FFmpeg to replace it.
  fs.closeSync(fs.openSync(destination, 'wx'));
  try {
  await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const child = (runtime.spawn || spawn)(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-c', 'copy', '-f', 'mp4', destination],
      { windowsHide: true, signal: controller.signal, stdio: ['ignore', 'ignore', 'pipe'] });
    let failure = null;
    const cancelTimer = setInterval(() => {
      if (runtime.isCancelled?.()) { failure = Object.assign(new Error('操作已停止。'), { code: 'CANCELLED' }); controller.abort(); }
    }, 100);
    child.stderr.resume();
    child.on('error', (error) => { failure ||= new Error(error.name === 'AbortError' ? `FFmpeg ${action}超时` : 'FFmpeg 无法启动，请检查工具箱组件。'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(cancelTimer);
      if (failure) reject(failure);
      else code === 0 ? resolve() : reject(new Error(`FFmpeg ${action}失败：退出码 ${code}`));
    });
  });
  if (!fs.existsSync(destination) || !fs.statSync(destination).size) throw new Error(`FFmpeg ${action}文件为空`);
  checkCancelled();
  } catch (error) { fs.rmSync(destination, { force: true }); throw error; }
}

const mergeTracks = (video, audio, destination) => runFfmpeg(['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0'], destination, '合并');
const remuxVideo = (video, destination) => runFfmpeg(['-i', video], destination, '封装');

async function closePlayer(page) {
  const close = page.locator('.auxo-dorami-video-header:visible [class*=closeIcon-], .ecom-dorami-video-header:visible [class*=closeIcon-]').last();
  if (await close.count()) await close.click().catch(() => {});
}

async function defaultReadNamingCaptions(page, rowIndex, limit = 4) {
  const row = page.locator('tr.aurora-table-row, tr.ecom-table-row').nth(rowIndex);
  const cards = row.locator('[class*=videoWrapper-]');
  const captions = [];
  const visibleCount = Math.min(await cards.count(), limit);
  for (let index = 0; index < visibleCount; index += 1) {
    checkCancelled();
    const card = cards.nth(index);
    try {
      await card.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
      await retryOnce(() => card.hover({ timeout: 3000 }));
      await page.waitForTimeout(250);
      const caption = await page.evaluate(() => Array.from(document.querySelectorAll('.aurora-popover, .ecom-popover'))
        .filter((popover) => popover.offsetWidth || popover.offsetHeight || popover.getClientRects().length)
        .map((popover) => popover.querySelector('[class*=videoName-]')?.textContent?.trim() || '').filter(Boolean).at(-1) || '');
      if (caption) captions.push(caption);
    } catch { checkCancelled(); /* A missing naming caption falls back to the cleaned product title. */ }
  }
  if (captions.length < limit) {
    const moreCard = row.locator('[class*=moreVideo-]').first();
    if (await moreCard.count()) {
      try {
        await moreCard.hover({ timeout: 3000 });
        await page.waitForTimeout(250);
        const extras = await page.evaluate(() => Array.from(document.querySelectorAll('.aurora-popover [class*=videoItem-], .ecom-popover [class*=videoItem-]'))
          .filter((item) => item.offsetWidth || item.offsetHeight || item.getClientRects().length)
          .map((item) => item.querySelector('[class*=videoName-]')?.textContent?.trim() || '').filter(Boolean));
        captions.push(...extras.slice(0, limit - captions.length));
      } catch { checkCancelled(); /* The visible captions are still sufficient for a safe fallback. */ }
    }
  }
  return captions.slice(0, limit);
}

async function saveVideoFromCard(page, rowIndex, videoIndex, rank, product, task, dedupeIndex, fingerprinter) {
  if (runtime.managed) return runtime.saveVideoFromCard(page, rowIndex, videoIndex, rank, product, task, fingerprinter);
  await closePlayer(page);
  const rows = page.locator('tr.aurora-table-row, tr.ecom-table-row');
  const row = rows.nth(rowIndex);
  const visibleCards = row.locator('[class*=videoWrapper-]');
  const mediaResponses = [];
  let resolvePopup;
  const popupOpened = new Promise((resolve) => { resolvePopup = resolve; });
  const onPopup = (popup) => {
    popup.close().catch(() => {}).finally(() => resolvePopup('external'));
  };
  const onResponse = (response) => {
    const type = (response.headers()['content-type'] || '').toLowerCase();
    if (response.status() < 400 && (type.startsWith('video/') || type.startsWith('audio/'))) mediaResponses.push({ url: response.url(), type });
  };
  page.on('response', onResponse);
  page.on('popup', onPopup);
  let partial = '';
  let videoPart = '';
  let audioPart = '';
  let fromPopover = false;
  try {
    const issue = await blockingIssue(page);
    if (issue) throw new Error(issue);
    let card;
    const visibleCardCount = await visibleCards.count();
    if (videoIndex < visibleCardCount) {
      card = visibleCards.nth(videoIndex);
    } else {
      fromPopover = true;
      const moreCard = row.locator('[class*=moreVideo-]').first();
      if (!(await moreCard.count())) throw new Error('没有更多视频候选');
      await moreCard.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
      await moreCard.hover({ timeout: 3000 });
      const popoverCards = page.locator('.aurora-popover:visible [class*=videoItem-]');
      card = popoverCards.nth(videoIndex);
      await card.waitFor({ state: 'visible', timeout: 5000 });
    }
    let caption = '';
    if (!fromPopover) {
      await card.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
      await page.waitForTimeout(180);
      await retryOnce(() => card.hover({ timeout: 3000 }));
      await page.waitForTimeout(300);
      caption = await page.evaluate(() => Array.from(document.querySelectorAll('.aurora-popover'))
        .filter((popover) => popover.offsetWidth || popover.offsetHeight || popover.getClientRects().length)
        .map((popover) => popover.querySelector('[class*=videoName-]')?.textContent?.trim() || '').filter(Boolean).at(-1) || '');
    }
    await retryOnce(() => card.click({ timeout: 3000 }));
    const playerState = await Promise.race([
      popupOpened,
      page.waitForFunction(() => Array.from(document.querySelectorAll('.auxo-dorami-video-container, .ecom-dorami-video-container'))
        .some((container) => container.getClientRects().length && Boolean(container.querySelector('video')?.currentSrc)), null, { timeout: 7000 }).then(() => 'player'),
    ]);
    page.off('popup', onPopup);
    if (playerState === 'external') throw new Error('视频未在罗盘小窗播放，已跳过新开的抖音页面');
    const player = await page.evaluate(() => {
      const container = Array.from(document.querySelectorAll('.auxo-dorami-video-container, .ecom-dorami-video-container')).filter((node) => node.offsetWidth || node.offsetHeight).at(-1);
      return { url: container?.querySelector('video')?.currentSrc || '', caption: container?.querySelector('.auxo-dorami-video-title .auxo-dorami-atom-text, .ecom-dorami-video-title .ecom-dorami-atom-text')?.textContent?.trim() || '' };
    });
    caption ||= player.caption;
    const videoUrl = player.url.startsWith('https://') ? player.url : mediaResponses.find((item) => item.type.startsWith('video/'))?.url;
    if (!videoUrl) throw new Error('正常播放后没有取得视频媒体地址');
    const audioUrl = mediaResponses.find((item) => item.type.startsWith('audio/'))?.url;
    task.checkpoint.productShortNames ||= {};
    const shortName = task.checkpoint.productShortNames[rank] || sharedProductName(product.productName, caption) || `商品_${productKey(product).slice(0, 6)}`;
    task.checkpoint.productShortNames[rank] = shortName;
    const productDir = outputDirectory(task, rank, product, shortName);
    fs.mkdirSync(productDir, { recursive: true });
    const savedCount = fs.readdirSync(productDir).filter((name) => path.extname(name).toLowerCase() === '.mp4').length;
    const stem = uniqueStem(productDir, `${safePart(shortName, 24)}${savedCount + 1}`);
    const target = path.join(productDir, `${stem}.mp4`);
    partial = `${target}.part`;
    if (audioUrl) {
      videoPart = `${target}.video.part`;
      audioPart = `${target}.audio.part`;
      await downloadMedia(page, videoUrl, videoPart, 'video/');
      await downloadMedia(page, audioUrl, audioPart, 'audio/');
      await mergeTracks(videoPart, audioPart, partial);
    } else {
      videoPart = `${target}.video.part`;
      await downloadMedia(page, videoUrl, videoPart, 'video/');
      if (isMp4(videoPart)) fs.renameSync(videoPart, partial);
      else await remuxVideo(videoPart, partial);
    }
    const videoHash = await sha256File(partial);
    const existing = dedupeIndex[videoHash];
    const existingPath = existing && resolveVideoPath(existing.path);
    let duplicateMatch = existingPath && fs.existsSync(existingPath) ? { entry: existing, percent: 100, reason: '文件哈希一致' } : null;
    let fingerprint = null;
    if (!duplicateMatch) {
      if (fingerprinter) {
        try { fingerprint = await fingerprinter.fingerprintFile(partial); }
        catch (error) { appendLog(task, `视频视觉指纹读取失败，将仅按文件哈希去重：第 ${rank} 名第 ${videoIndex + 1} 条；${error.message}`); }
      }
      duplicateMatch = findVisualMatch(fingerprint, dedupeIndex);
    }
    if (duplicateMatch) {
      const matchingPath = resolveVideoPath(duplicateMatch.entry.path);
      if (!matchingPath || !fs.existsSync(matchingPath)) duplicateMatch = null;
    }
    if (duplicateMatch) {
      const key = `${rank}:${videoIndex + 1}`;
      task.checkpoint.completedVideos ||= {};
      task.checkpoint.completedVideos[key] = { video: resolveVideoPath(duplicateMatch.entry.path), caption: null, duplicateOf: duplicateMatch.entry.path, sha256: videoHash };
      task.checkpoint.failedVideos ||= {};
      delete task.checkpoint.failedVideos[key];
      for (const error of task.errors) {
        if (error.rank === rank && error.videoIndex === videoIndex + 1 && !error.resolvedAt) error.resolvedAt = new Date().toISOString();
      }
      task.progress.duplicatesSkipped = (task.progress.duplicatesSkipped || 0) + 1;
      task.progress.videoFailures = Object.keys(task.checkpoint.failedVideos).length;
      const matchDescription = duplicateMatch.reason === '文件哈希一致'
        ? duplicateMatch.reason : `${duplicateMatch.reason}相似 ${duplicateMatch.percent}%`;
      appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条视频与已保存视频${matchDescription}，已跳过视频和文案：${duplicateMatch.entry.path}`);
      if (fs.existsSync(productDir) && !fs.readdirSync(productDir).length) fs.rmdirSync(productDir);
      return;
    }
    if (existing) delete dedupeIndex[videoHash];
    const partialStat = fs.statSync(partial);
    const relativeTarget = path.relative(VIDEO_DIR, target);
    fs.renameSync(partial, target);
    partial = '';
    const output = { video: target, caption: null };
    let indexedCaptionHash = null;
    if (caption) {
      const currentCaptionHash = captionFingerprint(caption);
      const captionMatch = findCaptionMatch(currentCaptionHash, dedupeIndex);
      if (captionMatch) {
        appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条文案与已保存文案完全一致，仅保留不同视频；文案保留于 ${captionMatch.path.replace(/\.mp4$/i, '.txt')}`);
      } else {
        const textFile = path.join(productDir, `${stem}.txt`);
        try {
          fs.writeFileSync(textFile, caption, { encoding: 'utf8', flag: 'wx' });
          output.caption = textFile;
          indexedCaptionHash = currentCaptionHash;
        } catch (error) {
          task.progress.captionFailures = (task.progress.captionFailures || 0) + 1;
          appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条文案保存失败，已保留视频：${error.message}`);
        }
      }
    } else {
      task.progress.captionFailures = (task.progress.captionFailures || 0) + 1;
      appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条文案读取失败，已保留视频`);
    }
    dedupeIndex[videoHash] = { path: relativeTarget, size: partialStat.size, mtimeMs: partialStat.mtimeMs, fingerprint, captionHash: indexedCaptionHash };
    atomicWrite(VIDEO_HASH_INDEX, dedupeIndex);
    task.checkpoint.completedVideos ||= {};
    task.checkpoint.completedVideos[`${rank}:${videoIndex + 1}`] = { ...output, sha256: videoHash };
    task.checkpoint.failedVideos ||= {};
    delete task.checkpoint.failedVideos[`${rank}:${videoIndex + 1}`];
    for (const error of task.errors) {
      if (error.rank === rank && error.videoIndex === videoIndex + 1 && !error.resolvedAt) error.resolvedAt = new Date().toISOString();
    }
    task.progress.videosSaved += 1;
    task.progress.videoFailures = Object.keys(task.checkpoint.failedVideos).length;
    appendLog(task, `第 ${rank} 名第 ${videoIndex + 1} 条视频已保存：${target}`);
  } catch (error) {
    const issue = await blockingIssue(page).catch(() => 'Edge 页面已断开，请恢复后续跑');
    if (issue) throw new Error(issue);
    const message = /^locator\.hover: Timeout/.test(error.message) ? '悬浮视频卡片超时，页面可能被浮层遮挡'
      : /^locator\.click: Timeout/.test(error.message) ? '点击视频卡片超时，页面可能被浮层遮挡'
        : error.message;
    task.checkpoint.failedVideos ||= {};
    task.checkpoint.failedVideos[`${rank}:${videoIndex + 1}`] = message;
    task.progress.videoFailures = Object.keys(task.checkpoint.failedVideos).length;
    task.errors.push({ rank, productName: product.productName, videoIndex: videoIndex + 1, message, detail: error.message.slice(0, 2000) });
    appendLog(task, `第 ${rank} 名 ${product.productName} 第 ${videoIndex + 1} 条视频失败：${message}`);
  } finally {
    page.off('response', onResponse);
    page.off('popup', onPopup);
    await closePlayer(page).catch(() => {});
    for (const file of [partial, videoPart, audioPart]) {
      if (file && fs.existsSync(file)) {
        try { fs.unlinkSync(file); }
        catch (error) { appendLog(task, `未能清理临时文件 ${file}：${error.message}`); }
      }
    }
  }
}

async function runTask(task, control) {
  const { page } = await connectTargetPage();
  let fingerprinter = null;
  try {
    task.status = 'running';
    saveTask(task);
    const issue = await blockingIssue(page);
    if (issue) throw new Error(issue);
    let state = await applyOptions(page, task.parameters);
    appendLog(task, `开始扫描：${task.parameters.category} / ${task.parameters.period}`);
    if (!state.hasVideoTable) throw new Error('当前页面表格结构不含“带货短视频”，已停止以避免误采集');
    const maxRank = Math.min(200, state.total);
    const pageSize = state.rows.length;
    if (!pageSize && maxRank > 0) throw new Error('榜单表格没有商品行');
    if (task.checkpoint.initialTotal !== null && task.checkpoint.initialTotal !== undefined &&
        (task.checkpoint.initialTotal !== state.total || task.checkpoint.pageSize !== pageSize)) {
      throw new Error('续跑时榜单总数或每页条数已变化，请新建任务以避免商品错位');
    }
    task.checkpoint.initialTotal = state.total;
    task.checkpoint.pageSize = pageSize;
    task.checkpoint.rankProducts ||= {};
    task.checkpoint.productShortNames ||= {};
    task.checkpoint.eligibleRanks ||= [];
    task.checkpoint.completedVideos ||= {};
    task.checkpoint.failedVideos ||= {};
    task.checkpoint.trendErrors ||= [];
    task.progress.duplicatesSkipped ||= 0;
    try {
      fingerprinter = await createVideoFingerprinter();
      appendLog(task, '视频主体去重已启用：比对开头 5 秒主体画面；并允许不同时长视频按较短片段判断内容重合');
    } catch (error) {
      appendLog(task, `视觉去重不可用，将仅按文件哈希去重：${error.message}`);
    }
    const dedupeIndex = runtime.managed ? null : await prepareVideoHashIndex(task, control, fingerprinter);
    const failedRanks = Object.keys(task.checkpoint.failedVideos).map((key) => Number(key.split(':')[0])).filter(Number.isFinite);
    const repairRanks = runtime.managed ? [...task.checkpoint.trendErrors,
      ...Object.entries(task.checkpoint.completedVideos).filter(([, video]) => !video.caption).map(([key]) => Number(key.split(':')[0]))].filter(Number.isFinite) : [];
    const resumeFromRank = Math.min(task.checkpoint.rank || 1, ...failedRanks, ...repairRanks);
    while (state.page <= Math.ceil(maxRank / pageSize)) {
      await control.waitIfPaused();
      control.throwIfStopped();
      for (const product of state.rows) {
        const rank = (state.page - 1) * pageSize + product.rowIndex + 1;
        if (rank > maxRank) break;
        const currentProductId = productKey(product);
        const savedProductId = task.checkpoint.rankProducts[rank];
        if (savedProductId && savedProductId !== currentProductId) {
          throw new Error(`续跑时第 ${rank} 名商品已变化，请新建任务以避免视频归档错误`);
        }
        if (rank < resumeFromRank) continue;
        task.checkpoint.rankProducts[rank] = currentProductId;
        task.progress.scanned = Math.max(task.progress.scanned, rank);
        task.progress.currentRank = rank;
        task.progress.currentProduct = product.productName;
        task.progress.currentVideo = null;
        task.checkpoint = { ...task.checkpoint, page: state.page, rank, productId: currentProductId, videoIndex: 0 };
        if (product.trend === 'unparseable') {
          if (!task.checkpoint.trendErrors.includes(rank)) {
            task.checkpoint.trendErrors.push(rank);
            task.errors.push({ rank, productName: product.productName, message: `无法识别趋势：${product.trendText}` });
            appendLog(task, `第 ${rank} 名趋势无法识别，跳过`);
          }
          task.checkpoint.rank = rank + 1;
          saveTask(task);
          continue;
        }
        if (runtime.managed && task.checkpoint.trendErrors.includes(rank)) {
          task.checkpoint.trendErrors = task.checkpoint.trendErrors.filter(value => value !== rank);
          for (const error of task.errors) if (error.rank === rank && !error.videoIndex && error.message?.startsWith('无法识别趋势：')) error.resolvedAt = new Date().toISOString();
        }
        if (!allowedTrend(product.trend, task.parameters.trendMode)) {
          task.checkpoint.rank = rank + 1;
          saveTask(task);
          continue;
        }
        if (!task.checkpoint.eligibleRanks.includes(rank)) task.checkpoint.eligibleRanks.push(rank);
        task.progress.eligible = task.checkpoint.eligibleRanks.length;
        if (!task.checkpoint.productShortNames[rank]) {
          const namingCaptions = await readNamingCaptions(page, product.rowIndex, 4);
          const shortName = sharedProductNameAcrossCaptions(product.productName, namingCaptions);
          task.checkpoint.productShortNames[rank] = shortName;
          appendLog(task, `第 ${rank} 名下载前已读取 ${namingCaptions.length} 条视频文案，商品文件名确定为“${shortName}”`);
        }
        const count = product.videoCount;
        let uniqueCount = Object.entries(task.checkpoint.completedVideos).filter(([key, video]) =>
          key.startsWith(`${rank}:`) && (runtime.managed ? video.disposition === 'created' && Boolean(video.artifactId) : !video.duplicateOf && video.video && fs.existsSync(video.video))).length;
        appendLog(task, `第 ${rank} 名符合条件：${product.productName}；可用视频候选 ${count} 条`);
        for (let index = 0; index < count && (runtime.managed || uniqueCount < 4); index += 1) {
          await control.waitIfPaused();
          control.throwIfStopped();
          task.progress.currentVideo = index + 1;
          task.checkpoint.videoIndex = index + 1;
          const completed = task.checkpoint.completedVideos[`${rank}:${index + 1}`];
          if (completed && (runtime.managed ? Boolean(completed.artifactId) : fs.existsSync(completed.video))) {
            if (runtime.managed && !completed.caption) await runtime.repairCaptionFromCard(page, product.rowIndex, index, rank, product, task);
            continue;
          }
          if (uniqueCount >= 4) continue;
          const oldUniqueCount = uniqueCount;
          await saveVideoFromCard(page, product.rowIndex, index, rank, product, task, dedupeIndex, fingerprinter);
          uniqueCount = Object.entries(task.checkpoint.completedVideos).filter(([key, video]) =>
            key.startsWith(`${rank}:`) && (runtime.managed ? video.disposition === 'created' && Boolean(video.artifactId) : !video.duplicateOf && video.video && fs.existsSync(video.video))).length;
          if (uniqueCount < oldUniqueCount) uniqueCount = oldUniqueCount;
        }
        if (runtime.managed && uniqueCount >= 4) {
          const superseded = Object.keys(task.checkpoint.failedVideos).filter(key => key.startsWith(`${rank}:`));
          for (const key of superseded) {
            delete task.checkpoint.failedVideos[key];
            const videoIndex = Number(key.split(':')[1]);
            for (const error of task.errors) if (error.rank === rank && error.videoIndex === videoIndex && !error.resolvedAt) {
              error.resolvedAt = new Date().toISOString(); error.resolution = 'quota_satisfied';
            }
          }
          task.progress.videoFailures = Object.keys(task.checkpoint.failedVideos).length;
          if (superseded.length) appendLog(task, `第 ${rank} 名已保存 4 条新视频，${superseded.length} 条候选失败已按配额满足结束重试`);
        }
        if (uniqueCount < 2) appendLog(task, `第 ${rank} 名只有 ${uniqueCount} 条不同视频；已检查 ${count} 个候选，未找到第二条不同视频`);
        task.checkpoint.rank = rank + 1;
        saveTask(task);
      }
      if (state.page >= Math.ceil(maxRank / pageSize)) break;
      const old = state;
      if (!(await nextPage(page, old))) throw new Error(`榜单只有 ${state.page} 页，尚未扫描到第 ${maxRank} 名`);
      state = await tableState(page);
    }
    task.progress.currentVideo = null;
    task.status = runtime.managed && (Object.keys(task.checkpoint.failedVideos).length || task.checkpoint.trendErrors.length || task.progress.captionFailures) ? 'completed_with_errors' : 'completed';
    task.completedAt = new Date().toISOString();
    for (const error of task.errors) if (!error.rank && !error.videoIndex && !error.resolvedAt) error.resolvedAt = task.completedAt;
    appendLog(task, `扫描完成：检查 ${task.progress.scanned} 名，符合条件 ${task.progress.eligible} 件，视频成功 ${task.progress.videosSaved} 条，重复跳过 ${task.progress.duplicatesSkipped || 0} 条，失败 ${task.progress.videoFailures} 条`);
    return task;
  } catch (error) {
    task.status = error.name === 'StopRequestedError' || error.code === 'CANCELLED' ? 'stopped' : 'failed';
    if (task.status === 'failed') task.errors.push({ message: error.message, ...(runtime.managed ? { code: error.code || 'MEDIA_UNAVAILABLE' } : {}), at: new Date().toISOString() });
    appendLog(task, `任务${task.status === 'stopped' ? '已停止' : '失败'}：${error.message}`);
    return task;
  } finally {
    await fingerprinter?.close();
  }
}

return { discoverOptions, runTask, allowedTrend, safePart, tableState, readPageOptions, applyOptions, ensureVideoRanking, selectCategory, nextPage, saveVideoFromCard, sharedProductName, sharedProductNameAcrossCaptions, findVisualMatch, findCaptionMatch, downloadMedia, runFfmpeg, isMp4, productKey, blockingIssue };
}

module.exports = { createCollector, ...createCollector() };
