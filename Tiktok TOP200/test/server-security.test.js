'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...options.headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('本地服务限制 Host/Origin、写请求令牌，并让历史列表保持摘要', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('采集服务已启动')) { clearTimeout(timeout); resolve(); }
    });
    child.once('exit', (code) => reject(new Error(`服务提前退出：${code}`)));
  });

  assert.equal((await request(port, '/', { headers: { Host: `example.test:${port}` } })).status, 403);
  assert.equal((await request(port, '/api/edge-path', { method: 'POST', headers: { Origin: 'https://attacker.test' }, body: '{}' })).status, 403);
  assert.equal((await request(port, '/api/edge-path', { method: 'POST', body: '{}' })).status, 403);
  const session = await request(port, '/api/session');
  assert.equal(session.status, 200);
  assert.match(session.json.token, /^[a-f0-9]{48}$/);
  assert.equal((await request(port, '/api/edge-path', { method: 'POST', headers: { 'X-Top200-Token': session.json.token }, body: '{}' })).status, 400);
  const history = await request(port, '/api/tasks');
  assert.equal(history.status, 200);
  for (const task of history.json.tasks) {
    assert.equal('results' in task, false);
    assert.equal('failures' in task, false);
    assert.equal(typeof task.resultCount, 'number');
    assert.equal(typeof task.failureCount, 'number');
  }
});
