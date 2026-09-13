const test = require('node:test');
const assert = require('node:assert/strict');
const { advancePageWithRetry, runAttempts, waitForStablePage } = require('../collector_retry');

test('商品第一次失败、第二次成功时只返回一条成功结果', async () => {
  let calls = 0;
  const result = await runAttempts({
    operation: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, reason: '抽屉未打开' } : { ok: true, detail: { salesAmount: '¥1万-¥2万' } };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.detail.salesAmount, '¥1万-¥2万');
});

test('商品前两次失败、第三次成功时不进入无数据', async () => {
  let calls = 0;
  const unavailable = [];
  const result = await runAttempts({
    operation: async () => {
      calls += 1;
      return calls < 3 ? { ok: false, reason: '金额尚未加载' } : { ok: true, detail: { periodChange: '20%' } };
    },
  });
  if (!result.ok) unavailable.push(result);

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(unavailable.length, 0);
});

test('商品三次均失败时只记录一次无数据', async () => {
  let calls = 0;
  const unavailable = [];
  const result = await runAttempts({
    operation: async () => {
      calls += 1;
      return { ok: false, reason: '未找到成交金额指标' };
    },
  });
  if (!result.ok) unavailable.push(result);

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].reason, '未找到成交金额指标');
});

test('页码已变化但内容延迟时只等待，不会再次点击导致跳页', async () => {
  const before = { page: 1, fingerprint: '旧页' };
  let state = { ...before };
  let clickCount = 0;

  const result = await advancePageWithRetry({
    before,
    getState: async () => ({ ...state }),
    clickNext: async () => {
      clickCount += 1;
      state = { page: 2, fingerprint: '旧页' };
      return true;
    },
    wait: async (waitMs) => {
      if (waitMs === 5000) state = { page: 2, fingerprint: '新页' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.page, 2);
  assert.equal(result.attempts, 2);
  assert.equal(clickCount, 1);
});

test('三次翻页都没有变化时明确失败，不生成伪成功状态', async () => {
  const before = { page: 1, fingerprint: '旧页' };
  let clickCount = 0;
  const result = await advancePageWithRetry({
    before,
    getState: async () => ({ ...before }),
    clickNext: async () => { clickCount += 1; return true; },
    wait: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(clickCount, 1);
  assert.match(result.reason, /内容仍未稳定/);
});

test('下一页按钮短暂不可用时继续等待并允许后续重试成功', async () => {
  const before = { page: 1, fingerprint: '旧页' };
  let state = { ...before };
  let callCount = 0;
  const result = await advancePageWithRetry({
    before,
    getState: async () => ({ ...state }),
    clickNext: async () => {
      callCount += 1;
      if (callCount === 1) return false;
      if (callCount === 2) state = { page: 2, fingerprint: '新页' };
      return true;
    },
    wait: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(callCount, 2);
  assert.equal(result.clickCount, 1);
});

test('翻页点击已接收但页码延迟更新时不会重复点击', async () => {
  const before = { page: 1, fingerprint: '旧页' };
  let state = { ...before };
  let clickCount = 0;
  const result = await advancePageWithRetry({
    before,
    getState: async () => ({ ...state }),
    clickNext: async () => { clickCount += 1; return true; },
    wait: async (waitMs) => {
      if (waitMs === 8000) state = { page: 2, fingerprint: '新页' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(clickCount, 1);
});

test('部分行先出现时等待到整页行数稳定后才允许读取', async () => {
  let state = { page: 2, fingerprint: '10行', rawRowCount: 10, completeRowCount: 10, hasNext: true, loading: false };
  const result = await waitForStablePage({
    expectedRowCount: 27,
    getState: async () => ({ ...state }),
    wait: async (waitMs) => {
      if (waitMs === 3000) state = { page: 2, fingerprint: '27行', rawRowCount: 27, completeRowCount: 27, hasNext: true, loading: false };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.state.completeRowCount, 27);
});

test('页面始终只有部分行时稳定确认失败', async () => {
  const partial = { page: 2, fingerprint: '10行', rawRowCount: 10, completeRowCount: 10, hasNext: true, loading: false };
  const result = await waitForStablePage({
    expectedRowCount: 27,
    getState: async () => ({ ...partial }),
    wait: async () => {},
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /未完整稳定/);
});

test('首期页按分页器页大小校验，稳定的部分行也不能建立错误基准', async () => {
  const partial = {
    page: 1,
    fingerprint: '10行',
    rawRowCount: 10,
    completeRowCount: 10,
    pageSize: 27,
    isLastPage: false,
    loading: false,
  };
  const result = await waitForStablePage({
    expectedRowCount: null,
    getState: async () => ({ ...partial }),
    wait: async () => {},
  });

  assert.equal(result.ok, false);
});

test('有后续分页但无法确定页大小时拒绝生成完整报告', async () => {
  const unknownSize = {
    page: 1,
    fingerprint: '20行',
    rawRowCount: 20,
    completeRowCount: 20,
    pageSize: null,
    isLastPage: false,
    loading: false,
  };
  const result = await waitForStablePage({
    expectedRowCount: null,
    getState: async () => ({ ...unknownSize }),
    wait: async () => {},
  });

  assert.equal(result.ok, false);
});
