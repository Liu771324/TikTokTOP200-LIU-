'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter';
const TARGET_URL = 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank';
const DEBUG_DIR = path.join(process.env.TEMP || process.env.TMP || __dirname, 'edge-debug-top200');
const EDGE_PATH_FILE = path.join(__dirname, '.edge-path.txt');

const COMMON_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || 'C:\\', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

function registryEdgePath() {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ];
  for (const root of roots) {
    try {
      const output = execFileSync('reg.exe', ['query', root, '/ve'], { encoding: 'utf8', windowsHide: true });
      const line = output.split(/\r?\n/).find((entry) => /REG_SZ/i.test(entry));
      const candidate = line?.replace(/^.*?REG_SZ\s+/i, '').trim();
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch { /* 未安装在此注册表位置 */ }
  }
  return null;
}

function findEdgePath() {
  if (fs.existsSync(EDGE_PATH_FILE)) {
    const saved = fs.readFileSync(EDGE_PATH_FILE, 'utf8').trim();
    if (saved && fs.existsSync(saved)) return saved;
  }
  return registryEdgePath() || COMMON_PATHS.find((candidate) => fs.existsSync(candidate)) || null;
}

function saveEdgePath(edgePath) {
  const resolved = path.resolve(String(edgePath || '').trim());
  if (!fs.existsSync(resolved) || path.basename(resolved).toLowerCase() !== 'msedge.exe') {
    throw new Error('Edge 路径无效');
  }
  fs.writeFileSync(EDGE_PATH_FILE, resolved, 'utf8');
  return resolved;
}

function isCdpReady() {
  return new Promise((resolve) => {
    const request = http.get(`${CDP_URL}/json/version`, { timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

function launchEdgeDebug(edgePath) {
  const port = new URL(CDP_URL).port || '9222';
  const child = spawn(edgePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${DEBUG_DIR}`,
    LOGIN_URL,
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

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

module.exports = {
  CDP_URL,
  LOGIN_URL,
  TARGET_URL,
  EDGE_PATH_FILE,
  findEdgePath,
  saveEdgePath,
  isCdpReady,
  ensureEdgeDebug,
};
