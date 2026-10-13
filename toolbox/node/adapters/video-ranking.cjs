'use strict';
const collector = require('../../../Tiktok video/collector');
const compass = require('../../../Tiktok video/compass-page');
const fingerprint = require('../../../Tiktok video/video-fingerprint');
const runtime = require('../../../Tiktok video/toolbox-runtime');
const browserClient = require('../browser-client.cjs');

const descriptor = { id: 'video-ranking', parameterVersion: 1, operations: ['run', 'discover', 'read_results'] };

function validate(parameters) {
  if (typeof parameters.category !== 'string' || !parameters.category.trim() || parameters.category.length > 1000
      || !['不限', '知名品牌', '非知名品牌'].includes(parameters.brandType)
      || !['实时', '近1天', '近7天', '近30天'].includes(parameters.period)
      || !['first', 'up_and_first'].includes(parameters.trendMode)) throw runtime.fail('INVALID_PARAMETERS', '请选择有效的类目、品牌、周期和趋势。');
}

function newTask(parameters, context) {
  return { id: context.taskId, createdAt: new Date().toISOString(), completedAt: null, status: 'queued', parameters,
    progress: { scanned: 0, eligible: 0, videosSaved: 0, videoFailures: 0, duplicatesSkipped: 0, captionFailures: 0, currentRank: null, currentProduct: null, currentVideo: null },
    errors: [], logs: [], checkpoint: { rank: 1, page: 1, initialTotal: null, pageSize: null, completedVideos: {}, failedVideos: {}, rankProducts: {}, productShortNames: {}, eligibleRanks: [], trendErrors: [], videoIdentities: {} } };
}

function refreshCounts(task) {
  const values = Object.values(task.checkpoint.completedVideos || {});
  task.progress.videosSaved = values.filter(value => value.disposition === 'created').length;
  task.progress.duplicatesSkipped = values.filter(value => value.disposition !== 'created').length;
  task.progress.captionFailures = values.filter(value => !value.caption).length;
  task.progress.videoFailures = Object.keys(task.checkpoint.failedVideos || {}).length;
}

