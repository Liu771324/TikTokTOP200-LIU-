'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTrend,
  trendSnapshotFromHtml,
  selectProductLinkCandidate,
  safeProductUrl,
  inferRank,
  choosePeriod,
  productKey,
  mapBusinessFields,
  hasPageAdvanced,
  runWithRetries,
} = require('../collector-utils');
const fs = require('node:fs');
const path = require('node:path');

test('识别单数和多位数上升名次', () => {
  assert.deepEqual(parseTrend({ up: true, valueText: '1' }), { trendType: 'up', trendText: '↑ 1', riseCount: 1 });
  assert.deepEqual(parseTrend({ classes: 'value up-abcd', valueText: '12' }), { trendType: 'up', trendText: '↑ 12', riseCount: 12 });
});

test('识别首次上榜', () => {
  assert.equal(parseTrend({ first: true, text: '首次上榜' }).trendType, 'first');
});

test('排除下降、持平、横线和空趋势', () => {
  assert.equal(parseTrend({ down: true, valueText: '4' }).trendType, 'down');
  assert.equal(parseTrend({ equal: true, text: '持平' }).trendType, 'equal');
  assert.equal(parseTrend({ text: '-' }).trendType, 'none');
  assert.equal(parseTrend({ text: '' }).trendType, 'none');
});

test('无法识别的趋势进入解析异常', () => {
  assert.equal(parseTrend({ text: '未知变化' }).trendType, 'unparseable');
});

test('搜索榜纯排名数字不进入趋势文本，没有趋势容器时按 none 处理', () => {
  const markup = '<div class="rank-cell"><span class="rank-value">4</span></div>';
  assert.deepEqual(parseTrend(trendSnapshotFromHtml(markup)), { trendType: 'none', trendText: '', riseCount: null });
});

test('搜索榜只解析独立趋势容器，不把原始排名混入升降数字', () => {
  const markup = '<div class="rank-cell"><span class="rank-value">6</span><span class="changeRatioWrap-abcd"><i class="upIdentify-abcd"></i><span class="cp-change-ratio-value">2</span></span></div>';
  assert.deepEqual(parseTrend(trendSnapshotFromHtml(markup)), { trendType: 'up', trendText: '↑ 2', riseCount: 2 });
});

test('商品标题链接优先于二维码入口，只有二维码时不尝试链接', () => {
  const candidate = selectProductLinkCandidate([
    { index: 0, text: '商品A', href: 'https://example.test/product?id=1', classes: 'product-name' },
    { index: 1, text: '', href: '', classes: 'ecom-popover-open' },
  ], '商品A');
  assert.equal(candidate.href, 'https://example.test/product?id=1');
  assert.equal(selectProductLinkCandidate([{ index: 0, text: '', href: '', classes: 'ecom-popover-open' }], '商品A'), null);
});

test('商品链接只接受 http 和 https 协议', () => {
  assert.equal(safeProductUrl('https://example.test/product?id=1'), 'https://example.test/product?id=1');
  assert.equal(safeProductUrl('http://example.test/product?id=1'), 'http://example.test/product?id=1');
  assert.equal(safeProductUrl('javascript:alert(1)'), '');
  assert.equal(safeProductUrl('file:///C:/secret.txt'), '');
});

test('末页不足每页条数时仍按稳定页容量推导原始排名', () => {
  assert.equal(inferRank('', 20, 1, 10), 191);
  assert.equal(inferRank('', 20, 5, 10), 195);
  assert.equal(inferRank('198', 20, 5, 10), 198);
});

test('周期实时优先，否则回退近1天', () => {
  assert.equal(choosePeriod([{ value: 'one', label: '近1天' }, { value: 'realTime', label: '实时' }]).actualPeriod, '实时');
  assert.equal(choosePeriod([{ value: 'one', label: '近1天' }]).actualPeriod, '近1天');
  assert.equal(choosePeriod([{ value: 'seven', label: '近7天' }]), null);
});

