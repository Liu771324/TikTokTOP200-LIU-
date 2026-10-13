'use strict';

const vm = require('node:vm');
const PAGE_URL = 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter';

// Only the existing collector selectors are modeled. No network or browser process.
function fakeBusinessPage(rows, categoryLabel = '测试类目') {
  const state = { url: PAGE_URL, categoryLabel, categoryInputValue: '', rows, drawer: null, opens: [], closes: 0,
    waits: [], failClose: false, pageNumber: 1, sortDirection: 'descending' };
  const element = (text = '') => ({ innerText: text, textContent: text, children: [],
    querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null });
  const names = rows.map((row) => ({ ...element(row.keyword), click() {
    state.drawer = row;
    state.opens.push(row.keyword);
  } }));
  const headers = ['搜索词', '成交金额', '成交增速'].map(element);
  headers[1].getAttribute = (name) => name === 'aria-sort' ? state.sortDirection : null;
  const table = { ...element(), closest: () => element(),
    querySelector: (selector) => selector === 'tbody' ? { querySelectorAll: () => rows.map((row, index) => ({
      querySelectorAll: () => [
        { ...element(), querySelector: (selector) => selector.includes('__bu_card_title__') ? names[index] : null },
        element(row.salesAmount),
        { ...element(), querySelectorAll: (selector) => selector === 'svg path'
          ? [{ getAttribute: () => row.growthTrend === 'up' ? '#ff3b52' : '#00c87f' }] : [] },
      ],
    })) } : null,
    querySelectorAll: (selector) => selector === 'th' ? headers : selector.includes('__bu_card_title__') ? names : [],
  };
  function drawer() {
    if (!state.drawer) return null;
    const row = state.drawer;
    const detail = row.detail || { salesAmount: '¥2000', periodChange: '100%', trendDir: 'up' };
    const card = { ...element('成交金额'), querySelector: (selector) =>
      (detail.trendDir === 'down' ? selector.includes('Down') || selector.includes('Negative')
        : selector.includes('Up') || selector.includes('Positive')) ? element() : null };
    return { ...element(`${row.keyword}\n成交金额\n${detail.salesAmount}\n较上周期\n${detail.periodChange}`),
      querySelectorAll: (selector) => selector === '*' ? [{ ...element('近1天'), tagName: 'BUTTON', className: 'radio', click() {} }]
        : selector.includes('metricCard') ? [card] : [],
    };
  }
  const document = {
    querySelectorAll: (selector) => selector === 'table' ? [table] : [],
    querySelector(selector) {
      if (selector === '#category') return { value: state.categoryInputValue,
        closest: (selector) => selector === '.aurora-cascader' ? {
          querySelector: (selector) => selector === '.aurora-select-content-value' ? {
            ...element(state.categoryText ?? state.categoryLabel),
            getAttribute: (name) => name === 'title' ? state.categoryTitle ?? state.categoryLabel : null,
          } : null,
        } : null,
      };
      if (selector === '.aurora-pagination-item-active') return element(String(state.pageNumber));
      if (selector.includes('drawer-close')) return state.drawer ? { click() {
        if (!state.failClose) { state.drawer = null; state.closes += 1; }
      } } : null;
      if (selector === '.aurora-drawer-open') return drawer();
      return null;
    },
  };
  const page = {
    state,
    url: () => state.url,
    async goto(url) { state.url = url; },
    async waitForTimeout(ms) { state.waits.push(ms); },
    locator: () => ({ count: async () => state.drawer ? 1 : 0 }),
    keyboard: { async press() { if (!state.failClose) state.drawer = null; } },
    async evaluate(fn, argument) {
      return vm.runInNewContext(`(${fn.toString()})(argument)`, { document, argument });
    },
  };
  return page;
}

module.exports = { fakeBusinessPage, PAGE_URL };
