const $ = selector => document.querySelector(selector);
const state = { edge: false, upload: null, job: null, pollTimer: null };

const formatBytes = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const formatDate = value => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => el.classList.remove("show"), 2800);
}

function updateClock() {
  $("#clock").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function renderReadiness() {
  const readyCount = Number(state.edge) + Number(Boolean(state.upload));
  $("#readinessScore").textContent = `${readyCount} / 2`;
  $("#startButton").disabled = !state.upload || ["queued", "running"].includes(state.job?.status);
  $("#startButton span").textContent = state.edge ? "开始双链路采集" : "启动共用调试 Edge";
  $("#edgeCheck").classList.toggle("ready", state.edge);
  $("#edgeCheck .check-state").textContent = state.edge ? "已连接" : "未连接";
  $("#edgeText").textContent = state.edge ? "已接入调试端口 9222" : "请启动调试 Edge 并登录";
  $("#edgeMiniDot").classList.toggle("online", state.edge);
  $("#edgeMiniText").textContent = state.edge ? "Edge 已连接" : "Edge 未连接";
  $("#fileCheck").classList.toggle("ready", Boolean(state.upload));
  $("#fileCheck .check-state").textContent = state.upload ? "已就绪" : "待上传";
  $("#fileCheckText").textContent = state.upload ? `${state.upload.terms.length} 个核心词待处理` : "等待上传 .xlsx 文件";
}

function renderUpload(upload) {
  state.upload = upload;
  if (!upload) return renderReadiness();
  $("#fileSummary").classList.remove("hidden");
  $("#termPreview").classList.remove("hidden");
  $("#fileName").textContent = upload.name;
  $("#fileMeta").textContent = `${formatBytes(upload.size)} · ${upload.sheetName} · ${upload.header}`;
  $("#termChips").innerHTML = upload.terms.slice(0, 20).map(term => `<span class="term-chip">${escapeHtml(term)}</span>`).join("") + (upload.terms.length > 20 ? `<span class="term-chip">+${upload.terms.length - 20}</span>` : "");
  $("#dropTitle").textContent = "更换选品表格";
  $("#dropHint").textContent = "拖入新文件会替换本次待处理列表";
  renderReadiness();
}

function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }

async function uploadFile(file) {
  if (!file || !/\.xlsx$/i.test(file.name)) return toast("请选择 .xlsx 格式的 Excel 文件");
  const zone = $("#dropZone");
  zone.classList.add("uploading");
  $("#dropTitle").textContent = "正在识别关键词列…";
  try {
    const response = await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    renderUpload(payload.upload);
    toast(`已识别 ${payload.upload.terms.length} 个核心词`);
  } catch (error) {
    $("#dropTitle").textContent = "拖入选品表格";
    toast(error.message || "文件读取失败");
  } finally { zone.classList.remove("uploading"); }
}

function stageIndex(stage) { return ({ queued: 0, business: 1, compass: 2, export: 3, done: 3, failed: 1 })[stage] ?? 0; }

