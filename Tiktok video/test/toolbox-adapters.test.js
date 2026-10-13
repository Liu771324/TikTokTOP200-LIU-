'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCollector, productKey } = require('../collector');
const compass = require('../compass-page');
const { startMediaServer } = require('../video-fingerprint');
const { atomicState } = require('../../toolbox/node/sdk.cjs');
const { createAdapter: automatic } = require('../../toolbox/node/adapters/video-ranking.cjs');
const { createAdapter: manual } = require('../../toolbox/node/adapters/manual-video.cjs');

const parameters = { category: '食品 / 粥', brandType: '不限', period: '近1天', trendMode: 'first' };
const product = (index, videoCount = 0, trend = 'first') => ({ productName: `商品${index}`, shopName: '店铺', rowIndex: index, videoCount, trend, trendText: trend === 'first' ? '首次上榜' : '上升1' });
const task = () => ({ id: 'fixture', parameters, status: 'queued', errors: [], logs: [],
  progress: { scanned: 0, eligible: 0, videosSaved: 0, videoFailures: 0, duplicatesSkipped: 0, captionFailures: 0 },
  checkpoint: { rank: 1, initialTotal: null, completedVideos: {}, failedVideos: {}, rankProducts: {} } });

function loopFixture(total, rows, saveVideoFromCard, extras = {}) {
  const pageSize = Math.min(20, rows.length);
  const state = { total, page: 1, rows: rows.slice(0, pageSize), hasVideoTable: true };
  const nextPage = async () => { state.page += 1; state.rows = rows.slice((state.page - 1) * pageSize, state.page * pageSize).map((row, rowIndex) => ({ ...row, rowIndex })); return state.rows.length > 0; };
  return createCollector({ managed: true, connectTargetPage: async () => ({ page: {} }), blockingIssue: async () => '',
    applyOptions: async () => state, tableState: async () => state, readNamingCaptions: async () => [], nextPage,
    createVideoFingerprinter: async () => ({ close: async () => {} }), saveTask() {}, appendLog() {}, saveVideoFromCard, ...extras });
}
const control = () => ({ waitIfPaused: async () => {}, throwIfStopped() {} });

for (const total of [199, 200, 201]) test(`actual managed loop stops at ${Math.min(total, 200)} of ${total} rows`, async () => {
  const result = await loopFixture(total, Array.from({ length: total }, (_, index) => product(index)), () => assert.fail('No media expected')).runTask(task(), control());
  assert.equal(result.status, 'completed'); assert.equal(result.progress.scanned, Math.min(total, 200));
  assert.equal(result.progress.eligible, Math.min(total, 200));
});

test('actual loop stops after four created videos and continues past reused/failed candidates', async () => {
  const visited = [];
  const engine = loopFixture(1, [product(0, 8)], async (_page, _row, index, rank, _product, state) => {
    visited.push(index);
    if (index === 1) { state.checkpoint.failedVideos[`${rank}:${index + 1}`] = 'fixture failure'; return; }
    state.checkpoint.completedVideos[`${rank}:${index + 1}`] = { artifactId: `asset${index}`, disposition: index === 0 ? 'visual_reuse' : 'created' };
  });
  const result = await engine.runTask(task(), control());
  assert.deepEqual(visited, [0, 1, 2, 3, 4, 5]); assert.equal(result.status, 'completed');
  assert.deepEqual(result.checkpoint.failedVideos, {});
});

test('actual loop blocks changed product at a previously recorded rank', async () => {
  const saved = task(); saved.checkpoint.rankProducts[1] = productKey(product(99));
  const result = await loopFixture(1, [product(0)], () => assert.fail()).runTask(saved, control());
  assert.equal(result.status, 'failed'); assert.match(result.errors.at(-1).message, /商品已变化/);
});

for (const fixture of require('./boundary-expectations.json').filter(value => value.input.candidateOutcomes)) {
  test(`verified integration expectation: ${fixture.name}`, async () => {
    let processed = 0;
    const outcomes = fixture.input.candidateOutcomes;
    const result = await loopFixture(1, [product(0, outcomes.length)], async (_page, _row, index, rank, _product, state) => {
      processed += 1;
      if (outcomes[index] === 'failed') { state.checkpoint.failedVideos[`${rank}:${index + 1}`] = 'fixture failure'; return; }
      state.checkpoint.completedVideos[`${rank}:${index + 1}`] = { artifactId: `asset${index}`, disposition: outcomes[index] };
    }).runTask(task(), control());
    assert.equal(processed, fixture.expected.candidatesProcessed);
    assert.equal(Object.values(result.checkpoint.completedVideos).filter(value => value.disposition === 'created').length, fixture.expected.newVideosSaved);
  });
}

