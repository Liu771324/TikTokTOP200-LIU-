'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const engineFixtures = require('./integration-fixtures.cjs').fixtures();

async function mockApi(fixtures) {
  const descriptors = ['business-center', 'top200', 'video-ranking', 'manual-video'].map((toolId, i) => ({toolId,
    name: ['商机中心', '商品 TOP200', '自动短视频', '人工视频工作台'][i], available: true}));
  const events = [];
  let seq = 0;
  window.fixtureCalls = [];
  window.fixtureDetails = false;
  window.fixtureExportMode = 'completed';
  window.fixtureLocation = {path:'C:\\用户数据\\ScriptAllToolbox', freeBytes:20 * 1024 ** 3, totalBytes:100 * 1024 ** 3, pending:false, error:'迁移未完成，仍使用原数据。请检查目标空间和文件占用，再退出重开重试。'};
  window.fixtureExportLocation = {path:null};
  window.fixtureExportLocationMode = 'cancelled';
  window.fixtureLocationMode = 'cancelled';
  window.fixtureCleanMode = 'removed';
  const tasks = descriptors.map((tool, index) => ({id: String(index + 1).repeat(32), toolId: tool.toolId,
    createdAt:'2026-10-12T01:00:00.000Z', state:'completed_with_errors', progress:{message:'本地模拟结果'},
    capabilities:{supportsPause:false, supportsResume:false, supportsRetryFailed:false}}));
  tasks[2].progress = {scanned:4, eligible:2, videosSaved:3, duplicatesSkipped:1, videoFailures:2,
    captionFailures:1, currentRank:4, currentProduct:'正在处理的商品', currentVideo:2};
  window.fixtureVideoProgress = progress => {
    tasks[2].progress = progress;
    events.push({seq:++seq, type:'task.progress', taskId:tasks[2].id, data:progress});
  };
  const selectedVideo = {id:'9'.repeat(32), title:'待选中文视频😀', publicUrl:'https://www.douyin.com/video/1234567890123456789'};
  const exportResult = count => window.fixtureExportMode === 'cancelled'
    ? {exported:0, skipped:count, failed:0, cancelled:true}
    : window.fixtureExportMode === 'failed' ? {exported:0, skipped:0, failed:count}
      : {exported:count, skipped:0, failed:0};
  window.pywebview = {api: {invoke: async (action, p) => {
    window.fixtureCalls.push({action, p});
    let data = {};
    if (action === 'storage.get_export_location') data = window.fixtureExportLocation;
    if (action === 'storage.choose_export_location') {
      if (window.fixtureExportLocationMode === 'cancelled') data = {cancelled:true};
      else {
        window.fixtureExportLocation = {path:'D:\\下载结果'};
        data = {...window.fixtureExportLocation,cancelled:false};
      }
    }
    if (action === 'storage.get_location') data = window.fixtureLocation;
    if (action === 'storage.choose_location') {
      if (window.fixtureLocationMode === 'blocked') return {ok:false,error:{message:'请先结束活动任务和读取操作后再更改数据位置。'}};
      if (window.fixtureLocationMode === 'cancelled') data = {cancelled:true};
      else {
        window.fixtureLocation = {...window.fixtureLocation,pending:true,requestedPath:'D:\\电商数据\\ScriptAllToolbox'};
        data = {restartRequired:true,path:window.fixtureLocation.requestedPath};
      }
    }
    if (action === 'storage.clean_old_location') {
      data = {removed:window.fixtureCleanMode === 'removed',releasedBytes:window.fixtureCleanMode === 'removed' ? 1024 : 0};
      delete window.fixtureLocation.previousPath;
    }
    if (action === 'app.get_state') data = {tools: descriptors, browser: {edgeAvailable: true}};
    if (action === 'tasks.list') data = {items: window.fixtureDetails ? tasks : [], total: window.fixtureDetails ? tasks.length : 0};
    if (action === 'tasks.get') data = tasks.find(task => task.id === p.taskId);
    if (action === 'tasks.results') {
      const task = tasks.find(task => task.id === p.taskId);
      const section = p.section || 'results';
      let rows = fixtures[task.toolId].expected[section];
      if (!rows) return {ok:false, error:{message:'测试检测到不支持的结果分区'}};
      if (task.toolId === 'business-center' && section === 'results') rows = Array.from({length:51}, (_, i) => ({...rows[0], keyword:`商机第${i + 1}条`}));
      // The shared historical fixture predates Python page/attempt fields.
      if (task.toolId === 'business-center' && section === 'failures') rows = rows.map(row => ({...row,page:1,attempts:2}));
      data = {items:rows.slice(p.offset, p.offset + p.limit), total:rows.length};
    }
    if (action === 'tasks.artifacts') {
      const rows = Array.from({length:p.taskId === tasks[0].id ? 51 : 1}, (_, i) => ({
        id:String(i + 1).padStart(32,'0'), displayName:`交付文件${i + 1}.xlsx`, size:1024,
        metadata:{productName:'测试商品', sourceKind:p.taskId === tasks[2].id ? 'compass_ranking' : 'public',
          caption:p.taskId === tasks[2].id || p.taskId === tasks[3].id ? '' : i === 0 ? '任务独有文案😀' : ''}}));
      data = {items:rows.slice(p.offset, p.offset + p.limit), total:rows.length};
    }
    if (action === 'tasks.logs') {
      const rows = Array.from({length:101}, (_, i) => ({seq:i + 1, at:'2026-10-12T01:00:00.000Z', message:`本地日志${i + 1}`}));
      const items = rows.filter(row => row.seq > p.afterSeq).slice(0,p.limit);
      data = {items, nextSeq:items.at(-1)?.seq || p.afterSeq};
    }
    if (action === 'capture.list') data = {items:[selectedVideo], total:1};
    if (action === 'capture.export') data = exportResult(p.itemIds.length);
    if (action === 'artifacts.export') data = exportResult(p.artifactIds.length);
    if (action === 'tools.discover') {
      const operationId = 'fixture-' + seq;
      const result = p.toolId === 'video-ranking'
        ? {categories: ['测试 / 饮品'], brandTypes: ['不限'], periods: [{label: '近1天', value: 'one'}]}
        : {categories: [{displayPath: '测试 / 饮品', segments: ['测试', '饮品', '全部'], valuePath: ['1', '2', '0']}],
           brandTypes: ['不限'], rankingTypes: [{name: '总榜', periods: [], preferredPeriod: '实时'}]};
      events.push({seq: ++seq, type: 'operation.state', data: {operationId, kind: 'discover', state: 'completed', result}});
      data = {operationId};
    }
    if (action === 'events.read') data = {events: events.filter(e => e.seq > p.afterSeq), nextSeq: seq};
    // A controlled error keeps the form visible and exposes the submitted parameters to assertions.
    if (action === 'tasks.create') return {ok: false, error: {message: '测试创建拦截，不启动真实采集'}};
    return {ok: true, data};
  }}};
  document.addEventListener('DOMContentLoaded', () => window.dispatchEvent(new Event('pywebviewready')));
}

