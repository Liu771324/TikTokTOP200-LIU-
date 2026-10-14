'use strict';
const compass = require('../../../Tiktok video/compass-page');
const { createCollector, safePart } = require('../../../Tiktok video/collector');
const runtime = require('../../../Tiktok video/toolbox-runtime');
const browserClient = require('../browser-client.cjs');
const douyin = require('../douyin-page.cjs');

const descriptor = { id: 'manual-video', parameterVersion: 1, operations: ['capture_page', 'resolve_items', 'download_item', 'read_results'] };

function createAdapter(overrides = {}) {
  const pages = overrides.compass || compass;
  const connect = overrides.connect || browserClient.connect;
  const selectPage = overrides.selectPage || browserClient.selectPage;
  const factory = overrides.collectorFactory || createCollector;
  return {
    descriptor,
    async capture_page(parameters, context, api) {
      const connection = await connect(context);
      try {
        const page = await selectPage(connection.browser, parameters.pageId || context.browser?.pageId, url => pages.accepts(url) || douyin.accepts(url));
        if (douyin.accepts(page.url())) {
          const items = await douyin.captureItems(page);
          if (!items.length) throw runtime.fail('UNSUPPORTED_SOURCE', '当前页没有识别到已加载的视频，请打开视频详情、作者作品或视频搜索结果后重读。');
          return bounded(items, '当前已加载的抖音视频');
        }
        await runtime.ensureReady(page, factory(), api, false);
        const session = await page.context().newCDPSession(page);
        let pageId;
        try { pageId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await session.detach(); }
        const view = await pages.snapshot(page, pageId, () => api.boundary(), { titleBudget: 200, titleAttempts: 3, titlePause: 150 });
        const items = pages.captureItems(view, pageId, page.url().split('?')[0]);
        if (!items.length) throw runtime.fail('UNSUPPORTED_SOURCE', '当前页没有识别到短视频卡片，请切到罗盘短视频榜并等待视频加载后重读。');
        return bounded(items, '当前已加载的罗盘视频，不限制上榜趋势');
      } finally { await connection.disconnect(); }
    },
    async resolve_items(parameters, context, api) {
      if (!Array.isArray(parameters.items) || !parameters.items.length || parameters.items.length > 10) throw runtime.fail('INVALID_PARAMETERS', '每批最多提取10条链接。');
      const connection = await connect(context);
      const items = [], views = new Map();
      const frame = view => JSON.stringify([view.products, view.page, view.category, view.tabs, view.brands]);
      let failed = 0;
      try {
        for (const item of parameters.items) {
          await api.boundary();
          if (item.sourceKind === 'public' && item.publicUrl) { items.push(item); continue; }
          let page;
          try {
            if (item.sourceKind !== 'compass_ranking' || !item.locator?.pageId) throw runtime.fail('UNSUPPORTED_SOURCE', '请重新读取视频来源。');
            page = await selectPage(connection.browser, item.locator.pageId, pages.accepts);
            await runtime.ensureReady(page, factory(), api, false);
            let view = views.get(item.locator.pageId);
            if (view && frame(view) !== frame(await pages.pageIdentity(page))) throw pages.changed();
            if (!view || item.locator.videoKey?.startsWith('snapshot:')) {
              view = await pages.snapshot(page, item.locator.pageId, () => api.boundary(), { readTitles: false });
              views.set(item.locator.pageId, view);
            }
            const card = pages.locate(view, item);
            const player = await pages.playCard(page, card);
            items.push({ ...item, title: player.caption || item.title, mediaUrl: player.videoUrl,
              details: { ...item.details, titleKnown: Boolean(player.caption) || item.details?.titleKnown === true, linkError: '' } });
          } catch (error) {
            if (api.control.cancelled) throw error;
            api.emit?.('log', { message: `提取链接失败：${error.code || 'MEDIA_UNAVAILABLE'} ${error.message}` });
            failed += 1;
            items.push({ ...item, details: { ...item.details, linkError: '提取失败，请确认原页面和视频可播放后重试。' } });
          } finally { if (page) await pages.closePlayer(page).catch(() => {}); }
        }
        return { items, failed, scope: '所选视频链接' };
      } finally { await connection.disconnect(); }
    },
    async download_item(parameters, context, api) {
      const { item, candidateId } = parameters;
      if (item?.sourceKind !== 'compass_ranking' || !item.locator?.pageId || typeof candidateId !== 'string' || !candidateId || candidateId.length > 200) throw runtime.fail('INVALID_PARAMETERS', '下载条目身份无效，请重新读取页面。');
      const existing = (await api.lookup(candidateId)).registration;
      if (existing) return { artifactId: existing.artifactId, title: item.title };
      const connection = await connect(context);
      let file = null, submitted = false, page;
      try {
        page = await selectPage(connection.browser, item.locator.pageId, pages.accepts);
        const engine = factory({ isCancelled: () => api.control.cancelled, ffmpegPath: context.ffmpegPath });
        await runtime.ensureReady(page, engine, api);
        await api.boundary();
        const view = await pages.snapshot(page, item.locator.pageId, () => api.boundary(), { readTitles: false });
        const card = pages.locate(view, item);
        const player = await pages.playCard(page, card);
        file = await runtime.candidateFromPlayer(page, player, context, engine, api);
        submitted = true;
        const result = await api.register({ candidateId, kind: 'video', role: 'video', relpath: runtime.candidatePath(context, file),
          displayName: `${safePart(item.title, 80)}.mp4`, metadata: { title: player.caption || item.title, caption: player.caption || '',
            sourceKind: item.sourceKind, sourceKey: item.sourceKey, sourcePage: item.sourcePage, locator: item.locator } });
        return { artifactId: result.artifactId, title: player.caption || item.title, caption: player.caption || '' };
      } finally {
        if (page) await pages.closePlayer(page).catch(() => {});
        if (file && !submitted) require('node:fs').rmSync(file, { force: true });
        await connection.disconnect();
      }
    },
    async read_results(parameters, context) {
      const items = runtime.readState(context)?.items || [];
      if (!Array.isArray(items)) throw runtime.fail('STATE_CORRUPT', '人工任务结果格式损坏，请保留检查点。');
      return runtime.paginate(items, parameters);
    },
  };
}

function bounded(items, scope) {
  const selected = items.slice(0, 200);
  while (selected.length && Buffer.byteLength(JSON.stringify({ items: selected, scope }), 'utf8') > 900 * 1024) selected.pop();
  return { items: selected, scope: scope + (selected.length < items.length ? `（本次读取前${selected.length}条，请翻页或调整页面后继续读取）` : '') };
}

module.exports = { createAdapter, ...createAdapter() };
