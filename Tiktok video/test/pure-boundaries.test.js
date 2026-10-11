'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright-core');

// Guard the imports: neither the pure helpers nor module loading may start Edge.
const launch = mock.method(chromium, 'launch', () => { throw new Error('Unexpected browser launch'); });
const connect = mock.method(chromium, 'connectOverCDP', () => { throw new Error('Unexpected browser connection'); });
const server = mock.method(http, 'createServer', () => { throw new Error('Unexpected media server'); });
const { allowedTrend, safePart, sharedProductNameAcrossCaptions } = require('../collector');
const { visualOverlapPercent, openingSubjectOverlapPercent } = require('../video-fingerprint');
const importCalls = [launch.mock.callCount(), connect.mock.callCount(), server.mock.callCount()];
mock.restoreAll();

const frame = (bits) => ((1n << BigInt(bits)) - 1n).toString(16).padStart(16, '0');
const fingerprint = (frames) => ({ duration: frames.length, frames });
const repeated = (bits, count) => fingerprint(Array(count).fill(frame(bits)));

test('importing collector and fingerprint does not launch/connect Edge or start a media server', () => {
  assert.deepEqual(importCalls, [0, 0, 0]);
});

for (const [mode, expected] of [
  ['first', { first: true, up: false, other: false, unparseable: false }],
  ['up_and_first', { first: true, up: true, other: false, unparseable: false }],
]) {
  test(`trend policy ${mode} preserves every recognized trend outcome`, () => {
    for (const [trend, accepted] of Object.entries(expected)) {
      assert.equal(allowedTrend(trend, mode), accepted, trend);
    }
  });
}

test('safe output names remove Windows path/control characters and trailing dots/spaces', () => {
  assert.equal(safePart('商品/视频:*?\n. '), '商品_视频____');
  assert.equal(safePart('... '), '视频');
});

test('safe output names protect Windows reserved names', () => {
  for (const reserved of ['CON', 'nul.txt', 'COM1', 'LPT9.mp4']) {
    assert.equal(safePart(reserved), `_${reserved}`);
  }
});

test('safe name limits count Unicode characters without splitting an emoji', () => {
  assert.equal(safePart('粥😀米饭', 2), '粥😀');
});

test('naming falls back to product subject when no captions are available', () => {
  assert.equal(sharedProductNameAcrossCaptions('【到手60条】免炖小米粥独立包装免煮冲泡即食', []), '免炖小米粥');
});

test('sequence comparison requires at least one sequence with twelve frames', () => {
  assert.equal(visualOverlapPercent(repeated(0, 11), repeated(0, 11)), 0);
  assert.equal(visualOverlapPercent(repeated(0, 12), repeated(0, 12)), 100);
});

test('sequence comparison divides by the shorter sequence when one is at least twelve frames', () => {
  assert.equal(visualOverlapPercent(repeated(0, 5), repeated(0, 12)), 100);
  assert.equal(visualOverlapPercent(repeated(0, 12), repeated(0, 5)), 100);
});

test('sequence frame distance twelve is included and thirteen is excluded', () => {
  assert.equal(visualOverlapPercent(repeated(0, 12), repeated(12, 12)), 100);
  assert.equal(visualOverlapPercent(repeated(0, 12), repeated(13, 12)), 0);
});

test('sequence scores expose the eighty-percent boundary without reimplementing dedupe decisions', () => {
  const left = repeated(0, 15);
  assert.equal(visualOverlapPercent(left, fingerprint([...Array(12).fill(frame(0)), ...Array(3).fill(frame(64))])), 80);
  assert.equal(visualOverlapPercent(left, fingerprint([...Array(11).fill(frame(0)), ...Array(4).fill(frame(64))])), 73);
});

test('sequence matching preserves frame order', () => {
  const left = fingerprint([...Array(6).fill(frame(0)), ...Array(6).fill(frame(64))]);
  const reversed = fingerprint([...Array(6).fill(frame(64)), ...Array(6).fill(frame(0))]);
  assert.equal(visualOverlapPercent(left, reversed), 50);
});

test('opening comparison only uses the first five samples', () => {
  const left = repeated(0, 12);
  const right = fingerprint([...Array(5).fill(frame(0)), ...Array(7).fill(frame(64))]);
  assert.equal(openingSubjectOverlapPercent(left, right), 100);
});

test('opening frame distance sixteen is included and seventeen is excluded', () => {
  assert.equal(openingSubjectOverlapPercent(repeated(0, 5), repeated(16, 5)), 100);
  assert.equal(openingSubjectOverlapPercent(repeated(0, 5), repeated(17, 5)), 0);
});

test('opening score distinguishes four-of-five from three-of-five matching frames', () => {
  const left = repeated(0, 5);
  assert.equal(openingSubjectOverlapPercent(left, fingerprint([...Array(4).fill(frame(0)), frame(64)])), 80);
  assert.equal(openingSubjectOverlapPercent(left, fingerprint([...Array(3).fill(frame(0)), ...Array(2).fill(frame(64))])), 60);
});

test('missing fingerprint metadata does not produce a positive score', () => {
  assert.equal(visualOverlapPercent(null, repeated(0, 12)), 0);
  assert.equal(openingSubjectOverlapPercent(repeated(0, 5), null), 0);
  assert.equal(visualOverlapPercent({ frames: [] }, { frames: [] }), 0);
  assert.equal(openingSubjectOverlapPercent({ frames: [] }, repeated(0, 5)), 0);
});

// These are real integration expectations, not tests of a copied algorithm.
// runTask closes over browser, storage and downloader functions; no injectable
// pure boundary currently exposes rank limits, candidate count or recovery.
for (const fixture of require('./boundary-expectations.json')) {
  test(`pending integration: ${fixture.name}`, { skip: fixture.reason }, () => {});
}