(async () => {
  const [url, executablePath, output] = process.argv.slice(2);
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: true, executablePath});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 720}});
    await context.addInitScript(mockApi, engineFixtures);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByText('还没有任务', {exact: true}).waitFor();
    await page.screenshot({path: path.join(output, 'task-center-1280.png')});
    for (const [tool, name] of [['business-center','商机中心'], ['top200','商品 TOP200'], ['video-ranking','自动短视频']]) {
      await page.getByRole('button', {name, exact: true}).click();
      await page.getByRole('button', {name: '读取平台条件', exact: true}).click();
      if (tool !== 'video-ranking') await page.locator('[data-multiple=category]').getByRole('checkbox').check();
      else await page.locator('select[name=category]').waitFor();
      if (tool === 'top200') await page.locator('[data-multiple=rankingTypes]').getByRole('checkbox').check();
      if (tool === 'video-ranking') await page.locator('select[name=trendMode]').selectOption('up_and_first');
      await page.getByRole('button', {name:'创建采集任务'}).click();
      const submitted = await page.evaluate(() => window.fixtureCalls.filter(c => c.action === 'tasks.create').at(-1).p.parameters);
      if (tool === 'business-center') {
        assert.equal(submitted.minSales, 10000);
        assert.equal(submitted.maxSales, null);
        assert.equal(submitted.only30dGrowth, false);
      }
      if (tool !== 'video-ranking') assert.deepEqual(submitted.categories[0].segments, ['测试', '饮品', '全部']);
      if (tool === 'top200') assert.deepEqual(submitted.rankingTypes, ['总榜']);
      if (tool === 'video-ranking') {
        assert.equal(submitted.period, '近1天');
        assert.equal(submitted.trendMode, 'up_and_first');
        assert.equal(typeof submitted.category, 'string');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.screenshot({path: path.join(output, 'video-conditions-1280.png')});
    await page.getByRole('button', {name:'人工视频工作台', exact:true}).click();
    await page.getByRole('button', {name:'添加到待选列表'}).waitFor();
    await page.screenshot({path: path.join(output, 'manual-workbench-1280.png')});
    await page.getByRole('checkbox', {name:'选择 待选中文视频😀'}).check();
    for (const [mode, message] of [['completed','已导出 1 条，跳过 0 条，失败 0 条。'],
      ['cancelled','已取消导出。'], ['failed','已导出 0 条，跳过 0 条，失败 1 条。']]) {
      await page.evaluate(mode => {window.fixtureExportMode=mode;}, mode);
      await page.getByRole('button', {name:'导出列表',exact:true}).click();
      await page.locator('#notice').getByText(message,{exact:true}).waitFor();
      assert.equal(await page.locator('#notice').getAttribute('class'), mode === 'failed' ? 'error' : '');
    }
    const captureExport = await page.evaluate(() => window.fixtureCalls.filter(c => c.action === 'capture.export').at(-1).p);
    assert.deepEqual(captureExport.itemIds, ['9'.repeat(32)]);
    await page.locator('#work-nav').getByRole('button',{name:'存储管理',exact:true}).click();
    await page.getByText('C:\\用户数据\\ScriptAllToolbox',{exact:true}).waitFor();
    await page.getByText('磁盘剩余 20.00 GB / 共 100.00 GB',{exact:true}).waitFor();
    await page.getByText('迁移未完成，仍使用原数据。请检查目标空间和文件占用，再退出重开重试。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'清理旧位置',exact:true}).count(),0);
    await page.getByRole('button',{name:'更改数据位置',exact:true}).click();
    await page.locator('#notice').getByText('已取消更改数据位置。',{exact:true}).waitFor();
    await page.evaluate(() => {window.fixtureLocationMode='blocked';});
    await page.getByRole('button',{name:'更改数据位置',exact:true}).click();
    await page.locator('#notice').getByText('请先结束活动任务和读取操作后再更改数据位置。',{exact:true}).waitFor();
    await page.evaluate(() => {window.fixtureLocationMode='restart';});
    await page.getByRole('button',{name:'更改数据位置',exact:true}).click();
    await page.locator('#notice').getByText('数据位置已选择。请退出软件，再次打开完成复制校验迁移。',{exact:true}).waitFor();
    await page.getByText('待迁移位置：D:\\电商数据\\ScriptAllToolbox。请退出软件后再次打开。',{exact:true}).waitFor();
    await page.getByText('C:\\用户数据\\ScriptAllToolbox',{exact:true}).waitFor();
    await page.evaluate(() => {window.fixtureLocation={...window.fixtureLocation,path:window.fixtureLocation.requestedPath,
      previousPath:window.fixtureLocation.path,pending:false};});
    await page.locator('#work-nav').getByRole('button',{name:'存储管理',exact:true}).click();
    await page.getByText('D:\\电商数据\\ScriptAllToolbox',{exact:true}).waitFor();
    await page.getByRole('button',{name:'清理旧位置',exact:true}).click();
    await page.locator('#notice').getByText('已清理旧位置，释放 1.0 KB。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'清理旧位置',exact:true}).count(),0);
    await page.evaluate(() => {window.fixtureCleanMode='none';window.fixtureLocation.previousPath='C:\\旧数据';});
    await page.locator('#work-nav').getByRole('button',{name:'存储管理',exact:true}).click();
    await page.getByRole('button',{name:'清理旧位置',exact:true}).click();
    await page.locator('#notice').getByText('没有需要清理的旧位置。',{exact:true}).waitFor();
    await page.getByText('默认导出位置',{exact:true}).waitFor();
    await page.getByText('尚未设置，导出时选择文件夹。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
    await page.locator('#notice').getByText('已取消选择默认导出位置。',{exact:true}).waitFor();
    await page.evaluate(() => {window.fixtureExportLocationMode='selected';});
    await page.getByRole('button',{name:'选择文件夹',exact:true}).click();
    await page.getByText('D:\\下载结果',{exact:true}).waitFor();
    await page.locator('#notice').getByText('默认导出位置已保存。',{exact:true}).waitFor();
    const exportLocationCalls = await page.evaluate(() => window.fixtureCalls.filter(c =>
      ['storage.get_export_location','storage.choose_export_location'].includes(c.action)));
    assert.ok(exportLocationCalls.length); assert.ok(exportLocationCalls.every(c => Object.keys(c.p).length === 0));
    const locationCalls = await page.evaluate(() => window.fixtureCalls.filter(c =>
      ['storage.get_location','storage.choose_location','storage.clean_old_location'].includes(c.action)));
    assert.ok(locationCalls.length); assert.ok(locationCalls.every(c => Object.keys(c.p).length === 0));
    await page.evaluate(() => {window.fixtureDetails=true;window.fixtureExportMode='completed';});
    await page.locator('#work-nav').getByRole('button', {name:'任务中心',exact:true}).click();
    const autoRow = page.locator('[data-task-id="'+ '3'.repeat(32) +'"]');
    assert.ok((await autoRow.textContent()).includes('扫描 4 件 · 符合条件 2 件 · 新视频 3 条 · 重复引用 1 条 · 视频失败 2 条 · 文案缺失 1 条'));
    assert.ok((await autoRow.textContent()).includes('正在处理的商品'));
    await page.locator('[data-task-id="'+ '1'.repeat(32) +'"]').getByRole('button',{name:'查看',exact:true}).click();
    const files = page.locator('#detail-files');
    const results = page.locator('#detail-results');
    const logs = page.locator('#detail-logs');
    const dialog = page.locator('#dialog');
    const closeDetail = dialog.getByRole('button',{name:'关闭任务详情',exact:true});
    const lastCall = action => page.evaluate(action => window.fixtureCalls.filter(c => c.action === action).at(-1).p, action);
    await results.getByRole('cell',{name:'商机第1条',exact:true}).waitFor();
    assert.equal(await results.getByRole('button',{name:'上一页',exact:true}).isDisabled(),true);
    await results.getByRole('button',{name:'下一页',exact:true}).click();
    await results.getByRole('cell',{name:'商机第51条',exact:true}).waitFor();
    assert.equal((await lastCall('tasks.results')).offset,50);
    assert.equal(await results.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true);
    await results.getByRole('button',{name:'失败记录',exact:true}).click();
    await results.getByRole('columnheader',{name:'失败原因',exact:true}).waitFor();
    await results.getByRole('columnheader',{name:'页码',exact:true}).waitFor();
    await results.getByRole('columnheader',{name:'尝试次数',exact:true}).waitFor();
    assert.deepEqual(await lastCall('tasks.results'),{taskId:'1'.repeat(32),offset:0,limit:50,section:'failures'});
    assert.ok((await results.textContent()).includes(engineFixtures['business-center'].expected.failures[0].reason));
    await results.getByRole('button',{name:'无法解析',exact:true}).click();
    assert.equal((await lastCall('tasks.results')).section,'unparseableItems');
    assert.ok((await results.textContent()).includes(engineFixtures['business-center'].expected.unparseableItems[0].reason));
    await results.getByRole('button',{name:'正常结果',exact:true}).click();
    await results.getByRole('cell',{name:'商机第1条',exact:true}).waitFor();
    assert.equal((await lastCall('tasks.results')).offset,0);
    assert.equal(await files.getByRole('button',{name:'导出所选',exact:true}).isDisabled(),true);
    await files.getByRole('button',{name:'选中本页',exact:true}).click();
    await files.getByText('已选 50 个（最多200个）',{exact:true}).waitFor();
    await files.getByRole('button',{name:'下一页',exact:true}).click();
    await files.getByRole('checkbox',{name:'选择 交付文件51.xlsx',exact:true}).check();
    await files.getByText('已选 51 个（最多200个）',{exact:true}).waitFor();
    assert.equal((await lastCall('tasks.artifacts')).offset,50);
    assert.equal(await files.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true);
    await results.getByRole('cell',{name:'商机第1条',exact:true}).waitFor();
    await files.getByRole('button',{name:'导出所选',exact:true}).click();
    assert.equal((await lastCall('artifacts.export')).artifactIds.length,51);
    await page.locator('#notice').getByText('已导出 51 项，跳过 0 项，失败 0 项。',{exact:true}).waitFor();
    await files.getByRole('button',{name:'上一页',exact:true}).click();
    assert.equal((await lastCall('tasks.artifacts')).offset,0);
    assert.equal(await files.getByRole('checkbox').count(),50);
    assert.equal(await files.locator('input:checked').count(),50);
    await files.getByRole('button',{name:'清空选择',exact:true}).click();
    assert.equal(await files.getByRole('button',{name:'导出所选',exact:true}).isDisabled(),true);
    await dialog.getByRole('button',{name:'查看日志',exact:true}).click();
    await logs.getByRole('button',{name:'下一页日志',exact:true}).click();
    await logs.getByText(/本地日志101/).waitFor();
    assert.deepEqual(await lastCall('tasks.logs'),{taskId:'1'.repeat(32),afterSeq:100,limit:100});
    assert.equal(await logs.getByRole('button',{name:'下一页日志',exact:true}).count(),0);
    await logs.getByRole('button',{name:'返回首屏日志',exact:true}).click();
    assert.equal((await lastCall('tasks.logs')).afterSeq,0);
    await logs.getByRole('button',{name:'下一页日志',exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'task-detail-1280.png')});
    await files.getByRole('checkbox',{name:'选择 交付文件1.xlsx',exact:true}).check();
    await files.getByRole('button',{name:'下一页',exact:true}).click();
    await results.getByRole('button',{name:'失败记录',exact:true}).click();
    await dialog.evaluate(node => {node.scrollTop=node.scrollHeight;});
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await dialog.locator('.task-detail-header').evaluate(node => {
      return Math.abs(node.getBoundingClientRect().top-node.closest('dialog').getBoundingClientRect().top)<=2;
    }),true,'Sticky header stays flush with the dialog top');
    assert.equal(await closeDetail.evaluate(node => {
      const rect=node.getBoundingClientRect(), modal=node.closest('dialog').getBoundingClientRect();
      return rect.top>=modal.top && rect.bottom<=modal.bottom && rect.right<=modal.right
        && document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===node;
    }),true,'Top-right close remains reachable after scrolling to the end');
    assert.equal(await page.locator('#dialog-close').isVisible(),false);
    assert.equal(await closeDetail.evaluate(node => node.tabIndex),0);
    await closeDetail.focus();
    assert.equal(await closeDetail.evaluate(node => document.activeElement===node),true);
    await page.screenshot({path:path.join(output,'task-detail-scrolled-close-1280.png')});
    await closeDetail.click();
    assert.equal(await dialog.evaluate(node => node.open),false);
    assert.equal(await page.locator('#title').textContent(),'任务中心');
    await page.locator('[data-task-id="'+ '1'.repeat(32) +'"]').getByRole('button',{name:'查看',exact:true}).click();
    assert.deepEqual(await lastCall('tasks.results'),{taskId:'1'.repeat(32),offset:0,limit:50,section:'results'});
    assert.equal((await lastCall('tasks.artifacts')).offset,0);
    assert.equal(await files.locator('input:checked').count(),0);
    assert.equal(await files.getByRole('button',{name:'导出所选',exact:true}).isDisabled(),true);
    await closeDetail.click();
    await page.locator('[data-task-id="'+ '2'.repeat(32) +'"]').getByRole('button',{name:'查看',exact:true}).click();
    assert.deepEqual(await lastCall('tasks.results'),{taskId:'2'.repeat(32),offset:0,limit:50,section:'results'});
    assert.equal((await lastCall('tasks.artifacts')).offset,0);
    assert.equal(await files.getByRole('button',{name:'导出所选',exact:true}).isDisabled(),true);
    assert.equal(await files.locator('input:checked').count(),0);
    assert.equal(await results.getByRole('button',{name:'无法解析',exact:true}).count(),0);
    await results.getByRole('button',{name:'失败记录',exact:true}).click();
    for(const name of ['错误信息','处理阶段','页码','重试次数','记录时间']) await results.getByRole('columnheader',{name,exact:true}).waitFor();
    assert.ok((await results.textContent()).includes(engineFixtures.top200.expected.failures[0].error));
    await closeDetail.click();
    for(const id of ['3','4']) {
      await page.locator('[data-task-id="'+id.repeat(32)+'"]').getByRole('button',{name:'查看',exact:true}).click();
      assert.equal(await results.getByRole('button',{name:'失败记录',exact:true}).count(),0);
      await results.getByRole('columnheader',{name:'错误信息',exact:true}).waitFor();
      const expectedError = engineFixtures[id === '3' ? 'video-ranking' : 'manual-video'].expected.results.find(row => row.error).error.message;
      assert.ok((await results.textContent()).includes(expectedError));
      if (id === '3') {
        await page.locator('.detail-progress').getByText(/视频失败 2 条 · 文案缺失 1 条/).waitFor();
        await files.getByText('未读取到文案，可重试异常项补充',{exact:true}).waitFor();
        await page.evaluate(() => window.fixtureVideoProgress({scanned:5,eligible:3,videosSaved:4,duplicatesSkipped:2,
          videoFailures:3,captionFailures:2,currentRank:5,currentProduct:'增量商品',currentVideo:3}));
        await page.locator('.detail-progress').getByText(/扫描 5 件.*视频失败 3 条 · 文案缺失 2 条.*增量商品.*第 3 条视频/).waitFor();
      } else {
        assert.equal(await files.getByText('未读取到文案，可重试异常项补充',{exact:true}).count(),0);
        assert.equal(await page.locator('.detail-progress').textContent(),'本地模拟结果');
      }
      await closeDetail.click();
    }
    await page.locator('#work-nav').getByRole('button',{name:'任务中心',exact:true}).click();
    await autoRow.getByText(/扫描 5 件.*视频失败 3 条 · 文案缺失 2 条/).waitFor();
    await context.close();
    const highDpi = await browser.newContext({viewport:{width:1280,height:720}, deviceScaleFactor:1.5});
    await highDpi.addInitScript(mockApi, engineFixtures);
    const highPage = await highDpi.newPage();
    await highPage.goto(url);
    await highPage.getByText('还没有任务', {exact:true}).waitFor();
    await highPage.screenshot({path: path.join(output, 'task-center-150-percent.png')});
    await highDpi.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({forms:3, categoryObjectPreserved:true, rankingNames:true,
      periodLabel:true, amountUnitYuan:true, resultSections:3, resultPagination:true, artifactPagination:true,
      selectionAcrossPages:true, logPagination:true, captureExportFeedback:['completed','cancelled','failed'],
      defaultExportLocation:true, defaultExportLocationEmptyPayload:true, defaultExportLocationCancel:true, storageMigrationFailureVisible:true, storageLocationDisplay:true, storageLocationSystemPicker:true, storageMigrationRestartHint:true, storageOldLocationCleanup:true, failureHeaders:true, automaticProgressWithoutMessage:true, automaticProgressEvents:true, missingCompassCaptionHint:true, publicCaptionHintAbsent:true, topRightDetailClose:true, stickyCloseReachable:true, detailSelectionClearedOnClose:true,
      viewport:'1280x720', highDpi:1.5, pageErrors:errors.length}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
