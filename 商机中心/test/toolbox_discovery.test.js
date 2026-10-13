'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { discoverCategories, CATEGORY_ENDPOINT } = require('../category_discovery');

test('已提供page时复用真实发现解析，返回完整路径与valuePath且不另开CDP', async () => {
  let fetched;
  const page = {
    url: () => 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter',
    async evaluate(fn, argument) {
      return vm.runInNewContext(`(${fn.toString()})(argument)`, {
        argument,
        performance: { getEntriesByType: () => [{ name: `https://fxg.jinritemai.com${CATEGORY_ENDPOINT}?fixture=1` }] },
        async fetch(url, options) {
          fetched = { url, options };
          return { ok: true, json: async () => ({ code: 0, data: [
            { label: ' 测试父类 ', value: 1, children: [{ label: '测试子类', value: 2 }] },
          ] }) };
        },
      });
    },
  };
  const result = await discoverCategories({ page, cdpUrl: 'http://invalid.example.test:1' });
  assert.deepEqual(JSON.parse(JSON.stringify(result.categories)), [
    { displayPath: '测试父类', segments: ['测试父类'], valuePath: ['1'] },
    { displayPath: '测试父类 / 测试子类', segments: ['测试父类', '测试子类'], valuePath: ['1', '2'] },
  ]);
  assert.equal(fetched.options.credentials, 'include');
  assert.ok(fetched.url.includes(CATEGORY_ENDPOINT));
  assert.ok(Number.isFinite(Date.parse(result.discoveredAt)));
});

test('发现登录页立即返回LOGIN_REQUIRED，不访问类目接口', async () => {
  await assert.rejects(discoverCategories({ page: {
    url: () => 'https://fxg.jinritemai.com/login',
    async evaluate() { throw new Error('不应读取登录页'); },
  } }), error => error.code === 'LOGIN_REQUIRED');
});
