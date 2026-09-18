const test = require('node:test');
const assert = require('node:assert/strict');
const { groupProducts } = require('../product_grouping');

test('多个重复出现西梅干的商品进入西梅干组', () => {
  const grouped = groupProducts([
    { keyword: '新疆软糯西梅干' },
    { keyword: '无添加西梅干' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), ['西梅干', '西梅干']);
});

test('黄芪覆盖的商品更多时黄芪膏归入更宽泛的黄芪组', () => {
  const grouped = groupProducts([
    { keyword: '黄芪膏礼盒' },
    { keyword: '古法黄芪膏' },
    { keyword: '无硫黄芪片' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), ['黄芪', '黄芪', '黄芪']);
});

test('只有包装通用词相同的商品保持互相独立的未归类', () => {
  const grouped = groupProducts([
    { keyword: '沙棘原浆礼盒' },
    { keyword: '黑芝麻丸礼盒' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), ['未归类', '未归类']);
});

test('跨类目统一分组且多候选商品只进入首次出现的一组', () => {
  const grouped = groupProducts([
    { keyword: '黄芪片', categoryPath: '类目 A' },
    { keyword: '黄芪西梅干', categoryPath: '类目 B' },
    { keyword: '西梅干果脯', categoryPath: '类目 C' },
  ]);

  assert.deepEqual(grouped.map((item) => [item.keyword, item.productGroup, item.categoryPath]), [
    ['黄芪片', '黄芪', '类目 A'],
    ['黄芪西梅干', '黄芪', '类目 B'],
    ['西梅干果脯', '西梅干', '类目 C'],
  ]);
});

test('单条商品仍可按明确的商品核心词归类', () => {
  const grouped = groupProducts([
    { keyword: '话梅粒' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), ['话梅']);
});

test('产地和加工属性不能覆盖红枣灰枣商品词', () => {
  const grouped = groupProducts([
    { keyword: '新疆若羌无核灰枣' },
    { keyword: '新疆免洗无核灰枣' },
    { keyword: '新疆去皮无核灰枣' },
    { keyword: '新疆无核香甜红枣' },
    { keyword: '新疆去皮即食红枣' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), [
    '灰枣',
    '灰枣',
    '灰枣',
    '红枣',
    '红枣',
  ]);
});

test('话梅变体归入话梅且西梅干不被共享后缀梅干覆盖', () => {
  const grouped = groupProducts([
    { keyword: '话梅干' },
    { keyword: '话梅粒' },
    { keyword: '西梅干' },
    { keyword: '新疆软糯西梅干' },
  ]);

  assert.deepEqual(grouped.map((item) => [item.keyword, item.productGroup]), [
    ['话梅干', '话梅'],
    ['话梅粒', '话梅'],
    ['西梅干', '西梅干'],
    ['新疆软糯西梅干', '西梅干'],
  ]);
});

test('相同西梅干搜索词的不同销量记录逐条保留', () => {
  const grouped = groupProducts([
    { keyword: '西梅干', totalSales: '¥10万-¥25万', page: 1 },
    { keyword: '西梅干', totalSales: '¥25万-¥50万', page: 2 },
  ]);

  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((item) => [item.keyword, item.totalSales, item.page, item.productGroup]), [
    ['西梅干', '¥10万-¥25万', 1, '西梅干'],
    ['西梅干', '¥25万-¥50万', 2, '西梅干'],
  ]);
});

test('无硫不能把不同商品合并为同一产品组', () => {
  const grouped = groupProducts([
    { keyword: '无硫麦冬' },
    { keyword: '无硫党参' },
    { keyword: '无硫玉竹' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), ['麦冬', '党参', '玉竹']);
});

test('云南不能把不同商品合并为同一产品组', () => {
  const grouped = groupProducts([
    { keyword: '云南金麦冬' },
    { keyword: '云南玉蝴蝶' },
    { keyword: '云南拉丝雪燕' },
  ]);

  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped.map((item) => item.keyword), [
    '云南金麦冬',
    '云南玉蝴蝶',
    '云南拉丝雪燕',
  ]);
  assert.ok(grouped.every((item) => item.productGroup !== '云南'));
});

test('芒果干和芒果片在全任务范围统一归入芒果', () => {
  const grouped = groupProducts([
    { keyword: '零食芒果干' },
    { keyword: '芒果片' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), ['芒果', '芒果']);
});

test('重复搜索词不会被删除合并或覆盖', () => {
  const grouped = groupProducts([
    { keyword: '天麻片', totalSales: '销量 A', categoryPath: '类目 A' },
    { keyword: '天麻片', totalSales: '销量 B', categoryPath: '类目 B' },
  ]);

  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((item) => [item.keyword, item.totalSales, item.categoryPath]), [
    ['天麻片', '销量 A', '类目 A'],
    ['天麻片', '销量 B', '类目 B'],
  ]);
});

test('地黄和铁皮石斛产品族使用明确别名规则', () => {
  const grouped = groupProducts([
    { keyword: '地黄' },
    { keyword: '熟地' },
    { keyword: '熟地黄' },
    { keyword: '铁皮石斛' },
    { keyword: '铁皮枫斗' },
  ]);

  assert.deepEqual(grouped.map((item) => [item.keyword, item.productGroup]), [
    ['地黄', '地黄'],
    ['熟地', '地黄'],
    ['熟地黄', '地黄'],
    ['铁皮石斛', '铁皮石斛'],
    ['铁皮枫斗', '铁皮石斛'],
  ]);
});

test('明确的葡萄干复合商品词不会降级为果干', () => {
  const grouped = groupProducts([
    { keyword: '大颗粒葡萄干' },
  ]);

  assert.deepEqual(grouped.map((item) => item.productGroup), ['葡萄干']);
});

test('重复行不参与候选支持度计算但仍逐条回填', () => {
  const grouped = groupProducts([
    { keyword: '神秘草本条', totalSales: '销量 A' },
    { keyword: '神秘草本条', totalSales: '销量 B' },
  ]);

  assert.deepEqual(grouped.map((item) => [item.totalSales, item.productGroup]), [
    ['销量 A', '未归类'],
    ['销量 B', '未归类'],
  ]);
});

test('滋补新货和煲汤不能覆盖党参麦冬玉竹商品词', () => {
  const grouped = groupProducts([
    { keyword: '无硫滋补党参' },
    { keyword: '云南滋补金麦冬' },
    { keyword: '无硫新货玉竹干片' },
    { keyword: '无硫新货煲汤玉竹片' },
    { keyword: '甘肃党参煲汤干货' },
  ]);
  const groupsByKeyword = new Map(grouped.map((item) => [item.keyword, item.productGroup]));

  assert.equal(grouped.length, 5);
  assert.equal(groupsByKeyword.get('无硫滋补党参'), '党参');
  assert.equal(groupsByKeyword.get('云南滋补金麦冬'), '麦冬');
  assert.equal(groupsByKeyword.get('无硫新货玉竹干片'), '玉竹');
  assert.equal(groupsByKeyword.get('无硫新货煲汤玉竹片'), '玉竹');
  assert.equal(groupsByKeyword.get('甘肃党参煲汤干货'), '党参');
});

test('铁皮石斛和铁皮枫斗不被支持度更高的石斛宽词覆盖', () => {
  const grouped = groupProducts([
    { keyword: '云南石斛原浆' },
    { keyword: '霍山石斛干货' },
    { keyword: '铁皮石斛滋补礼盒' },
    { keyword: '霍山铁皮石斛切片' },
    { keyword: '胶质铁皮枫斗' },
  ]);
  const groupsByKeyword = new Map(grouped.map((item) => [item.keyword, item.productGroup]));

  assert.equal(groupsByKeyword.get('铁皮石斛滋补礼盒'), '铁皮石斛');
  assert.equal(groupsByKeyword.get('霍山铁皮石斛切片'), '铁皮石斛');
  assert.equal(groupsByKeyword.get('胶质铁皮枫斗'), '铁皮石斛');
});
