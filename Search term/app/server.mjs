import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { SpreadsheetFile } from "../.artifact-build/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";
import { summarizeProcessError } from "./lib/process-error.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(appDir);
const publicDir = path.join(appDir, "public");
const runtimeDir = path.join(appDir, "runtime");
const uploadDir = path.join(runtimeDir, "uploads");
const jobsDir = path.join(runtimeDir, "jobs");
const outputsDir = path.join(rootDir, "outputs");
const require = createRequire(import.meta.url);
const sharedEdge = require(path.join(rootDir, "..", "商机中心", "edge.js"));
const { chromium } = require(path.join(rootDir, ".artifact-build", "node_modules", "playwright-core"));
const businessLoginUrl = "https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter";
const compassSearchUrl = "https://compass.jinritemai.com/shop/search/drainage-terms";
const port = Number(process.env.PORT || 4173);
const jobs = new Map();
let currentUpload = null;

await Promise.all([uploadDir, jobsDir, outputsDir].map(dir => fsp.mkdir(dir, { recursive: true })));

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("文件超过 25MB 限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeFilename(name) {
  return path.basename(name || "选品表格.xlsx").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

async function parseTerms(buffer) {
  const workbook = await SpreadsheetFile.importXlsx(buffer);
  for (const sheet of workbook.worksheets.items) {
    const used = sheet.getUsedRange(true);
    const values = used?.values || [];
    for (let rowIndex = 0; rowIndex < Math.min(values.length, 30); rowIndex += 1) {
      const row = values[rowIndex] || [];
      let colIndex = row.findIndex(value => String(value ?? "").trim() === "热门搜索词");
      if (colIndex < 0) colIndex = row.findIndex(value => String(value ?? "").trim() === "搜索词");
      if (colIndex < 0) continue;
      const terms = values.slice(rowIndex + 1).map(item => String(item?.[colIndex] ?? "").trim()).filter(Boolean);
      const uniqueTerms = [...new Set(terms)];
      if (!uniqueTerms.length) throw new Error("关键词列下方没有可处理内容");
      return { sheetName: sheet.name, header: String(row[colIndex]).trim(), terms: uniqueTerms, originalCount: terms.length };
    }
  }
  throw new Error("未找到“热门搜索词”或“搜索词”列");
}

async function edgeStatus() {
  try {
    const response = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1200) });
    if (!response.ok) throw new Error("offline");
    const info = await response.json();
    return { connected: true, browser: info.Browser || "Edge", port: 9222, profile: path.join(process.env.TEMP || ".", "edge-debug") };
  } catch {
    return { connected: false, browser: "Edge", port: 9222, profile: path.join(process.env.TEMP || ".", "edge-debug") };
  }
}

async function ensureBusinessPage() {
  const response = await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(3000) });
  const targets = await response.json();
  if (targets.some(target => String(target.url || "").includes("fxg.jinritemai.com/ffa/bu/NewBusinessCenter"))) return;
  await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(businessLoginUrl)}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
}

async function connectCompassAfterBusinessLogin() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 10000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("调试版 Edge 中没有可用页面");
  const business = context.pages().find(page => page.url().includes("fxg.jinritemai.com/ffa/bu/NewBusinessCenter"));
  if (!business) throw new Error("请先打开并登录商机中心");
  let compass = context.pages().find(page => page.url().includes("/shop/search/drainage-terms"));
  if (!compass) {
    compass = await context.newPage();
    await compass.goto(compassSearchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await compass.waitForTimeout(3000);
  }
  if (!compass.url().includes("/shop/search/drainage-terms")) {
    await business.goto(businessLoginUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await business.bringToFront().catch(() => {});
    throw new Error("请先在调试版 Edge 的商机中心页面完成登录，登录后程序会自动进入罗盘搜索词页面");
  }
  await compass.locator("#_sync__query_condition").waitFor({ state: "visible", timeout: 20000 });
  await compass.bringToFront().catch(() => {});
  return { businessUrl: business.url(), compassUrl: compass.url() };
}

async function ensureSharedEdge() {
  const result = await sharedEdge.ensureEdgeDebug();
  if (result.status === "need-path") throw new Error("未找到 Microsoft Edge，请先在商机中心工具中配置 Edge 路径");
  if (!(await edgeStatus()).connected) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !(await edgeStatus()).connected) await new Promise(resolve => setTimeout(resolve, 750));
  }
  if (!(await edgeStatus()).connected) throw new Error("Edge 已启动，但调试端口 9222 尚未就绪，请稍后重试");
  await ensureBusinessPage();
  return { ...result, profile: path.join(process.env.TEMP || ".", "edge-debug") };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    activeTerm: job.activeTerm,
    progress: job.progress,
    counts: job.counts,
    logs: job.logs.slice(-120),
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    downloadReady: job.status === "completed",
  };
}