test('actual loop respects both trend modes and preserves an unparseable trend error', async () => {
  for (const mode of ['first', 'up_and_first']) {
    const saved = task(); saved.parameters = { ...parameters, trendMode: mode };
    const result = await loopFixture(4, ['first', 'up', 'other', 'unparseable'].map((trend, index) => product(index, 0, trend)), () => assert.fail()).runTask(saved, control());
    assert.deepEqual(result.checkpoint.eligibleRanks, mode === 'first' ? [1] : [1, 2]);
    assert.deepEqual(result.checkpoint.trendErrors, [4]); assert.equal(result.status, 'completed_with_errors');
  }
});

test('managed loop cancellation propagates as stopped without calling legacy history preparation', async () => {
  const result = await loopFixture(1, [product(0)], () => assert.fail()).runTask(task(), { ...control(), waitIfPaused: async () => { throw Object.assign(new Error('cancel fixture'), { code: 'CANCELLED' }); } });
  assert.equal(result.status, 'stopped');
});

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-video-fixture-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function context(t, toolId = 'video-ranking') {
  const root = temporary(t);
  const value = { protocolVersion: 1, toolId, taskId: '1'.repeat(32), attempt: 1, dataRoot: root, browser: { endpoint: 'fixture', pageId: 'page-1' },
    statePath: path.join(root, 'tasks', 'state.json'), scratchRoot: path.join(root, 'scratch'), artifactStagingRoot: path.join(root, 'tasks', 'staging'), ffmpegPath: 'fixture-ffmpeg' };
  fs.mkdirSync(value.artifactStagingRoot, { recursive: true }); return value;
}
function apiFixture(context) {
  const registrations = new Map(), candidates = [], events = [];
  const api = { control: { cancelled: false }, checkpoint: state => atomicState(context, state), emit: (type, data) => events.push({ type, data }),
    boundary: async () => { if (api.control.cancelled) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' }); },
    lookup: async candidateId => ({ candidateId, registration: registrations.get(candidateId) || null }),
    register: async candidate => { candidates.push(candidate); const result = { artifactId: `asset${candidates.length}`, disposition: 'created', candidateSha256: 'candidate', artifactSha256: 'artifact' };
      registrations.set(candidate.candidateId, result); fs.unlinkSync(path.join(context.dataRoot, candidate.relpath)); return result; },
    waitForUser: async () => assert.fail('No login/captcha in fixture') };
  return { api, candidates, registrations, events };
}
function adapterFixture() {
  const row = product(0, 6); const table = { total: 1, page: 1, rows: [row], hasVideoTable: true };
  const cards = Array.from({ length: 6 }, (_, index) => compass.identity({ title: `文案${index}`, videoId: String(100 + index), rowIndex: 0, cardIndex: index }));
  let disconnects = 0, plays = 0;
  const page = { url: () => 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank', context: () => ({ newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'page-1' } }), detach: async () => {} }) }) };
  const deps = { connect: async () => ({ browser: {}, disconnect: async () => { disconnects += 1; } }), selectPage: async () => page,
    fingerprinterFactory: async () => ({ fingerprintFile: async () => ({ duration: 12, frames: Array(12).fill('0'.repeat(16)) }), close: async () => {} }),
    compass: { ...compass, pageIdentity: async () => ({ category: parameters.category, tabs: [parameters.period], brands: [parameters.brandType] }), readProductCards: async () => cards, playCard: async (_page, card) => { plays += 1; return { videoUrl: 'https://fixture.invalid/video', caption: card.title }; }, closePlayer: async () => {} },
    collectorFactory: options => ({ ...createCollector({ applyOptions: async () => table, tableState: async () => table,
      blockingIssue: async () => '', readNamingCaptions: async () => cards.slice(0, 4).map(card => card.title), ...options }),
      downloadMedia: async (_page, _url, target) => fs.writeFileSync(target, Buffer.from('0000ftypfixture'), { flag: 'wx' }) }) };
  return { deps, page, row, cards, table, disconnects: () => disconnects, plays: () => plays };
}

test('automatic adapter registers original fingerprints, captions and relative task candidates', async t => {
  const ctx = context(t), fixture = adapterFixture(), { api, candidates } = apiFixture(ctx);
  const result = await automatic(fixture.deps).run(parameters, ctx, api);
  assert.equal(result.state, 'completed'); assert.equal(candidates.length, 4); assert.equal(fixture.disconnects(), 1);
  for (const candidate of candidates) {
    assert.equal(candidate.fingerprint.frames.length, 12); assert.ok(candidate.metadata.caption);
    assert.equal(path.isAbsolute(candidate.relpath), false); assert.match(candidate.relpath, /^tasks\/staging\//);
  }
  const saved = JSON.parse(fs.readFileSync(ctx.statePath)).state;
  assert.equal(Object.values(saved.checkpoint.completedVideos).length, 4);
  assert.equal(JSON.stringify(saved).includes('https://fixture.invalid'), false);
  const resultPage = await automatic().read_results({ offset: 1, limit: 2 }, ctx);
  assert.equal(resultPage.total, 4); assert.equal(resultPage.items.length, 2);
});

test('host dispositions cause refill and preserve reused video captions', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  const register = state.api.register;
  state.api.register = async candidate => {
    const result = await register(candidate);
    if (state.candidates.length === 1) { result.disposition = 'visual_reuse'; state.registrations.set(candidate.candidateId, result); }
    return result;
  };
  const result = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(result.progress.videosSaved, 4); assert.equal(state.candidates.length, 5);
  const saved = JSON.parse(fs.readFileSync(ctx.statePath)).state;
  assert.equal(saved.checkpoint.completedVideos['1:1'].caption, '文案0'); assert.equal(saved.checkpoint.completedVideos['1:1'].disposition, 'visual_reuse');
});

test('video failures emit bounded diagnostics without persisting signed URLs in task records', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  const signedUrl = 'https://media.fixture.invalid/video?signature=private-diagnostic';
  fixture.deps.compass.playCard = async () => {
    throw Object.assign(new Error(`播放器读取失败 ${signedUrl} Cookie: private-cookie ${'x'.repeat(5000)}`), { code: 'MEDIA_UNAVAILABLE' });
  };
  const result = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(result.state, 'completed_with_errors');
  const diagnostics = state.events.filter(event => event.type === 'log' && event.data.message.startsWith('视频处理失败['));
  assert.equal(diagnostics.length, fixture.cards.length);
  for (const event of diagnostics) {
    assert.match(event.data.message, /^视频处理失败\[MEDIA_UNAVAILABLE\]：播放器读取失败/);
    assert.ok(event.data.message.includes(signedUrl));
    assert.equal(event.data.message.length, 4000);
  }
  const saved = JSON.parse(fs.readFileSync(ctx.statePath)).state;
  assert.equal(saved.errors.length, fixture.cards.length);
  for (const failure of [...saved.errors, ...Object.values(saved.checkpoint.failedVideos)]) {
    assert.equal(failure.code, 'MEDIA_UNAVAILABLE');
    assert.equal(failure.message, '此视频处理失败，可在任务结束后重试失败项。');
  }
  assert.equal(JSON.stringify(saved).includes('private-diagnostic'), false);
  assert.equal(JSON.stringify(saved).includes('private-cookie'), false);
  const results = await automatic().read_results({}, ctx);
  assert.equal(JSON.stringify(results).includes(signedUrl), false);
});

test('lookup restores registration after checkpoint gap without redownloading that card', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  const register = state.api.register;
  state.api.register = async candidate => { await register(candidate); state.api.control.cancelled = true; throw Object.assign(new Error('checkpoint gap'), { code: 'CANCELLED' }); };
  const first = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(first.state, 'cancelled'); assert.equal(fixture.plays(), 1);
  state.api.control.cancelled = false; state.api.register = register; ctx.attempt = 2;
  const second = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(second.state, 'completed'); assert.equal(fixture.plays(), 4); assert.equal(state.candidates.length, 4);
});