function createAdapter(overrides = {}) {
  const connect = overrides.connect || browserClient.connect;
  const selectPage = overrides.selectPage || browserClient.selectPage;
  const pages = overrides.compass || compass;
  const factory = overrides.collectorFactory || collector.createCollector;
  return {
    descriptor,
    async discover(parameters, context, api) {
      const connection = await connect(context);
      try {
        const page = await selectPage(connection.browser, parameters.pageId || context.browser?.pageId, pages.accepts);
        const engine = factory({ connectTargetPage: async () => ({ page }) });
        await runtime.ensureReady(page, engine, api, false);
        return await engine.discoverOptions(message => api.emit('log', { message }));
      } finally { await connection.disconnect(); }
    },
    async run(parameters, context, api) {
      validate(parameters);
      const task = runtime.readState(context) || newTask(parameters, context);
      if (JSON.stringify(task.parameters) !== JSON.stringify(parameters) || !task.checkpoint || !task.progress || !Array.isArray(task.errors)) throw runtime.fail('STATE_CORRUPT', '检查点与任务条件不一致。');
      task.logs = []; // Durable diagnostics belong to the host log, not a growing state copy.
      const saveTask = value => { api.checkpoint(value); if (!api.control.cancelled) api.emit('progress', value.progress); };
      const appendLog = (_task, message) => { if (!api.control.cancelled) api.emit('log', { message }); saveTask(task); };
      // A saved artifactId is only a hint; the host checks that its asset still exists.
      for (const [key, value] of Object.entries(task.checkpoint.completedVideos || {})) {
        await api.boundary();
        const found = value.candidateId && (await api.lookup(value.candidateId)).registration;
        if (!found) { delete task.checkpoint.completedVideos[key]; task.checkpoint.rank = Math.min(task.checkpoint.rank || 1, Number(key.split(':')[0])); }
        else Object.assign(value, found);
      }
      refreshCounts(task);
      const connection = await connect(context);
      let engine;
      try {
        const page = await selectPage(connection.browser, context.browser?.pageId, pages.accepts);
        const browserContext = page.context();
        const session = await browserContext.newCDPSession(page);
        let pageId;
        try { pageId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await session.detach(); }
        const base = factory({ isCancelled: () => api.control.cancelled, ffmpegPath: context.ffmpegPath });
        const ready = () => runtime.ensureReady(page, base, api);
        let selection = null;
        const checkSelection = async () => {
          if (!selection) return;
          const current = await pages.pageIdentity(page);
          if (JSON.stringify([current.category, current.tabs, current.brands]) !== selection) throw pages.changed('榜单筛选条件已变化，请恢复原条件后继续或新建任务。');
        };
        const saveVideoFromCard = async (_page, rowIndex, videoIndex, rank, product, state, fingerprinter, captionOnly = false) => {
          const key = `${rank}:${videoIndex + 1}`;
          let file = null, submitted = false;
          try {
            await ready();
            await checkSelection();
            const current = await base.tableState(page);
            if (current.page !== state.checkpoint.page || collector.productKey(current.rows[rowIndex] || {}) !== collector.productKey(product)) throw pages.changed();
            const cards = await pages.readProductCards(page, rowIndex, () => api.boundary());
            await ready(); await checkSelection();
            const verified = await base.tableState(page);
            if (verified.page !== state.checkpoint.page || collector.productKey(verified.rows[rowIndex] || {}) !== collector.productKey(product)) throw pages.changed();
            const card = cards[videoIndex];
            if (!card?.observable || cards.filter(value => value.cardKey === card.cardKey).length !== 1) throw runtime.fail('UNSUPPORTED_SOURCE', '当前候选视频无法唯一定位，将保留失败明细并继续检查其他候选。');
            state.checkpoint.videoIdentities ||= {};
            if (state.checkpoint.videoIdentities[key] && state.checkpoint.videoIdentities[key] !== card.cardKey) throw pages.changed();
            state.checkpoint.videoIdentities[key] = card.cardKey;
            const candidateId = `video:${rank}:${collector.productKey(product)}:${card.cardKey}`;
            saveTask(state);
            let registered = (await api.lookup(candidateId)).registration;
            if (captionOnly && !registered) throw runtime.fail('MEDIA_UNAVAILABLE', '已登记的视频不可用，请重新运行以恢复该视频。');
            const player = registered && !captionOnly ? { caption: state.checkpoint.videoCaptions?.[key] || card.title } : await pages.playCard(page, card);
            if (captionOnly) {
              if (typeof player.caption !== 'string' || !player.caption.trim()) throw runtime.fail('CAPTION_UNAVAILABLE', '当前视频文案仍未读取到，请稍后重试。');
              await api.boundary();
              await api.updateMetadata(candidateId, { caption: player.caption, title: card.title || player.caption });
              state.checkpoint.videoCaptions ||= {};
              state.checkpoint.videoCaptions[key] = player.caption;
            }
            if (!registered) {
              file = await runtime.candidateFromPlayer(page, player, context, base, api);
              let visual = null;
              if (fingerprinter) {
                try { visual = await fingerprinter.fingerprintFile(file); }
                catch (error) { if (api.control.cancelled || error.code === 'CANCELLED') throw error; api.emit('log', { message: '当前视频无法读取视觉指纹，将仅按文件内容去重。' }); }
              }
              await api.boundary();
              state.checkpoint.videoCaptions ||= {};
              state.checkpoint.videoCaptions[key] = player.caption || '';
              saveTask(state);
              submitted = true;
              registered = await api.register({ candidateId, kind: 'video', role: 'video', relpath: runtime.candidatePath(context, file),
                displayName: `${collector.safePart(state.checkpoint.productShortNames[rank] || product.productName, 60)}_${videoIndex + 1}.mp4`,
                metadata: { caption: player.caption || '', title: card.title || player.caption || '', rank, productName: product.productName,
                  shopName: product.shopName, productKey: collector.productKey(product), videoIndex: videoIndex + 1, sourceKind: 'compass_ranking', sourcePage: page.url().split('?')[0], pageId }, fingerprint: visual });
            }
            state.checkpoint.completedVideos[key] = { candidateId, ...registered, caption: player.caption || '', title: card.title || player.caption || '', productName: product.productName, rank, videoIndex: videoIndex + 1 };
            delete state.checkpoint.failedVideos[key];
            for (const error of state.errors) if (error.rank === rank && error.videoIndex === videoIndex + 1) error.resolvedAt = new Date().toISOString();
            refreshCounts(state);
            saveTask(state);
          } catch (error) {
            if (api.control.cancelled) throw runtime.fail('CANCELLED', '操作已停止。');
            if (error.code === 'CANCELLED' || error.code === 'PAGE_CHANGED') throw error;
            api.emit('log', { message: `视频处理失败[${error.code || 'MEDIA_UNAVAILABLE'}]：${error.message || String(error)}`.slice(0, 4000) });
            const message = captionOnly ? '此视频文案读取失败，可在任务结束后重试失败项。' : '此视频处理失败，可在任务结束后重试失败项。';
            if (!captionOnly) state.checkpoint.failedVideos[key] = { code: error.code || 'MEDIA_UNAVAILABLE', message };
            state.errors.push({ rank, videoIndex: videoIndex + 1, productName: product.productName, code: error.code || 'MEDIA_UNAVAILABLE', message, ...(captionOnly ? { captionOnly: true } : {}) });
            state.progress.videoFailures = Object.keys(state.checkpoint.failedVideos).length;
            saveTask(state);
          } finally {
            await pages.closePlayer(page).catch(() => {});
            if (file && !submitted) require('node:fs').rmSync(file, { force: true });
          }
        };
        engine = factory({ managed: true, connectTargetPage: async () => ({ page }), saveTask, appendLog, saveVideoFromCard,
          repairCaptionFromCard: (...args) => saveVideoFromCard(...args, null, true),
          applyOptions: async (...args) => { const state = await base.applyOptions(...args); const selected = await pages.pageIdentity(page); selection = JSON.stringify([selected.category, selected.tabs, selected.brands]); return state; },
          isCancelled: () => api.control.cancelled, ffmpegPath: context.ffmpegPath,
          createVideoFingerprinter: () => (overrides.fingerprinterFactory || fingerprint.createVideoFingerprinter)({ allowedRoot: context.artifactStagingRoot, isCancelled: () => api.control.cancelled }),
          blockingIssue: async () => { await ready(); return ''; } });
        const result = await engine.runTask(task, { waitIfPaused: async () => { await api.boundary(); await ready(); await checkSelection(); },
          throwIfStopped: () => { if (api.control.cancelled) throw runtime.fail('CANCELLED', '操作已停止。'); } });
        if (result.status === 'failed') throw runtime.fail(result.errors.at(-1)?.code || 'PAGE_CHANGED', result.errors.at(-1)?.message || '视频采集失败。');
        return { state: result.status === 'stopped' ? 'cancelled' : result.status, progress: result.progress };
      } finally { await connection.disconnect(); }
    },
    async read_results(parameters, context) {
      const task = runtime.readState(context);
      const items = Object.values(task?.checkpoint?.completedVideos || {}).map(value => ({ ...value, status: 'completed' }));
      for (const [key, error] of Object.entries(task?.checkpoint?.failedVideos || {})) {
        const [rank, videoIndex] = key.split(':').map(Number); items.push({ rank, videoIndex, status: 'failed', error });
      }
      return runtime.paginate(items.sort((a, b) => a.rank - b.rank || a.videoIndex - b.videoIndex), parameters);
    },
  };
}

module.exports = { createAdapter, ...createAdapter() };