async function persistJob(job) {
  await fsp.writeFile(path.join(jobsDir, `${job.id}.json`), JSON.stringify(publicJob(job), null, 2), "utf8");
}

function addLog(job, line) {
  let message = line.trim();
  if (!message) return;
  if (message.startsWith('{"kind":') || message.startsWith("Inspect result written to file:")) return;
  if (message.length > 1200) message = `${message.slice(0, 1197)}...`;
  job.logs.push({ time: new Date().toISOString(), message });
  if (job.logs.length > 240) job.logs.splice(0, job.logs.length - 240);
  const start = message.match(/^===== 开始处理 (.+) =====$/);
  const business = message.match(/^\[商机中心\] (.+) 第(\d+)页，页面(\d+)条，累计匹配(\d+)条$/);
  const compass = message.match(/^\[抖音罗盘\] (.+) 第(\d+)页，页面(\d+)条，累计匹配(\d+)条$/);
  if (start) { job.activeTerm = start[1]; job.stage = "business"; }
  if (business) { job.activeTerm = business[1]; job.stage = "business"; job.progress.page = Number(business[2]); job.counts.business = Number(business[4]); }
  if (compass) { job.activeTerm = compass[1]; job.stage = "compass"; job.progress.page = Number(compass[2]); job.counts.compass = Number(compass[4]); }
}