function renderJob(job) {
  if (!job) return;
  state.job = job;
  const index = stageIndex(job.stage);
  const steps = [...document.querySelectorAll(".rail-step")];
  steps.forEach((step, i) => { step.classList.toggle("active", i === index && job.status !== "completed"); step.classList.toggle("done", i <= index && job.status === "completed" || i < index); });
  $("#railProgress").style.width = `${Math.min(100, index / 3 * 100)}%`;
  $("#runDetail").classList.remove("hidden");
  $("#activeTerm").textContent = job.activeTerm || (job.status === "completed" ? "全部完成" : "准备中");
  $("#businessCount").textContent = job.counts.business;
  $("#compassCount").textContent = job.counts.compass;
  $("#unprocessedCount").textContent = job.counts.unprocessed;
  const logBox = $("#logBox");
  logBox.innerHTML = job.logs.slice(-60).map(log => `<div class="log-line">${escapeHtml(log.message)}</div>`).join("");
  logBox.scrollTop = logBox.scrollHeight;
  const copy = {
    queued: ["任务已排队", "正在初始化浏览器采集环境。"],
    business: ["正在采集商机词", `${job.activeTerm || "准备中"} · 当前第 ${job.progress.page || 1} 页`],
    compass: ["正在联动抖音罗盘", `${job.activeTerm || "准备中"} · 匹配行业类目与搜索词分析`],
    export: ["正在生成结果", "整理三张工作表并导出 Excel。"],
    done: ["采集完成", `已获得 ${job.counts.business} 条商机词、${job.counts.compass} 条罗盘搜索词。`],
    failed: ["任务未完成", job.error || "请查看运行日志。"],
  }[job.stage] || ["等待开始", "上传表格并确认 Edge 已连接后即可运行。"];
  $("#pipelineTitle").textContent = copy[0]; $("#pipelineDesc").textContent = copy[1];
  $("#downloadButton").classList.toggle("hidden", job.status !== "completed");
  if (job.status === "completed") $("#downloadButton").href = `/api/jobs/${job.id}/download`;
  renderReadiness();
}

async function pollJob(id) {
  clearTimeout(state.pollTimer);
  try {
    const response = await fetch(`/api/jobs/${id}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    renderJob(payload.job);
    if (["queued", "running"].includes(payload.job.status)) state.pollTimer = setTimeout(() => pollJob(id), 1200);
    else if (payload.job.status === "completed") { toast("采集结果已生成"); await loadStatus(false); }
  } catch (error) { toast(error.message); }
}

async function startJob() {
  $("#startButton").disabled = true;
  try {
    if (!state.edge) {
      const edgeResponse = await fetch("/api/edge/ensure", { method: "POST" });
      const edgePayload = await edgeResponse.json();
      if (!edgeResponse.ok) throw new Error(edgePayload.error);
      state.edge = edgePayload.edge.connected;
      renderReadiness();
      toast(edgePayload.message);
      return;
    }
    const response = await fetch("/api/jobs", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    renderJob(payload.job);
    pollJob(payload.job.id);
  } catch (error) { toast(error.message || "任务启动失败"); renderReadiness(); }
}

function renderResults(results = []) {
  const list = $("#resultList");
  if (!results.length) { list.innerHTML = '<div class="empty-row">暂无结果文件</div>'; return; }
  list.innerHTML = results.map(item => `<div class="result-row"><span class="result-file-icon">XL</span><div><strong>${escapeHtml(item.name)}</strong><small>${formatDate(item.modifiedAt)}</small></div><span class="result-size">${formatBytes(item.size)}</span><a class="result-link" href="/api/results/${encodeURIComponent(item.name)}">下载</a></div>`).join("");
}

async function loadStatus(restoreJob = true) {
  try {
    const response = await fetch("/api/status");
    const payload = await response.json();
    state.edge = payload.edge.connected;
    if (payload.upload) renderUpload(payload.upload);
    renderResults(payload.results);
    if (restoreJob && payload.latestJob) { renderJob(payload.latestJob); if (["queued", "running"].includes(payload.latestJob.status)) pollJob(payload.latestJob.id); }
    renderReadiness();
  } catch { state.edge = false; renderReadiness(); }
}

const dropZone = $("#dropZone");
dropZone.addEventListener("click", event => { if (event.target !== $("#fileInput")) $("#fileInput").click(); });
dropZone.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); $("#fileInput").click(); } });
$("#chooseButton").addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); $("#fileInput").click(); });
$("#fileInput").addEventListener("change", event => uploadFile(event.target.files[0]));
["dragenter", "dragover"].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add("dragging"); }));
["dragleave", "drop"].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove("dragging"); }));
dropZone.addEventListener("drop", event => uploadFile(event.dataTransfer.files[0]));
$("#startButton").addEventListener("click", startJob);
updateClock(); setInterval(updateClock, 30000); loadStatus(); setInterval(() => { if (!["queued", "running"].includes(state.job?.status)) loadStatus(false); }, 7000);