test('manual download_item registers exact-only candidates and never checkpoints', async t => {
  const ctx = context(t, 'manual-video'), fixture = adapterFixture(), state = apiFixture(ctx);
  const row = { productName: '商品', shopName: '店铺', productKey: 'product', cards: [fixture.cards[0]] };
  const view = { rows: [row], key: 'snapshot', category: '食品' };
  fixture.deps.compass.snapshot = async () => view;
  const item = compass.captureItems(view, 'page-1', fixture.page.url())[0];
  state.api.checkpoint = () => assert.fail('The host is the only manual task state writer');
  const result = await manual(fixture.deps).download_item({ item, candidateId: 'manual:item' }, ctx, state.api);
  assert.equal(result.artifactId, 'asset1'); assert.equal(state.candidates[0].fingerprint, undefined);
  assert.equal(result.caption, '文案0'); assert.equal(fixture.disconnects(), 1); assert.equal(fs.existsSync(ctx.statePath), false);
});

test('manual waitForUser resumes with identity validation and rejects a changed snapshot', async t => {
  const ctx = context(t, 'manual-video'), fixture = adapterFixture(), state = apiFixture(ctx);
  const card = compass.identity({ title: '无原生ID的文案', rowIndex: 0, cardIndex: 0 });
  const view = { rows: [{ productKey: 'p', cards: [card] }], key: 'before', category: '食品' };
  const item = compass.captureItems(view, 'page-1', fixture.page.url())[0];
  let blocked = true, waits = 0;
  const factory = fixture.deps.collectorFactory;
  fixture.deps.collectorFactory = options => ({ ...factory(options), blockingIssue: async () => blocked ? '请完成验证' : '' });
  fixture.deps.compass.snapshot = async () => view;
  state.api.waitForUser = async () => { waits += 1; blocked = false; view.key = 'after'; };
  await assert.rejects(manual(fixture.deps).download_item({ item, candidateId: 'waiting:item' }, ctx, state.api), { code: 'PAGE_CHANGED' });
  assert.equal(waits, 1); assert.equal(fixture.plays(), 0); assert.equal(state.candidates.length, 0); assert.equal(fixture.disconnects(), 1);
});