function runProcess(job, scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, ".artifact-build", scriptName), ...args], { cwd: path.join(rootDir, ".artifact-build"), windowsHide: true });
    let stderr = "";
    const consume = chunk => String(chunk).split(/\r?\n/).forEach(line => addLog(job, line));
    child.stdout.on("data", consume);
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${String(chunk)}`;
      if (stderr.length > 120000) stderr = stderr.slice(-120000);
      consume(chunk);
    });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(summarizeProcessError(stderr, scriptName))));
  });
}

async function runJob(job) {
  try {
    job.status = "running";
    job.stage = "business";
    await persistJob(job);
    await runProcess(job, "collect_data.mjs", [job.configPath]);
    job.stage = "export";
    const collected = JSON.parse(await fsp.readFile(job.dataPath, "utf8"));
    job.counts = { business: collected.business.length, compass: collected.compass.length, unprocessed: collected.unprocessed.length };
    await runProcess(job, "build_output.mjs", [job.configPath]);
    job.status = "completed";
    job.stage = "done";
    job.activeTerm = "";
    job.completedAt = new Date().toISOString();
    addLog(job, `结果已生成：${path.basename(job.outputPath)}`);
  } catch (error) {
    job.status = "failed";
    job.stage = "failed";
    job.error = error.message;
    addLog(job, `任务失败：${error.message}`);
  }
  await persistJob(job);
}

async function createJob() {
  if (!currentUpload) throw new Error("请先上传选品表格");
  if ([...jobs.values()].some(job => job.status === "running" || job.status === "queued")) throw new Error("已有采集任务正在运行");
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const jobDir = path.join(jobsDir, id);
  await fsp.mkdir(jobDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 8) + "-" + new Date().toTimeString().slice(0, 8).replace(/:/g, "");
  const job = {
    id,
    status: "queued",
    stage: "queued",
    activeTerm: "",
    progress: { page: 0, totalTerms: currentUpload.terms.length },
    counts: { business: 0, compass: 0, unprocessed: 0 },
    logs: [], error: "", createdAt: new Date().toISOString(), completedAt: "",
    dataPath: path.join(jobDir, "collected-data.json"),
    outputPath: path.join(outputsDir, `商机词与罗盘搜索词-${stamp}.xlsx`),
  };
  job.configPath = path.join(jobDir, "config.json");
  await fsp.writeFile(job.configPath, JSON.stringify({ cores: currentUpload.terms, dataPath: job.dataPath, outputPath: job.outputPath, previews: false }, null, 2), "utf8");
  jobs.set(id, job);
  addLog(job, `已载入 ${currentUpload.terms.length} 个核心词，等待采集`);
  await persistJob(job);
  runJob(job);
  return job;
}

async function listResults() {
  const files = (await fsp.readdir(outputsDir, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith(".xlsx"));
  const rows = await Promise.all(files.map(async item => {
    const stat = await fsp.stat(path.join(outputsDir, item.name));
    return { name: item.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }));
  return rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 20);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/status") {
      const latestJob = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return sendJson(res, 200, { edge: await edgeStatus(), upload: currentUpload && { name: currentUpload.name, size: currentUpload.size, sheetName: currentUpload.sheetName, header: currentUpload.header, terms: currentUpload.terms, originalCount: currentUpload.originalCount }, latestJob: latestJob ? publicJob(latestJob) : null, results: await listResults() });
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const name = safeFilename(url.searchParams.get("filename"));
      if (!/\.xlsx$/i.test(name)) return sendJson(res, 400, { error: "请上传 .xlsx 格式的选品表格" });
      const body = await readBody(req);
      const parsed = await parseTerms(body);
      const savedName = `${Date.now()}-${name}`;
      const savedPath = path.join(uploadDir, savedName);
      await fsp.writeFile(savedPath, body);
      currentUpload = { name, size: body.length, path: savedPath, ...parsed, uploadedAt: new Date().toISOString() };
      await fsp.writeFile(path.join(runtimeDir, "current-upload.json"), JSON.stringify(currentUpload, null, 2), "utf8");
      return sendJson(res, 200, { upload: { name, size: body.length, ...parsed } });
    }
    if (req.method === "POST" && url.pathname === "/api/edge/ensure") {
      const result = await ensureSharedEdge();
      return sendJson(res, 200, { edge: await edgeStatus(), launched: result.status === "launched", message: result.status === "launched" ? "已启动共用调试版 Edge，请完成登录" : "已连接共用调试版 Edge" });
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      let edge = await edgeStatus();
      if (!edge.connected) {
        const result = await ensureSharedEdge();
        edge = await edgeStatus();
        if (result.status === "launched") return sendJson(res, 409, { error: "已启动共用调试版 Edge，请登录两个后台后再次开始", edgeLaunched: true, edge });
      }
      await connectCompassAfterBusinessLogin();
      const job = await createJob();
      return sendJson(res, 202, { job: publicJob(job) });
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      return job ? sendJson(res, 200, { job: publicJob(job) }) : sendJson(res, 404, { error: "任务不存在" });
    }
    const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/download$/);
    if (req.method === "GET" && downloadMatch) {
      const job = jobs.get(downloadMatch[1]);
      if (!job || job.status !== "completed") return sendJson(res, 404, { error: "结果尚未生成" });
      res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(job.outputPath))}` });
      return fs.createReadStream(job.outputPath).pipe(res);
    }
    const resultMatch = url.pathname.match(/^\/api\/results\/(.+)$/);
    if (req.method === "GET" && resultMatch) {
      const name = safeFilename(decodeURIComponent(resultMatch[1]));
      const resultPath = path.join(outputsDir, name);
      if (!name.endsWith(".xlsx") || !fs.existsSync(resultPath)) return sendJson(res, 404, { error: "结果文件不存在" });
      res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
      return fs.createReadStream(resultPath).pipe(res);
    }
    if (req.method !== "GET") return sendJson(res, 404, { error: "接口不存在" });
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(publicDir, relative);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendJson(res, 404, { error: "页面不存在" });
    res.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "请求处理失败" });
  }
});

try {
  currentUpload = JSON.parse(await fsp.readFile(path.join(runtimeDir, "current-upload.json"), "utf8"));
  await fsp.access(currentUpload.path);
} catch { currentUpload = null; }

server.listen(port, "127.0.0.1", () => console.log(`商机双链路控制台：http://127.0.0.1:${port}`));
