// 采集器重试与分页状态确认。保持为无浏览器依赖的小模块，便于单元测试。

async function runAttempts({ attempts = 3, operation, onRetry = async () => {} }) {
  let lastResult = { ok: false, reason: '未知错误' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      result = await operation(attempt);
    } catch (error) {
      result = { ok: false, reason: `页面操作异常：${error.message}` };
    }

    if (result?.ok) return { ...result, attempts: attempt };
    lastResult = result || { ok: false, reason: '操作未返回结果' };

    if (attempt < attempts) {
      await onRetry({ attempt, result: lastResult });
    }
  }

  return { ...lastResult, ok: false, attempts };
}

function isExpectedPage(before, after) {
  return after.page === before.page + 1
    && Boolean(after.fingerprint)
    && after.fingerprint !== before.fingerprint;
}

async function advancePageWithRetry({
  before,
  attempts = 3,
  waitSchedule = [3000, 5000, 8000],
  settleMs = 2000,
  getState,
  clickNext,
  wait,
  onAttempt = () => {},
}) {
  const expectedPage = before.page + 1;
  let lastState = before;
  let clickCount = 0;
  let clickIssued = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const current = await getState();

    // 页码已经切到目标页但内容仍是旧页时只继续等，不能再次点“下一页”，否则会跳页。
    if (current.page === before.page) {
      if (!clickIssued) {
        const clicked = await clickNext();
        // 网络加载期间按钮可能短暂消失或变为 disabled；本轮继续等待，下轮再尝试。
        if (clicked) {
          clickCount += 1;
          clickIssued = true;
        }
      }
    } else if (current.page !== expectedPage) {
      return {
        ok: false,
        reason: `分页跳转异常：期望第 ${expectedPage} 页，实际第 ${current.page} 页`,
        attempts: attempt,
        clickCount,
        state: current,
      };
    }

    const waitMs = waitSchedule[Math.min(attempt - 1, waitSchedule.length - 1)];
    onAttempt({ attempt, waitMs, current });
    await wait(waitMs);
    lastState = await getState();

    if (isExpectedPage(before, lastState)) {
      await wait(settleMs);
      const settledState = await getState();
      if (isExpectedPage(before, settledState)) {
        return { ok: true, attempts: attempt, clickCount, state: settledState };
      }
      lastState = settledState;
    }
  }

  return {
    ok: false,
    reason: `三次尝试后第 ${expectedPage} 页内容仍未稳定`,
    attempts,
    clickCount,
    state: lastState,
  };
}

function isStablePageState(before, after, expectedRowCount) {
  const contentStable = before.page === after.page
    && before.fingerprint === after.fingerprint
    && before.rawRowCount === after.rawRowCount
    && before.completeRowCount === after.completeRowCount;
  const allRowsComplete = after.rawRowCount > 0 && after.rawRowCount === after.completeRowCount;
  const expected = expectedRowCount ?? after.pageSize;
  const expectedCountReached = expected == null
    ? after.isLastPage && after.completeRowCount > 0
    : (after.isLastPage
      ? after.completeRowCount > 0 && after.completeRowCount <= expected
      : after.completeRowCount === expected);
  return contentStable && allRowsComplete && expectedCountReached && !after.loading;
}

async function waitForStablePage({
  expectedRowCount = null,
  attempts = 3,
  waitSchedule = [2000, 3000, 5000],
  getState,
  wait,
  onAttempt = () => {},
}) {
  let before = await getState();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const waitMs = waitSchedule[Math.min(attempt - 1, waitSchedule.length - 1)];
    onAttempt({ attempt, waitMs, state: before });
    await wait(waitMs);
    const after = await getState();
    if (isStablePageState(before, after, expectedRowCount)) {
      return { ok: true, attempts: attempt, state: after };
    }
    before = after;
  }

  return {
    ok: false,
    attempts,
    state: before,
    reason: `页面数据未完整稳定（原始行 ${before.rawRowCount || 0}，完整行 ${before.completeRowCount || 0}）`,
  };
}

module.exports = { advancePageWithRetry, isExpectedPage, isStablePageState, runAttempts, waitForStablePage };