test('missing host registration is repaired with the same stable candidate identity', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  const adapter = automatic(fixture.deps); await adapter.run(parameters, ctx, state.api);
  const originals = state.candidates.map(value => value.candidateId);
  state.registrations.clear(); ctx.attempt = 2;
  await adapter.run(parameters, ctx, state.api);
  assert.deepEqual(state.candidates.slice(4).map(value => value.candidateId), originals);
  assert.equal(fixture.plays(), 8);
});

test('changed filters at a pause boundary stop automatic acquisition before any download', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx); let changed = false;
  fixture.deps.compass.pageIdentity = async () => ({ category: parameters.category, tabs: [changed ? '近7天' : parameters.period], brands: [parameters.brandType] });
  state.api.boundary = async () => { changed = true; };
  await assert.rejects(automatic(fixture.deps).run(parameters, ctx, state.api), { code: 'PAGE_CHANGED' });
  assert.equal(fixture.plays(), 0); assert.equal(state.candidates.length, 0); assert.equal(fixture.disconnects(), 1);
});

test('discover returns observed options and short blocked operations never wait for resume', async () => {
  const fixture = adapterFixture(); let blocked = false;
  const options = { categories: ['食品 / 粥'], brandTypes: ['不限'], periods: [{ label: '近1天', value: 'one', disabled: false }], currentCategory: '食品 / 粥' };
  fixture.deps.collectorFactory = () => ({ blockingIssue: async () => blocked ? '请重新登录' : '', discoverOptions: async () => options });
  const api = { emit() {}, waitForUser: () => assert.fail('No resume channel for short operations') };
  const adapter = automatic(fixture.deps);
  assert.deepEqual(await adapter.discover({}, { browser: {} }, api), options);
  blocked = true; await assert.rejects(adapter.discover({}, { browser: {} }, api), { code: 'LOGIN_REQUIRED' });
  assert.equal(fixture.disconnects(), 2);
});

