// Edge 自动检测与调试模式启动（跨电脑复用，不写死本机路径）
// 用法（模块）：
//   const edge = require('./edge');
//   const result = await edge.ensureEdgeDebug();
//   返回 { status: 'ready' | 'launched' | 'need-path', edgePath?, cdpUrl? }
// 用法（命令行）：node edge.js ensure
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const PAGE_URL = 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter';
const DEBUG_DIR = path.join(process.env.TEMP || '.', 'edge-debug');
// 用户手动指定过 Edge 路径就记在这里（跨电脑第一次找不到时用）
const EDGE_PATH_FILE = path.join(__dirname, '.edge-path.txt');

// 常见安装位置 + 注册表
const COMMON_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || 'C:\\', 'Microsoft\\Edge\\Application\\msedge.exe'),
];

function registryEdgePath() {
  const commands = [
    'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe" /ve',
    'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe" /ve',
  ];
  for (const cmd of commands) {
    try {
      const out = execSync(cmd, { encoding: 'utf8', windowsHide: true });
      const m = out.match(/\r?\nREG_SZ\s+(\S+)/i) || out.match(/([A-Za-z]:\\[^\r\n]+msedge\.exe)/i);
      if (m && fs.existsSync(m[1])) return m[1];
    } catch { /* 注册表项不存在则跳过 */ }
  }
  return null;
}

function findEdgePath() {
  // 1) 用户手动记录过的路径
  if (fs.existsSync(EDGE_PATH_FILE)) {
    const saved = fs.readFileSync(EDGE_PATH_FILE, 'utf8').trim();
    if (saved && fs.existsSync(saved)) return saved;
  }
  // 2) 注册表
  const fromRegistry = registryEdgePath();
  if (fromRegistry) return fromRegistry;
  // 3) 常见安装位置
  for (const candidate of COMMON_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function saveEdgePath(edgePath) {
  fs.writeFileSync(EDGE_PATH_FILE, edgePath.trim(), 'utf8');
}

function isCdpReady() {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function launchEdgeDebug(edgePath) {
  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${DEBUG_DIR}`,
    PAGE_URL, // 直接打开商机中心，用户只需扫码登录
  ];
  spawn(edgePath, args, { detached: true, stdio: 'ignore' }).unref();
}

// 确保 9222 上有可用的调试版 Edge；没有则拉起一个
async function ensureEdgeDebug() {
  if (await isCdpReady()) return { status: 'ready', cdpUrl: CDP_URL };

  const edgePath = findEdgePath();
  if (!edgePath) return { status: 'need-path', cdpUrl: CDP_URL };

  launchEdgeDebug(edgePath);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isCdpReady()) return { status: 'launched', edgePath, cdpUrl: CDP_URL };
  }
  return { status: 'launched', edgePath, cdpUrl: CDP_URL, timeout: true };
}

async function main() {
  const [, , subcommand, arg] = process.argv;
  if (subcommand === 'save-path' && arg) {
    saveEdgePath(arg);
    console.log(JSON.stringify({ ok: true, edgePath: arg }));
    return;
  }
  if (subcommand === 'find-path') {
    console.log(JSON.stringify({ edgePath: findEdgePath() }));
    return;
  }
  const result = await ensureEdgeDebug();
  console.log(JSON.stringify(result));
}

if (require.main === module) main();

module.exports = { findEdgePath, saveEdgePath, ensureEdgeDebug, isCdpReady, EDGE_PATH_FILE, CDP_URL, PAGE_URL };
