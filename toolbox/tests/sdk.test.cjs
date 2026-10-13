'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi, Cancelled } = require('../node/sdk.cjs');

test('short operations reject artificial user waits instead of hanging', async () => {
  for (const command of ['discover', 'capture_page', 'read_results']) {
    const api = createApi({}, () => assert.fail('must not send'), new Map(), command);
    await assert.rejects(api.waitForUser('请登录'), { code: 'UNSUPPORTED_OPERATION' });
    assert.equal(api.control.waitingUser, false);
  }
});

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
  await Promise.resolve();
  assert.equal(states[0], 'waiting_user');
  api.control.waitingUser = false;
  await waiting;
  assert.deepEqual(states, ['waiting_user', 'running']);
  const cancelled = api.waitForUser('请验证');
  api.control.cancelled = true;
  await assert.rejects(cancelled, Cancelled);
});

test('user wait entered while paused requires separate resumes for pause and login', { timeout: 2000 }, async () => {
  for (const command of ['run', 'download_item']) {
    const states = [];
    let enteredWait;
    const waitingUser = new Promise(resolve => { enteredWait = resolve; });
    const api = createApi({}, (type, data) => {
      states.push(data.state);
      if (data.state === 'waiting_user') enteredWait();
    }, new Map(), command);
    api.control.pauseRequested = true;
    const waiting = api.waitForUser('请登录');
    assert.deepEqual(states, ['paused']);
    assert.equal(api.control.waitingUser, false);
    // Match worker resume: both flags are cleared by the first command.
    api.control.pauseRequested = false;
    api.control.waitingUser = false;
    await waitingUser;
    assert.deepEqual(states, ['paused', 'running', 'waiting_user']);
    assert.equal(api.control.waitingUser, true);
    api.control.waitingUser = false;
    await waiting;
    assert.deepEqual(states, ['paused', 'running', 'waiting_user', 'running']);
  }
});

test('user wait entered while paused propagates cancellation in either wait', { timeout: 2000 }, async () => {
  for (const stage of ['paused', 'waiting_user']) {
    const states = [];
    let enteredWait;
    const waitingUser = new Promise(resolve => { enteredWait = resolve; });
    const api = createApi({}, (type, data) => {
      states.push(data.state);
      if (data.state === 'waiting_user') enteredWait();
    }, new Map());
    api.control.pauseRequested = true;
    const waiting = api.waitForUser('请验证');
    assert.deepEqual(states, ['paused']);
    if (stage === 'waiting_user') {
      api.control.pauseRequested = false;
      api.control.waitingUser = false;
      await waitingUser;
    }
    api.control.cancelled = true;
    await assert.rejects(waiting, { code: 'CANCELLED' });
    assert.deepEqual(states, stage === 'paused' ? ['paused'] : ['paused', 'running', 'waiting_user']);
  }
});


test('metadata updates use artifact replies and reject malformed, cancelled and short requests', async () => {
  const pending = new Map(), sent = [];
  const api = createApi({ taskId: 'task' }, (type, data) => sent.push({ type, data }), pending, 'run');
  const updated = api.updateMetadata('candidate', { caption: '补全文案' });
  assert.deepEqual(sent[0], { type: 'artifact_metadata', data: { candidateId: 'candidate', metadata: { caption: '补全文案' } } });
  pending.get('candidate').resolve({ artifactId: 'asset' }); pending.delete('candidate');
  assert.deepEqual(await updated, { artifactId: 'asset' });
  for (const metadata of [{}, { caption: '' }, { rank: 1 }, { title: '字'.repeat(2001) }])
    await assert.rejects(api.updateMetadata('candidate', metadata), { code: 'INVALID_PARAMETERS' });
  const short = createApi({ taskId: 'task' }, () => assert.fail(), new Map(), 'read_results');
  await assert.rejects(short.updateMetadata('candidate', { caption: '文案' }), { code: 'UNSUPPORTED_OPERATION' });
  api.control.cancelled = true;
  await assert.rejects(api.updateMetadata('candidate', { caption: '文案' }), { code: 'CANCELLED' });
  assert.equal(pending.size, 0);
});