test('capture deduplicates native identities and fallback locators reject changed snapshots/cards', () => {
  const strong = compass.identity({ title: '已知', videoId: '123', href: 'https://www.douyin.com/video/123?share=secret' });
  const weak = compass.identity({ title: '标题', cover: 'https://image.invalid/cover?token=secret' });
  const view = { key: 'snapshot1', category: '食品', rows: [{ productKey: 'p', cards: [strong, weak] }] };
  const items = compass.captureItems(view, 'page-1', 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank');
  assert.equal(items[0].sourceKey, 'compass:video:123'); assert.equal(items[0].publicUrl, 'https://www.douyin.com/video/123');
  assert.equal(JSON.stringify(items).includes('secret'), false); assert.equal(JSON.stringify(items).includes('rowIndex'), false);
  assert.equal(compass.locate(view, items[1]), weak);
  assert.throws(() => compass.locate({ ...view, key: 'snapshot2' }, items[1]), { code: 'PAGE_CHANGED' });
  assert.throws(() => compass.locate({ ...view, rows: [{ productKey: 'p', cards: [strong] }] }, items[1]), { code: 'PAGE_CHANGED' });
});

test('read_results rejects wrong identity and never starts a browser or writes files', async t => {
  const ctx = context(t, 'manual-video'); const adapter = manual({ connect: () => assert.fail('read-only') });
  assert.deepEqual(await adapter.read_results({}, ctx), { items: [], total: 0 });
  atomicState(ctx, { items: [{ title: '已下载', artifactId: 'asset1' }] });
  const before = fs.statSync(ctx.statePath).mtimeMs;
  assert.equal((await adapter.read_results({}, ctx)).total, 1); assert.equal(fs.statSync(ctx.statePath).mtimeMs, before);
  await assert.rejects(adapter.read_results({ limit: 201 }, ctx), { code: 'INVALID_PARAMETERS' });
  const corrupt = JSON.parse(fs.readFileSync(ctx.statePath)); corrupt.taskId = '2'.repeat(32); fs.writeFileSync(ctx.statePath, JSON.stringify(corrupt));
  await assert.rejects(adapter.read_results({}, ctx), { code: 'STATE_CORRUPT' });
});

test('media service exposes only active explicit tokens, supports range and revokes access', async t => {
  const root = temporary(t), allowed = path.join(root, 'staging'); fs.mkdirSync(allowed);
  const file = path.join(allowed, 'fixture.mp4'); fs.writeFileSync(file, '0123456789');
  const outside = path.join(root, 'outside.mp4'); fs.writeFileSync(outside, 'private');
  const media = await startMediaServer(allowed); t.after(() => new Promise(resolve => media.server.close(resolve)));
  assert.throws(() => media.mapFile(outside));
  assert.equal((await fetch(media.origin + '/video?path=fixture.mp4')).status, 404);
  const token = media.mapFile(file);
  const response = await fetch(`${media.origin}/video?token=${token}`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), '2345');
  assert.equal((await fetch(`${media.origin}/video?token=${token}`, { method: 'HEAD' })).headers.get('content-length'), '10');
  media.unmapFile(token); assert.equal((await fetch(`${media.origin}/video?token=${token}`)).status, 404);
});