test('组合内优先按商品链接去重，无链接时按商品和店铺', () => {
  assert.equal(productKey({ productUrl: 'https://x.test/detail?id=123&from=a', productName: 'A', shopName: 'B' }), 'https://x.test/detail?id=123');
  assert.equal(productKey({ productName: 'A', shopName: 'B' }), 'A\u0000B');
});

test('动态表头进入 extraFields，操作列被忽略', () => {
  const result = mapBusinessFields(
    ['排名', '商品信息', '店铺信息', '直播间用户支付金额', '带货直播间数', '操作'],
    ['1', '商品A', '店铺B', '¥1万-¥2万', '20-30', '查看详情'],
  );
  assert.equal(result.productName, '商品A');
  assert.equal(result.shopName, '店铺B');
  assert.deepEqual(result.extraFields, { 直播间用户支付金额: '¥1万-¥2万', 带货直播间数: '20-30' });
});

test('榜单上下文字段保持原始语义，账号和短视频定位列不写入结果', () => {
  const search = mapBusinessFields(
    ['排名', '商品信息', '热搜词', '商品曝光人数', '搜索用户支付金额', '操作'],
    ['1', '商品A', '示例词', '1万-2万', '¥1万-¥2万', '查看详情'],
    '搜索榜',
  );
  assert.equal(search.userPaymentAmount, '');
  assert.deepEqual(search.extraFields, {
    热搜词: '示例词',
    商品曝光人数: '1万-2万',
    搜索用户支付金额: '¥1万-¥2万',
  });
  const live = mapBusinessFields(
    ['商品信息', '直播账号', '直播间用户支付金额', '带货直播间数'],
    ['商品A', '不应保存的账号', '¥2万-¥3万', '20-30'],
    '直播榜',
  );
  assert.equal('直播账号' in live.extraFields, false);
  assert.equal(live.extraFields.直播间用户支付金额, '¥2万-¥3万');
});

test('空表头保留列占位，不会让后续业务字段错位', () => {
  const mapped = mapBusinessFields(
    ['排名', '商品信息', '', '店铺信息', '用户支付金额'],
    ['1', '商品A', '未命名交互列', '店铺B', '¥1万-¥2万'],
    '总榜',
  );
  assert.equal(mapped.shopName, '店铺B');
  assert.equal(mapped.userPaymentAmount, '¥1万-¥2万');
});

test('翻页同时要求页码和整页指纹变化', () => {
  const before = { page: 1, fingerprint: 'a' };
  assert.equal(hasPageAdvanced(before, { page: 2, fingerprint: 'b' }), true);
  assert.equal(hasPageAdvanced(before, { page: 2, fingerprint: 'a' }), false);
  assert.equal(hasPageAdvanced(before, { page: 1, fingerprint: 'b' }), false);
});

test('页面卡顿时最多重试三次并可在第三次恢复', async () => {
  let calls = 0;
  const failures = [];
  const result = await runWithRetries(async () => {
    calls += 1;
    if (calls < 3) throw new Error(`卡顿${calls}`);
    return '已恢复';
  }, {
    attempts: 3,
    onFailure: async (error, attempt, finalAttempt) => failures.push({ message: error.message, attempt, finalAttempt }),
  });
  assert.equal(result, '已恢复');
  assert.equal(calls, 3);
  assert.deepEqual(failures, [
    { message: '卡顿1', attempt: 1, finalAttempt: false },
    { message: '卡顿2', attempt: 2, finalAttempt: false },
  ]);
});

test('持续卡死三次后停止并保留最终错误', async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetries(async () => {
      calls += 1;
      throw new Error('页面仍无响应');
    }, { attempts: 3 }),
    /页面仍无响应/,
  );
  assert.equal(calls, 3);
});

test('脱敏 DOM fixture 同时覆盖 aurora 与 ecom 行', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'top200-table.html'), 'utf8');
  const rowMarkup = [...html.matchAll(/<tr class="(?:aurora|ecom)-table-row">([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
  assert.equal(rowMarkup.length, 2);
  assert.equal(parseTrend(trendSnapshotFromHtml(rowMarkup[0])).trendType, 'up');
  assert.equal(parseTrend(trendSnapshotFromHtml(rowMarkup[1])).trendType, 'first');
});
