'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const edge = require('../edge');

test('Edge 先打开商机中心登录入口，采集时再进入 TOP200 页面', () => {
  assert.equal(edge.LOGIN_URL, 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter');
  assert.equal(edge.TARGET_URL, 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank');
  assert.notEqual(edge.LOGIN_URL, edge.TARGET_URL);
});
