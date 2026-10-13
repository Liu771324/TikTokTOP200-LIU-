'use strict';
// Test data and cold-import probe only. Never used as a worker adapter.
const fs = require('node:fs');
const path = require('node:path');

function fixtures() {
  const root = path.resolve(__dirname, '../..');
  const businessCases = require(path.join(root, '商机中心/test/fixtures/task_states.js')).createTaskStateFixtures();
  const business = structuredClone(businessCases.find(item => item.name === 'detail_failure').task);
  business.unparseableItems = structuredClone(businessCases.find(item => item.name === 'parse_failure').task.unparseableItems);
  business.failures[0].reason += '\n中文错误、"引号"与表情😀';
  const topCases = require(path.join(root, 'Tiktok TOP200/test/fixtures/task-states.json')).cases;
  const top = structuredClone(topCases.find(item => item.id === 'row_link_failed').task);
  top.failures[0].reason = '商品链接读取失败\n保留中文与"引号"';
  const video = {
    id: 'video-fixture', parameters: { category: '食品 / 粥', brandType: '不限', period: '近1天', trendMode: 'first' },
    status: 'completed_with_errors', progress: { videosSaved: 1, duplicatesSkipped: 1, videoFailures: 1 }, logs: [], errors: [],
    checkpoint: { rank: 3, completedVideos: {
      '1:1': { candidateId: 'video:1:fixture:one', artifactId: 'a'.repeat(32), disposition: 'created', rank: 1, videoIndex: 1, title: '中文视频😀', caption: '第一行\n"第二行"', productName: '脱敏商品A' },
      '2:1': { candidateId: 'video:2:fixture:two', artifactId: 'b'.repeat(32), disposition: 'exact_reuse', rank: 2, videoIndex: 1, title: '复用视频', caption: '任务文案仍保留', productName: '脱敏商品B' },
    }, failedVideos: { '1:2': { code: 'PAGE_CHANGED', message: '页面已变化\n请重新读取"当前页"' } } },
  };
  const manual = { items: [
    { itemId: '1'.repeat(32), sourceKind: 'public', status: 'completed', artifactId: 'c'.repeat(32), title: '公开中文视频😀\n"标题"', error: null },
    { itemId: '2'.repeat(32), sourceKind: 'compass_ranking', status: 'failed', title: '罗盘视频', error: { code: 'PAGE_CHANGED', message: '商品卡片已变化，请重新读取。', retryable: true } },
    { itemId: '3'.repeat(32), sourceKind: 'compass_ranking', status: 'pending', title: '取消后待恢复', error: null },
  ] };
  return {
    'business-center': { state: business, expected: { results: business.results, failures: business.failures, unparseableItems: business.unparseableItems } },
    top200: { state: top, expected: { results: top.results, failures: top.failures } },
    'video-ranking': { state: video, expected: { results: [
      { ...video.checkpoint.completedVideos['1:1'], status: 'completed' },
      { rank: 1, videoIndex: 2, status: 'failed', error: video.checkpoint.failedVideos['1:2'] },
      { ...video.checkpoint.completedVideos['2:1'], status: 'completed' },
    ] } },
    'manual-video': { state: manual, expected: { results: manual.items } },
  };
}

function coldImport(root, dependencyRoot) {
  root = path.resolve(root); dependencyRoot = fs.realpathSync(dependencyRoot);
  const playwright = require(path.join(root, 'node_modules/playwright-core'));
  const originals = [];
  function forbid(object, key) {
    const original = object[key]; originals.push(() => { object[key] = original; });
    object[key] = () => { throw new Error(`Cold import attempted side effect: ${key}`); };
  }
  forbid(playwright.chromium, 'launch'); forbid(playwright.chromium, 'connectOverCDP');
  forbid(require('node:http'), 'createServer'); forbid(require('node:net'), 'connect');
  for (const key of ['spawn', 'spawnSync', 'execSync', 'execFileSync']) forbid(require('node:child_process'), key);
  forbid(fs, 'mkdirSync'); forbid(fs, 'writeFileSync'); forbid(fs, 'appendFileSync');
  try {
    const toolIds = ['business-center', 'top200', 'video-ranking', 'manual-video'];
    const loaded = toolIds.map(toolId => {
      const adapter = require(path.join(root, `toolbox/node/adapters/${toolId}.cjs`));
      if (typeof adapter.read_results !== 'function') throw new Error(`Missing actual read_results: ${toolId}`);
      return adapter.descriptor.toolId || adapter.descriptor.id;
    });
    for (const file of Object.keys(require.cache)) {
      if (file === __filename) continue;
      const inside = directory => { const relative = path.relative(directory, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
      if (!inside(root) && !inside(dependencyRoot)) throw new Error(`Dependency escaped isolated layout: ${file}`);
    }
    return { toolIds: loaded, sourceModules: Object.keys(require.cache).filter(file => file.startsWith(root + path.sep)).map(file => path.relative(root, file)),
      sharedPlaywright: require.resolve(path.join(root, 'node_modules/playwright-core')),
      sharedExcel: require.resolve(path.join(root, 'node_modules/exceljs')) };
  } finally { for (const restore of originals.reverse()) restore(); }
}

if (require.main === module) {
  const result = process.argv[2] === 'fixtures' ? fixtures()
    : process.argv[2] === 'cold-import' ? coldImport(process.argv[3], process.argv[4])
      : (() => { throw new Error('Unknown integration fixture command'); })();
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { fixtures, coldImport };
