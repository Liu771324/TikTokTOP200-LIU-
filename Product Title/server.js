'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readWorkbook } = require('./workbook');
const { connectEdge, cdpReady, closeDebugBrowser, ShopBrowser } = require('./browser');
const { newTask, runTask } = require('./task');
const { failureRows, failureWorkbook } = require('./report');

const HOST = '127.0.0.1', PORT = 8080, ORIGIN = `http://${HOST}:${PORT}`;

async function startServer({ connect = connectEdge, detect = cdpReady, closeBrowser = closeDebugBrowser, readInput = readWorkbook, open = true, reportDir = path.join(__dirname, 'reports') } = {}) {
  const state = { app: 'product-title-workbench', phase: 'disconnected', message: '点击“连接 Edge”打开调试浏览器并进入业务页面', shops: [], productStatuses: [{ value: '', label: '所有' }], input: null, inputError: '', task: null };
  let browser, adapter, controller, taskPromise, connectionPromise, closing = false, refreshing = false, timer;
  let reportQueue = Promise.resolve();
  let writtenFailures = '';
  const persist = () => {
    if (!state.task) return;
    const data = JSON.stringify(state.task, null, 2);
    const filename = `${state.task.startedAt.replace(/[:.]/g, '-')}.json`;
    reportQueue = reportQueue.then(async () => {
      await fs.mkdir(reportDir, { recursive: true });
      const temp = path.join(reportDir, `${filename}.tmp`);
      await fs.writeFile(temp, data, 'utf8');
      await fs.rename(temp, path.join(reportDir, filename));
      const snapshot = JSON.parse(data);
      const rows = failureRows(snapshot), key = `${filename}:${JSON.stringify(rows)}`;
      if (rows.length && key !== writtenFailures) {
        const excelFile = path.join(reportDir, `${filename.replace(/\.json$/, '')}-失败商品.xlsx`);
        await fs.writeFile(`${excelFile}.tmp`, await failureWorkbook(snapshot));
        await fs.rename(`${excelFile}.tmp`, excelFile);
        writtenFailures = key;
      }
    }).catch(error => { state.reportError = `结果文件写入失败：${error.message}`; });
  };

  async function loadInput() {
    try { state.input = await readInput(); state.inputError = ''; }
    catch (error) { state.input = null; state.inputError = error.message; }
  }

  async function refresh() {
    if (refreshing || closing || state.task?.status === 'running') throw new Error('当前正在处理任务，请稍后刷新');
    refreshing = true;
    try {
      await loadInput();
      if (!adapter) return;
      const ready = await adapter.prepare();
      state.phase = ready.status;
      state.message = ready.message;
      state.shops = ready.shops || [];
      state.productStatuses = ready.productStatuses || [{ value: '', label: '所有' }];
    } catch (error) {
      state.phase = 'error'; state.message = error.message; state.shops = [];
    } finally { refreshing = false; }
  }

  async function connectBrowser() {
    state.phase = 'connecting'; state.message = '正在连接调试版 Edge 并进入业务页面';
    try {
      if (!browser?.isConnected()) {
        browser = await connect();
        if (closing) return;
        adapter = new ShopBrowser(browser);
        browser.on('disconnected', () => { void shutdown('调试版 Edge 已关闭', false); });
      }
      await refresh();
      if (state.phase === 'ready') await adapter.page.bringToFront();
    } catch (error) {
      if (!closing) { state.phase = 'error'; state.message = error.message; state.shops = []; }
    } finally { connectionPromise = null; }
  }

  const json = (response, code, data) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== `${HOST}:${PORT}`) return json(response, 403, { error: '仅允许本机访问' });
      const url = new URL(request.url, ORIGIN);
      if (request.method === 'POST') {
        if (request.headers.origin !== ORIGIN) return json(response, 403, { error: '操作必须来自本地工作台' });
        if (closing) return json(response, 503, { error: '服务正在退出' });
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16384) return json(response, 413, { error: '请求过大' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
        catch { return json(response, 400, { error: '请求格式不正确' }); }
        if (url.pathname === '/api/connect') {
          if (connectionPromise || refreshing || state.task?.status === 'running') return json(response, 409, { error: '正在连接或处理任务，请稍后' });
          if (['ready', 'waiting-login'].includes(state.phase)) return json(response, 200, state);
          connectionPromise = connectBrowser();
          return json(response, 202, state);
        }
        if (url.pathname === '/api/refresh') {
          if (connectionPromise || refreshing || state.task?.status === 'running') return json(response, 409, { error: '当前正在连接或处理任务，请稍后刷新' });
          refreshing = true;
          try {
            if (state.phase === 'ready') await adapter.page.reload({ waitUntil: 'domcontentloaded' });
          } finally { refreshing = false; }
          await refresh(); return json(response, 200, state);
        }
        if (url.pathname === '/api/start') {
          if (connectionPromise || refreshing || state.task?.status === 'running') return json(response, 409, { error: '正在连接或已有任务正在执行' });
          if (state.phase !== 'ready') return json(response, 409, { error: state.message });
          const ids = body.shopIds;
          if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) {
            return json(response, 400, { error: '请至少勾选一家店铺' });
          }
          const shops = ids.map(id => state.shops.find(s => s.id === id));
          if (shops.some(s => !s)) return json(response, 400, { error: '店铺列表已变化，请刷新后重新选择' });
          refreshing = true;
          try {
            await adapter.assertReady();
            state.productStatuses = await adapter.productStatuses();
            const statusValue = body.productStatus === undefined ? '' : body.productStatus;
            const productStatus = state.productStatuses.find(s => s.value === statusValue);
            if (!productStatus) return json(response, 400, { error: '商品状态无效或选项已变化，请重新读取后选择' });
            await loadInput();
            if (state.inputError) return json(response, 400, { error: state.inputError });
            if (!state.input.titleCount) return json(response, 400, { error: 'Sheet1 中没有可执行的新标题' });
            controller = new AbortController();
            state.task = newTask(shops, state.input, productStatus);
            // 在返回请求前设置 running，阻止并发启动。
            persist();
            taskPromise = runTask(state.task, state.input, adapter, controller.signal, persist);
            return json(response, 202, state.task);
          } finally { refreshing = false; }
        }
        if (url.pathname === '/api/stop') {
          controller?.abort();
          return json(response, 200, { message: '已请求停止；正在保存的商品会先核对结果，随后停止' });
        }
        if (url.pathname === '/api/shutdown') {
          json(response, 200, { message: '工作台正在退出' });
          void shutdown('用户退出'); return;
        }
        return json(response, 404, { error: '不存在的操作' });
      }
      if (request.method !== 'GET') return json(response, 405, { error: '不支持的请求' });
      if (url.pathname === '/api/state') return json(response, 200, state);
      if (url.pathname === '/api/report') {
        if (!state.task) return json(response, 404, { error: '尚无任务结果' });
        response.setHeader('Content-Disposition', 'attachment; filename="product-title-result.json"');
        return json(response, 200, state.task);
      }
      if (url.pathname === '/api/failures.xlsx') {
        if (!state.task) return json(response, 404, { error: '尚无任务结果' });
        const snapshot = JSON.parse(JSON.stringify(state.task));
        response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="failed-products.xlsx"', 'Cache-Control': 'no-store' });
        response.end(await failureWorkbook(snapshot)); return;
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (!assets[url.pathname]) return json(response, 404, { error: '页面不存在' });
      const [file, type] = assets[url.pathname];
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'" });
      response.end(await fs.readFile(path.join(__dirname, 'public', file)));
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
  });

  // 先占用固定端口，确认成功后才操作 Edge。
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  }).catch(error => {
    if (error.code === 'EADDRINUSE') throw new Error('8080 端口已被占用，请关闭占用服务后重新启动；不会自动换端口');
    throw error;
  });
  console.log(`商品标题工作台：${ORIGIN}`);

  async function shutdown(reason, closeEdge = true) {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    process.stdin.pause();
    controller?.abort();
    await connectionPromise?.catch(() => {});
    if (closeEdge) await closeBrowser(browser).catch(() => {});
    await taskPromise?.catch(() => {});
    persist();
    await reportQueue;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    console.log(`工作台已退出：${reason}`);
  }
  try {
    await loadInput();
    if (open && process.env.NO_OPEN !== '1' && process.platform === 'win32' && !closing) {
      const child = spawn('cmd.exe', ['/c', 'start', '', ORIGIN], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', error => { console.error(`请手动打开 ${ORIGIN}：${error.message}`); });
      child.unref();
    }
    timer = setInterval(() => {
      if (state.phase === 'waiting-login' && !refreshing && !closing) void refresh();
    }, 3000);
    timer.unref();
    if (await detect() && !closing && !connectionPromise && state.phase === 'disconnected') connectionPromise = connectBrowser();
  } catch (error) {
    await shutdown('启动失败');
    throw error;
  }
  return { server, state, shutdown, get browser() { return browser; } };
}

if (require.main === module) {
  let running;
  let ending = false;
  const stop = () => { ending = true; if (running) void running.shutdown('启动脚本关闭'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // 启动器的管道关闭时退出，避免关闭控制台后留下本地服务。
  process.stdin.resume();
  process.stdin.on('end', stop);
  const owner = Number(process.env.PRODUCT_TITLE_OWNER_PID);
  if (owner) {
    const watch = setInterval(() => {
      try { process.kill(owner, 0); }
      catch { clearInterval(watch); stop(); }
    }, 1000);
    watch.unref();
  }
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  startServer().then(result => {
    running = result;
    if (ending) void running.shutdown('启动脚本关闭');
  }).catch(error => { console.error(error.message); process.exitCode = 1; process.stdin.pause(); });
}
module.exports = { startServer };
