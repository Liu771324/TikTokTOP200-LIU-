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

test('waiting for login resumes only after explicit control and can be cancelled', async () => {
  const states = [];
  const api = createApi({}, (type, data) => states.push(data.state), new Map());
  const waiting = api.waitForUser('请登录');
  assert.equal(states[0], 'waiting_user');
  api.control.waitingUser = false;
  await waiting;
  assert.deepEqual(states, ['waiting_user', 'running']);
  const cancelled = api.waitForUser('请验证');
  api.control.cancelled = true;
  await assert.rejects(cancelled, Cancelled);
});
