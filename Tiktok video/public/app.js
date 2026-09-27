'use strict';

const $ = (id) => document.getElementById(id);
let token = '';
let options = null;
let tasks = [];
let selectedId = null;
let eventSource = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function api(url, init = {}) {
  if (!token) token = (await (await fetch('/api/session')).json()).token;
  const response = await fetch(url, { ...init, headers: { 'X-Video-Token': token, ...(init.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '请求失败');
  return data;
}

function showNotice(text, error = false) {
  $('edgeStatus').textContent = text;
  $('edgeStatus').classList.toggle('error', error);
}

function appendLog(line) {
  if ($('logs').textContent === '任务日志会显示在这里。') $('logs').textContent = '';
  $('logs').textContent += `${$('logs').textContent ? '\n' : ''}${line}`;
  $('logs').scrollTop = $('logs').scrollHeight;
}

async function openEdge() {
  $('checkEdge').disabled = true;
  showNotice('正在打开商机中心并进入短视频榜...');
  try {
    const state = await api('/api/edge-open', { method: 'POST' });
    showNotice(state.ok ? '调试版 Edge 已进入短视频榜。' : state.message, !state.ok && !state.needLogin);
  } catch (error) { showNotice(error.message, true); }
  finally { $('checkEdge').disabled = false; }
}

function renderRadio(target, name, values) {
  $(target).innerHTML = values.map((item, index) => `<label><input type="radio" name="${name}" value="${escapeHtml(item)}" ${index === 0 ? 'checked' : ''}>${escapeHtml(item)}</label>`).join('');
}

function renderCategories(query = '') {
  const select = $('category');
  const old = select.value;
  const matches = (options?.categories || []).filter((item) => item.toLowerCase().includes(query.trim().toLowerCase()));
  select.innerHTML = matches.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  const current = (options?.currentCategory || '').replace(/ \/ 全部$/, '');
  select.value = matches.includes(old) ? old : matches.includes(current) ? current : matches[0] || '';
  select.disabled = !matches.length;
  updateStartButton();
}

function updateStartButton() { $('startTask').disabled = !options || !$('category').value || tasks.some((task) => task.status === 'running' || task.status === 'paused'); }

async function loadOptions() {
  $('loadOptions').disabled = true;
  showNotice('正在打开短视频榜并读取页面类目与周期...');
  try {
    const edge = await api('/api/edge-open', { method: 'POST' });
    if (!edge.ok) throw new Error(edge.message);
    options = await api('/api/options');
    renderCategories($('categorySearch').value);
    $('categorySearch').disabled = false;
    renderRadio('brands', 'brand', options.brandTypes);
    renderRadio('periods', 'period', options.periods.map((item) => item.label));
    showNotice(`已读取 ${options.categories.length} 个类目、${options.periods.length} 个可用周期。`);
  } catch (error) { showNotice(error.message, true); }
  finally { $('loadOptions').disabled = false; updateStartButton(); }
}

async function startTask() {
  const parameters = { category: $('category').value,
    brandType: document.querySelector('input[name=brand]:checked')?.value,
    period: document.querySelector('input[name=period]:checked')?.value,
    trendMode: document.querySelector('input[name=trend]:checked')?.value };
  try {
    const data = await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parameters) });
    selectedId = data.task.id;
    await refresh();
  } catch (error) { showNotice(error.message, true); }
}

