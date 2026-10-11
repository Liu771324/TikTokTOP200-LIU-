'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sharedProductName, sharedProductNameAcrossCaptions, findVisualMatch, findCaptionMatch } = require('./collector');

test('uses the product subject when a caption only shares a generic scene word', () => {
  const product = '【到手60条】免炖小米粥独立包装免煮冲泡即食上班懒人营养早餐代餐';
  const caption = '早餐别瞎凑！这个免冲的粥太省心 #秋上新来抖音 #燕麦格雷 #燕麦系';

  assert.equal(sharedProductName(product, caption), '免炖小米粥');
});

test('falls back to a cleaned title that still contains the product subject', () => {
  const name = sharedProductName('新货无硫百合干煲汤煮粥营养干货食材', '今天给大家分享一款滋补食材');

  assert.match(name, /百合干/);
});

test('uses a product phrase shared by the first four video captions', () => {
  const product = '【到手60条】免炖小米粥独立包装免煮冲泡即食上班懒人营养早餐代餐';
  const captions = [
    '免炖小米粥来了，早八人的早餐',
    '今天试试这款免炖小米粥',
    '免炖小米粥不用煮也很绵密',
    '早上来一杯免炖小米粥',
  ];

  assert.equal(sharedProductNameAcrossCaptions(product, captions), '免炖小米粥');
});

test('does not treat matching captions as proof that videos are duplicates', () => {
  const index = {
    first: { path: '商品\\商品1.mp4', captionHash: 'same-caption', fingerprint: null },
  };

  assert.equal(findVisualMatch(null, index), null);
  assert.equal(findCaptionMatch('same-caption', index), index.first);
});
