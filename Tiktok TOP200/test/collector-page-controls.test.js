'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readPeriods, readRankingNames, selectPreferredPeriod } = require('../collector');
const { choosePeriod } = require('../collector-utils');

function tab(text, selected, id) {
  return {
    innerText: text,
    textContent: text,
    id,
    selected,
    getAttribute(name) {
      if (name === 'aria-selected') return this.selected ? 'true' : 'false';
      if (name === 'aria-disabled') return 'false';
      return null;
    },
  };
}

function pageWithTabs(tabs) {
  const groups = new Map();
  for (const item of tabs) {
    const groupId = item.id.match(/^rc-tabs-\d+/)?.[0] || 'default';
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(item);
  }
  const tabLists = [...groups.values()].map((items) => {
    const list = {
      querySelectorAll(selector) {
        return selector === '[role="tab"]' ? items : [];
      },
    };
    items.forEach((item) => { item.closest = () => list; });
    return list;
  });
  return {
    async evaluate(callback, argument) {
      const previous = global.document;
      global.document = {
        querySelectorAll(selector) {
          if (selector === 'input[type="radio"]') return [];
          if (selector === '[role="tab"]') return tabs;
          if (selector === '[role="tablist"]') return tabLists;
          return [];
        },
      };
      try {
        return callback(argument);
      } finally {
        global.document = previous;
      }
    },
    getByRole(role, options) {
      const target = tabs.find((item) => role === 'tab' && item.innerText === options.name);
      return {
        async count() { return target ? 1 : 0; },
        async getAttribute(name) { return target?.getAttribute(name) ?? null; },
        async click() {
          const list = target?.closest('[role="tablist"]');
          for (const item of list?.querySelectorAll('[role="tab"]') || []) item.selected = false;
          if (target) target.selected = true;
        },
      };
    },
    async waitForTimeout() {},
  };
}

test('改版后的周期 tab 仍可识别实时与近1天，不依赖 radio', async () => {
  const page = pageWithTabs([
    tab('总榜', true, 'rc-tabs-0-tab-1'),
    tab('实时', false, 'rc-tabs-9-tab-realTime'),
    tab('近1天', false, 'rc-tabs-9-tab-one'),
    tab('近7天', true, 'rc-tabs-9-tab-seven'),
    tab('近30天', false, 'rc-tabs-9-tab-thirty'),
    tab('更多', false, 'rc-tabs-9-tab-more'),
  ]);

  const periods = await readPeriods(page);
  assert.deepEqual(periods, [
    { value: 'realTime', label: '实时', checked: false, disabled: false, control: 'tab' },
    { value: 'one', label: '近1天', checked: false, disabled: false, control: 'tab' },
    { value: 'seven', label: '近7天', checked: true, disabled: false, control: 'tab' },
    { value: 'thirty', label: '近30天', checked: false, disabled: false, control: 'tab' },
  ]);
  assert.equal(choosePeriod(periods).control, 'tab');
});

test('正式周期选择流程会点击新 tab 并校验选中状态', async () => {
  const page = pageWithTabs([
    tab('搜索榜', true, 'rc-tabs-0-tab-7'),
    tab('近1天', false, 'rc-tabs-9-tab-one'),
    tab('近7天', true, 'rc-tabs-9-tab-seven'),
    tab('近30天', false, 'rc-tabs-9-tab-thirty'),
  ]);

  const selected = await selectPreferredPeriod(page);
  assert.equal(selected.actualPeriod, '近1天');
  assert.equal(selected.control, 'tab');
  assert.equal(await page.getByRole('tab', { name: '近1天', exact: true }).getAttribute('aria-selected'), 'true');
});

test('榜单发现排除同页新增的周期 tab，只保留前六个业务榜单', async () => {
  const page = pageWithTabs([
    tab('总榜', false, 'rc-tabs-0-tab-1'),
    tab('搜索榜', true, 'rc-tabs-0-tab-7'),
    tab('直播榜', false, 'rc-tabs-0-tab-2'),
    tab('商品卡榜', false, 'rc-tabs-0-tab-3'),
    tab('达人带货榜', false, 'rc-tabs-0-tab-4'),
    tab('短视频榜', false, 'rc-tabs-0-tab-5'),
    tab('实时爆品挖掘榜', false, 'rc-tabs-0-tab-6'),
    tab('近1天', false, 'rc-tabs-9-tab-one'),
    tab('近7天', true, 'rc-tabs-9-tab-seven'),
    tab('近30天', false, 'rc-tabs-9-tab-thirty'),
    tab('更多', false, 'rc-tabs-9-tab-more'),
  ]);

  assert.deepEqual(await readRankingNames(page), [
    '总榜',
    '搜索榜',
    '直播榜',
    '商品卡榜',
    '达人带货榜',
    '短视频榜',
  ]);
});
