const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stopRequested, waitWhilePaused } = require('../collection_control');

test('没有 STOP_FILE 时不误判为停止', () => {
  assert.equal(stopRequested(''), false);
});

test('暂停中收到停止标记会立即退出等待', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-center-control-'));
  const pauseFile = path.join(dir, 'pause.flag');
  const stopFile = path.join(dir, 'stop.flag');
  fs.writeFileSync(pauseFile, '', 'utf8');
  let waits = 0;

  const stopped = await waitWhilePaused({
    pauseFile,
    stopFile,
    wait: async () => {
      waits += 1;
      fs.writeFileSync(stopFile, 'stop', 'utf8');
    },
  });

  assert.equal(stopped, true);
  assert.equal(waits, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