function renderTask(task) {
  const statusNames = { queued: '排队中', running: '运行中', paused: '已暂停', stopped: '已停止', completed: '已完成', failed: '失败' };
  if (!task) {
    $('taskStatus').textContent = '当前没有任务。';
    for (const id of ['scanned', 'eligible', 'saved', 'failed', 'duplicatesSkipped', 'captionFailed']) $(id).textContent = '0';
    for (const id of ['pauseTask', 'resumeTask', 'stopTask']) $(id).disabled = true;
    return;
  }
  $('taskStatus').textContent = task.status === 'completed'
    ? `已完成 · 扫描 ${task.progress.scanned} 名 · 输出：${task.outputDirectory}`
    : `${statusNames[task.status] || task.status} · 第 ${task.progress.currentRank || '-'} 名 · ${task.progress.currentProduct || task.parameters.category}${task.progress.currentVideo ? ` · 视频 ${task.progress.currentVideo}` : ''}`;
  $('scanned').textContent = task.progress.scanned;
  $('eligible').textContent = task.progress.eligible;
  $('saved').textContent = task.progress.videosSaved;
  $('failed').textContent = task.progress.videoFailures;
  $('duplicatesSkipped').textContent = task.progress.duplicatesSkipped || 0;
  $('captionFailed').textContent = task.progress.captionFailures || 0;
  $('pauseTask').disabled = task.status !== 'running';
  $('resumeTask').disabled = !['paused', 'stopped', 'failed'].includes(task.status) &&
    !(task.status === 'completed' && Object.keys(task.checkpoint.failedVideos || {}).length);
  $('stopTask').disabled = !['running', 'paused'].includes(task.status);
}

async function showTask(id) {
  selectedId = id;
  const data = await api(`/api/tasks/${encodeURIComponent(id)}`);
  renderTask(data.task);
  $('logs').textContent = data.task.logs.map((entry) => `${new Date(entry.at).toLocaleTimeString()} ${entry.line}`).join('\n') || '任务日志会显示在这里。';
  $('logs').scrollTop = $('logs').scrollHeight;
  document.querySelectorAll('.task-item').forEach((item) => item.classList.toggle('selected', item.dataset.id === id));
}

function renderTaskList() {
  $('taskList').innerHTML = tasks.map((task) => `<div class="task-item ${task.id === selectedId ? 'selected' : ''}" data-id="${escapeHtml(task.id)}" role="button" tabindex="0"><div><strong>${escapeHtml(task.parameters.category)}</strong><small>${escapeHtml(task.parameters.brandType)} · ${escapeHtml(task.parameters.period)} · ${new Date(task.createdAt).toLocaleString()}</small></div><span class="badge">${escapeHtml(task.status)}</span></div>`).join('') || '<span class="muted">暂无任务。</span>';
  $('taskList').querySelectorAll('.task-item').forEach((item) => {
    item.onclick = () => showTask(item.dataset.id).catch((error) => appendLog(error.message));
    item.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); } };
  });
}

async function refresh() {
  try {
    tasks = (await api('/api/tasks')).tasks;
    if (!selectedId && tasks.length) selectedId = tasks[0].id;
    renderTaskList();
    if (selectedId) await showTask(selectedId);
    else renderTask(null);
    updateStartButton();
  } catch (error) { appendLog(`状态刷新失败：${error.message}`); }
}

async function act(action) {
  if (!selectedId) return;
  try { await api(`/api/tasks/${encodeURIComponent(selectedId)}/${action}`, { method: 'POST' }); await refresh(); }
  catch (error) { appendLog(error.message); }
}

function connectEvents() {
  if (!token || eventSource) return;
  eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  eventSource.addEventListener('status', refresh);
  eventSource.addEventListener('log', (event) => {
    const data = JSON.parse(event.data);
    if (tasks.find((task) => task.id === selectedId)?.status === 'running') appendLog(`${new Date(data.at).toLocaleTimeString()} ${data.line}`);
  });
}

$('checkEdge').onclick = openEdge;
$('loadOptions').onclick = loadOptions;
$('startTask').onclick = startTask;
$('pauseTask').onclick = () => act('pause');
$('resumeTask').onclick = () => act('resume');
$('stopTask').onclick = () => act('stop');
$('categorySearch').oninput = (event) => renderCategories(event.target.value);
$('category').onchange = updateStartButton;
openEdge().then(connectEvents);
refresh();
setInterval(refresh, 4000);
