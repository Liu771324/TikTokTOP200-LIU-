'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Windows 批处理入口保持纯 ASCII，避免 cmd.exe 误解析 UTF-8 语句块', () => {
  for (const name of ['启动采集.bat', '安装依赖.bat']) {
    const contents = fs.readFileSync(path.join(__dirname, '..', name));
    assert.equal([...contents].every((byte) => byte < 128), true, `${name} 包含非 ASCII 字节`);
  }
});
