'use strict';
const compass = require('../../../Tiktok video/compass-page');
const { createCollector, safePart } = require('../../../Tiktok video/collector');
const runtime = require('../../../Tiktok video/toolbox-runtime');
const browserClient = require('../browser-client.cjs');

const descriptor = { id: 'manual-video', parameterVersion: 1, operations: ['capture_page', 'download_item', 'read_results'] };

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
        const page = await selectPage(connection.browser, parameters.pageId || context.browser?.pageId, pages.accepts);
        await runtime.ensureReady(page, factory(), api, false);
        const session = await page.context().newCDPSession(page);
        let pageId;
        try { pageId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await session.detach(); }
        const view = await pages.snapshot(page, pageId, () => api.boundary());
        const items = pages.captureItems(view, pageId, page.url().split('?')[0]);
        return { items: items.slice(0, 200), scope: `当前已加载的罗盘短视频榜卡片${items.length > 200 ? '（本次最多读取200条）' : ''}` };
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
        const view = await pages.snapshot(page, item.locator.pageId, () => api.boundary());
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

module.exports = { createAdapter, ...createAdapter() };
