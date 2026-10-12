'use strict';
const fs = require('node:fs');

async function run(parameters, context, api) {
  const count = parameters.count ?? parameters.categories?.length ?? 10;
  api.emit('log', { message: '中文、多行\n日志与 "引号"' });
  if (parameters.spawnChild) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    api.emit('progress', { childPid: child.pid });
  }
  for (let index = 0; index < count; index++) {
    api.checkpoint({ count: index });
    await api.boundary();
    api.emit('progress', { current: index, total: count });
    await new Promise(resolve => setTimeout(resolve, parameters.delay ?? 10));
  }
  if (parameters.candidate) await api.register(parameters.candidate);
  api.checkpoint({ count });
  return { state: 'completed' };
}

async function read_results(parameters, context) {
  const envelope = JSON.parse(fs.readFileSync(context.statePath, 'utf8'));
  return { items: [envelope.state], total: 1 };
}

async function discover(parameters, context, api) {
  await api.boundary();
  return { categories: [{ displayPath: '测试 / 类目', segments: ['测试', '类目'] }] };
}

async function capture_page() {
  return { items: [{ sourceKey: 'compass:fixture-video', sourceKind: 'compass_ranking', sourcePage: 'compass_ranking',
    title: '脱敏标题', mediaUrl: 'https://media.example.test/video?signature=secret',
    locator: { pageId: 'fixture-page', productKey: 'fixture-product', videoKey: 'fixture-video' } }], scope: '当前已加载内容' };
}

module.exports = { run, read_results, discover, capture_page };
