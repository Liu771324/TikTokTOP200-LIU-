'use strict';
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function closedPort() {
  return new Promise(resolve => {
    const socket = net.connect(8080, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
  });
}
for (const mode of ['stdin', 'owner']) {
  test(`独立启动进程 ${mode === 'stdin' ? '启动管道关闭' : '启动窗口进程退出'} 后释放 8080`, async () => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    const child = spawn(process.execPath, ['-r', './test/lifecycle-preload.cjs', 'server.js'], {
      cwd: path.join(__dirname, '..'), windowsHide: true,
      env: { ...process.env, PRODUCT_TITLE_OWNER_PID: String(owner.pid) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const response = await fetch('http://127.0.0.1:8080/api/state');
          if ((await response.json()).phase === 'ready') { ready = true; break; }
        } catch {}
        await delay(100);
      }
      assert.equal(ready, true, output);
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (mode === 'stdin') child.stdin.end(); else owner.kill();
      await Promise.race([exited, delay(15000).then(() => { throw new Error(`未按时退出：${output}`); })]);
      assert.equal(await closedPort(), true);
      assert.match(output, /工作台已退出/);
    } finally { owner.kill(); child.kill(); }
  });
}
