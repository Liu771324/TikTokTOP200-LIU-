'use strict';
const fs = require('node:fs');

async function run(parameters, context, api) {
  const count = parameters.count ?? 10;
  api.emit('log', { message: '中文、多行\n日志与 "引号"' });
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

module.exports = { run, read_results };
