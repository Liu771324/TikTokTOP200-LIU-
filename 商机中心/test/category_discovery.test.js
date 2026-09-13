const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenCategoryTree, normalizeCategory } = require('../category_discovery');

test('类目树会生成每个可选节点的完整路径和层级快照', () => {
  const categories = flattenCategoryTree([
    {
      value: 1,
      label: ' 传统滋补 ',
      children: [
        { value: 2, label: '药食同源食品', children: [{ value: 3, label: '茯苓', children: null }] },
      ],
    },
  ]);

  assert.deepEqual(categories.map((item) => item.displayPath), [
    '传统滋补',
    '传统滋补 / 药食同源食品',
    '传统滋补 / 药食同源食品 / 茯苓',
  ]);
  assert.deepEqual(categories[2].segments, ['传统滋补', '药食同源食品', '茯苓']);
  assert.deepEqual(categories[2].valuePath, ['1', '2', '3']);
});

test('类目规范化会统一空格和斜杠并拒绝空路径', () => {
  assert.deepEqual(normalizeCategory({ segments: [' 传统滋补 ', ' 药食同源食品 '] }), {
    displayPath: '传统滋补 / 药食同源食品',
    segments: ['传统滋补', '药食同源食品'],
    valuePath: [],
  });
  assert.equal(normalizeCategory({ displayPath: ' / ' }), null);
});