test('FFmpeg uses the injected binary, hides its window, reserves output and cancels before return', async t => {
  const root = temporary(t), output = path.join(root, 'result.mp4'); let cancelled = false, closed = false;
  const engine = createCollector({ ffmpegPath: 'explicit-ffmpeg.exe', isCancelled: () => cancelled,
    spawn: (binary, args, options) => {
      assert.equal(binary, 'explicit-ffmpeg.exe'); assert.equal(options.windowsHide, true); assert.equal(fs.existsSync(output), true);
      const child = new EventEmitter(); child.stderr = new PassThrough();
      options.signal.addEventListener('abort', () => { closed = true; child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' })); setImmediate(() => child.emit('close', 1)); });
      setImmediate(() => { cancelled = true; }); return child;
    } });
  await assert.rejects(engine.runFfmpeg(['-i', 'fixture'], output, '合并'), { code: 'CANCELLED' });
  assert.equal(closed, true); assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(output, 'existing'); cancelled = false;
  await assert.rejects(engine.runFfmpeg([], output, '合并'), { code: 'EEXIST' }); assert.equal(fs.readFileSync(output, 'utf8'), 'existing');
});


test('managed retry repairs earlier trend failures without redownloading successful media', async () => {
  const saved = task(); saved.checkpoint.rank = 2;
  saved.checkpoint.trendErrors = [1];
  saved.errors = [{ rank: 1, message: '无法识别趋势：未知' }];
  const result = await loopFixture(1, [product(0, 0, 'first')], () => assert.fail()).runTask(saved, control());
  assert.equal(result.status, 'completed'); assert.deepEqual(result.checkpoint.trendErrors, []);
  assert.ok(result.errors[0].resolvedAt);
});

test('managed retry revisits missing captions even with four created assets', async () => {
  const saved = task(); saved.checkpoint.rank = 2;
  for (let index = 0; index < 4; index++) saved.checkpoint.completedVideos[`1:${index + 1}`] = {
    artifactId: `asset${index}`, disposition: 'created', caption: index ? '已有文案' : '' };
  const repaired = [];
  const result = await loopFixture(1, [product(0, 6)], () => assert.fail('must retain saved assets'), {
    repairCaptionFromCard: async (_page, _row, index, rank, _product, state) => {
      repaired.push(index); state.checkpoint.completedVideos[`${rank}:${index + 1}`].caption = '补全文案';
      state.progress.captionFailures = 0;
    },
  }).runTask(saved, control());
  assert.deepEqual(repaired, [0]); assert.equal(result.status, 'completed');
});

test('automatic caption repair updates the host reference without registering or downloading again', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  await automatic(fixture.deps).run(parameters, ctx, state.api);
  const saved = JSON.parse(fs.readFileSync(ctx.statePath)).state;
  saved.checkpoint.completedVideos['1:1'].caption = '';
  saved.progress.captionFailures = 1; atomicState(ctx, saved);
  const updates = [];
  state.api.updateMetadata = async (candidateId, metadata) => {
    updates.push({ candidateId, metadata }); return state.registrations.get(candidateId);
  };
  const originalPlays = fixture.plays(), originalCandidates = state.candidates.length;
  const result = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(result.state, 'completed'); assert.equal(result.progress.captionFailures, 0);
  assert.equal(state.candidates.length, originalCandidates); assert.equal(fixture.plays(), originalPlays + 1);
  assert.equal(updates.length, 1); assert.equal(updates[0].metadata.caption, '文案0');
  assert.equal(JSON.parse(fs.readFileSync(ctx.statePath)).state.checkpoint.completedVideos['1:1'].caption, '文案0');
});


test('ambiguous candidate identities fail only those candidates and continue to four unique assets', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  fixture.cards[1] = { ...fixture.cards[1], cardKey: fixture.cards[0].cardKey };
  const result = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(result.state, 'completed'); assert.equal(state.candidates.length, 4);
  const saved = JSON.parse(fs.readFileSync(ctx.statePath)).state;
  assert.deepEqual(saved.checkpoint.failedVideos, {});
  const failures = saved.errors.filter(error => error.code === 'UNSUPPORTED_SOURCE');
  assert.equal(failures.length, 2); assert.ok(failures.every(error => error.resolution === 'quota_satisfied'));
});

test('a saved video identity changing remains a fatal page change', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  const saved = task(); saved.checkpoint.videoIdentities = { '1:1': 'prior-card-identity' };
  atomicState(ctx, saved);
  await assert.rejects(automatic(fixture.deps).run(parameters, ctx, state.api), { code: 'PAGE_CHANGED' });
  assert.equal(state.candidates.length, 0);
});


test('caption metadata rejection preserves media and pending failure until a later successful retry', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  await automatic(fixture.deps).run(parameters, ctx, state.api);
  const saved = JSON.parse(fs.readFileSync(ctx.statePath)).state;
  saved.checkpoint.completedVideos['1:1'].caption = '';
  saved.progress.captionFailures = 1; atomicState(ctx, saved);
  state.api.updateMetadata = async () => { throw Object.assign(new Error('fixture rejected'), { code: 'MEDIA_UNAVAILABLE' }); };
  const failed = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(failed.state, 'completed_with_errors'); assert.equal(failed.progress.captionFailures, 1);
  assert.equal(state.candidates.length, 4);
  const pending = JSON.parse(fs.readFileSync(ctx.statePath)).state;
  assert.equal(pending.checkpoint.completedVideos['1:1'].caption, '');
  assert.equal(pending.errors.at(-1).captionOnly, true);
  state.api.updateMetadata = async candidateId => state.registrations.get(candidateId);
  const recovered = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(recovered.state, 'completed'); assert.equal(recovered.progress.captionFailures, 0);
  assert.equal(state.candidates.length, 4);
  assert.ok(JSON.parse(fs.readFileSync(ctx.statePath)).state.errors.at(-1).resolvedAt);
});

