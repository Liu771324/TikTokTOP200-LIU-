'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi, Cancelled } = require('../node/sdk.cjs');

test('cancelled operation cannot enter registration wait', async () => {
  const pending = new Map();
  const api = createApi({}, () => assert.fail('must not send'), pending);
  api.control.cancelled = true;
  await assert.rejects(api.register({ candidateId: 'late' }), Cancelled);
  assert.equal(pending.size, 0);
});

test('closed API rejects late events and candidates', async () => {
  const api = createApi({}, () => assert.fail('must not send'), new Map());
  api.close();
  assert.throws(() => api.emit('progress', {}), Cancelled);
  await assert.rejects(api.register({ candidateId: 'late' }), Cancelled);
});

test('single item download cannot write manual task checkpoint', () => {
  const api = createApi({}, () => {}, new Map(), 'download_item');
  assert.throws(() => api.checkpoint({}), { code: 'UNSUPPORTED_OPERATION' });
});

test('registration send failure removes pending promise', async () => {
  const pending = new Map();
  const api = createApi({}, () => { throw new Error('pipe broken'); }, pending);
  await assert.rejects(api.register({ candidateId: 'test' }), /pipe broken/);
  assert.equal(pending.size, 0);
});