test('below-quota failed candidate is retried and successful media are retained', async t => {
  const ctx = context(t), fixture = adapterFixture(), state = apiFixture(ctx);
  fixture.cards.splice(3); fixture.row.videoCount = 3;
  const play = fixture.deps.compass.playCard;
  fixture.deps.compass.playCard = async (page, card) => {
    if (card === fixture.cards[1]) throw Object.assign(new Error('fixture failure'), { code: 'MEDIA_UNAVAILABLE' });
    return play(page, card);
  };
  const first = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(first.state, 'completed_with_errors'); assert.equal(state.candidates.length, 2);
  fixture.deps.compass.playCard = play;
  const result = await automatic(fixture.deps).run(parameters, ctx, state.api);
  assert.equal(result.state, 'completed'); assert.equal(state.candidates.length, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.statePath)).state.checkpoint.failedVideos, {});
});


function expandedCardsPage(visibleCovers, expandedCovers) {
  const element = cover => ({
    querySelector: selector => selector === 'img' ? { currentSrc: `https://fixture.invalid/${cover}?signed=temporary` } : null,
    getAttribute: () => null, matches: () => false,
  });
  class Locator {
    constructor(items) { this.items = items; }
    first() { return this.nth(0); }
    nth(index) { return new Locator(this.items[index] ? [this.items[index]] : []); }
    async count() { return this.items.length; }
    async evaluate(operation) { return operation(this.items[0]); }
    async hover() {}
    locator(selector) {
      if (selector.includes('videoWrapper-')) return new Locator(visibleCovers.map(element));
      if (selector.includes('moreVideo-')) return new Locator([{}]);
      assert.fail(`Unexpected selector ${selector}`);
    }
  }
  return { locator: selector => selector.startsWith('tr.') ? new Locator([{}]) : new Locator(expandedCovers.map(element)),
    evaluate: async () => '', waitForTimeout: async () => {} };
}

test('expanded full list repeats the ordered visible prefix once and all ten candidates are scanned', async () => {
  const page = expandedCardsPage(['A', 'B', 'C', 'D'], ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  const cards = await compass.readProductCards(page, 0);
  assert.equal(cards.length, 10); assert.equal(new Set(cards.map(card => card.cardKey)).size, 10);
  assert.deepEqual(cards.map(card => card.fromPopover), [false, false, false, false, true, true, true, true, true, true]);
  assert.deepEqual(cards.map(card => card.cardIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const visited = [];
  const result = await loopFixture(1, [product(0, 10)], async (_page, _row, index, rank, _product, state) => {
    visited.push(cards[index].cardIndex);
    state.checkpoint.completedVideos[`${rank}:${index + 1}`] = { artifactId: `asset${index}`, caption: '正确文案', disposition: index < 6 ? 'exact_reuse' : 'created' };
  }).runTask(task(), control());
  assert.equal(result.status, 'completed'); assert.deepEqual(visited, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('prefix folding preserves repeated weak covers at different positions as ambiguous', async () => {
  const cards = await compass.readProductCards(expandedCardsPage(['A', 'A'], ['A', 'A', 'B']), 0);
  assert.equal(cards.length, 3); assert.equal(cards[0].cardKey, cards[1].cardKey);
  const items = compass.captureItems({ key: 'snapshot', category: '食品', rows: [{ productKey: 'p', cards }] }, 'page', 'fixture');
  assert.equal(items.length, 1); assert.equal(items[0].locator.cardKey, cards[2].cardKey);
});

test('partial reordered weak overlap is not folded and extra-only lists retain their original indices', async () => {
  const overlap = await compass.readProductCards(expandedCardsPage(['A', 'B'], ['B', 'A', 'C']), 0);
  assert.equal(overlap.length, 5);
  const extras = await compass.readProductCards(expandedCardsPage([], ['A', 'B', 'C']), 0);
  assert.equal(extras.length, 3); assert.ok(extras.every(card => card.fromPopover));
  assert.deepEqual(extras.map(card => card.cardIndex), [0, 1, 2]);
});
