'use strict';
const $ = id => document.getElementById(id);
const selected = new Set();
let state, busy = false, stoppedService = false, activeGroup = 0, activeView = 'preview', shownTask;
const labels = { success: '保存成功', unchanged: '已是目标', failed: '保存失败', uncertain: '待核对', stopped: '已停止', saving: '保存中', pending: '待保存', unmodified: '未修改' };
const taskLabels = { running: '执行中', complete: '已完成', failed: '已停止', stopped: '已停止' };
const element = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };

function controls() {
  const running = state?.task?.status === 'running';
  const ready = !busy && !stoppedService && !running && state?.phase === 'ready' && selected.size && state?.input?.titleCount && !state?.inputError;
  $('selected').textContent = `${selected.size} / ${state?.shops.length || 0}`;
  $('selected').setAttribute('aria-label', `已选择 ${selected.size} 家店铺，共 ${state?.shops.length || 0} 家`);
  $('start').disabled = !ready;
  $('start').querySelector('span').textContent = running ? '正在执行' : state?.task ? '再次开始修改' : '开始修改标题';
  $('stop').disabled = busy || stoppedService || !running;
  $('stop').hidden = !running;
  for (const id of ['refresh', 'all', 'none']) $(id).disabled = busy || stoppedService || running || state?.phase !== 'ready';
  $('refresh').disabled = busy || stoppedService || running || state?.phase === 'connecting';
  $('connect').hidden = ['ready', 'waiting-login'].includes(state?.phase);
  $('connect').disabled = busy || stoppedService || running || state?.phase === 'connecting';
  $('connect').textContent = state?.phase === 'connecting' ? '正在连接…' : state?.phase === 'error' ? '重新连接 Edge' : '连接 Edge';
  $('shops').querySelectorAll('input').forEach(input => { input.disabled = running || busy || stoppedService; input.checked = selected.has(input.value); });
  const scope = running ? state.task.shops.length : selected.size;
  $('run-heading').textContent = stoppedService ? '工作台服务已退出' : running ? `正在处理 ${scope} 家店铺的商品` : state?.inputError ? '请先修正标题表格' : state?.phase === 'disconnected' ? '先点击“连接 Edge”' : state?.phase !== 'ready' ? '等待浏览器连接或登录' : selected.size ? `已选择 ${scope} 家店铺，可以开始` : '先选择要修改的店铺';
  $('run-note').textContent = stoppedService ? '重新运行启动脚本后继续' : running ? `已成功保存 ${state.task.saved} 件，正在逐件处理` : ready ? `依次处理全部 ${state.input.groups.length} 组 · ${state.input.titleCount} 个新标题` : '核对标题后，再开始任务';
  $('run-indicator').className = `run-indicator ${running ? 'running' : ready ? 'ready' : ''}`;
}

function selectGroup(index, focus = false) {
  activeGroup = index;
  $('group-tabs').querySelectorAll('[role="tab"]').forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    if (focus && i === index) tab.focus();
  });
  $('groups').querySelectorAll('[role="tabpanel"]').forEach((panel, i) => { panel.hidden = i !== index; });
}

function selectView(view, focus = false) {
  activeView = view;
  for (const name of ['preview', 'results']) {
    $(`${name}-view`).hidden = name !== view;
    const tab = $(`${name}-tab`);
    tab.setAttribute('aria-selected', String(name === view));
    tab.tabIndex = name === view ? 0 : -1;
    if (focus && name === view) tab.focus();
  }
}

function renderInput() {
  $('input-error').textContent = state.inputError;
  $('input-file-name').textContent = state.input?.fileName || '标题.xls / 标题.xlsx';
  $('file-read-state').textContent = state.input ? '已读取' : state.inputError ? '未读取' : '读取中';
  $('file-read-state').className = `file-read-state ${state.inputError ? 'error' : ''}`;
  $('group-total').textContent = `${state.input?.groups.length || 0} 组`;
  $('preview-empty').hidden = !!state.input?.groups.length;
  $('input-summary').textContent = state.input ? `${state.input.groups.length} 组原标题 · ${state.input.titleCount} 个新标题` : '输入文件无法读取';
  const key = JSON.stringify(state.input);
  if ($('groups').dataset.key !== key) {
    $('groups').replaceChildren(); $('group-tabs').replaceChildren();
    const groups = state.input?.groups || [];
    groups.forEach((group, index) => {
      const tab = element('button', '', 'group-tab');
      tab.id = `group-tab-${index}`; tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `group-panel-${index}`);
      const label = element('span', '', 'group-tab-copy');
      label.append(element('strong', `第 ${index + 1} 组`), element('span', group.original, 'group-tab-title'), element('small', `${group.titles.length} 个新标题`));
      tab.append(element('span', String(index + 1).padStart(2, '0'), 'group-number'), label);
      tab.title = group.original;
      tab.onclick = () => selectGroup(index);
      tab.onkeydown = event => {
        let next;
        if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % groups.length;
        if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index + groups.length - 1) % groups.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = groups.length - 1;
        if (next !== undefined) { event.preventDefault(); selectGroup(next, true); }
      };
      $('group-tabs').append(tab);
      const panel = element('div', '', 'title-group'); panel.id = `group-panel-${index}`;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
      const original = element('div', '', 'original-box');
      original.append(element('div', '原标题 / 查询关键词', 'field-label'), element('p', group.original, 'original-title'));
      const heading = element('div', '', 'new-title-heading');
      heading.append(element('h3', '替换为以下新标题'), element('span', `${group.titles.length} 个 · 按顺序分配`));
      const list = element('ol', '', 'title-list');
      group.titles.forEach((title, i) => {
        const row = element('li', '', 'title-row'), copy = element('div', '', 'title-copy');
        row.append(element('span', String(i + 1).padStart(2, '0'), 'title-order'));
        copy.append(element('p', title));
        if (group.rows[i]) copy.append(element('span', `表格第 ${group.rows[i]} 行`, 'title-source'));
        row.append(copy); list.append(row);
      });
      panel.append(original, heading, list); $('groups').append(panel);
    });
    selectGroup(Math.min(activeGroup, Math.max(0, groups.length - 1)));
    $('groups').dataset.key = key;
  }
  const skipped = state.input?.skipped || [];
  $('skipped-details').hidden = !skipped.length;
  $('skipped-summary').textContent = `${skipped.length} 行已跳过，查看原因`;
  $('skipped').replaceChildren(...skipped.map(s => element('p', `第 ${s.row} 行：${s.reason}`)));
}

function facts(container, values) {
  const list = element('dl', '', 'stop-facts');
  values.forEach(([label, value]) => { list.append(element('dt', label), element('dd', value ?? '—')); });
  container.append(list);
}

function renderResults(task) {
  $('result-empty').hidden = !!task;
  $('result-content').hidden = !task;
  $('task-badge').textContent = taskLabels[task?.status] || '未开始';
  $('task-badge').className = `badge ${task?.status || ''}`;
  $('download').hidden = !task;
  const failureCount = task?.items.filter(item => ['failed', 'uncertain'].includes(item.status)).length || 0;
  $('download-failures').hidden = !failureCount;
  $('result-tab-count').hidden = !task;
  $('result-tab-count').textContent = task?.saved || 0;
  if (!task) return;
  const groupIndex = Math.max(0, task.groups.length - 1);
  const current = task.groups[groupIndex];
  $('task-message').textContent = task.status === 'running' ? `${current?.status === 'querying' ? '正在查询商品' : '正在保存标题'} · 第 ${groupIndex + 1} / ${state.input?.groups.length || task.groups.length} 组` : task.status === 'complete' ? `全部分组已处理完成${failureCount ? `，${failureCount} 件失败已记录` : ''}` : '任务已停止，已成功的修改保留';
  $('task-message').title = task.message;
  $('scope').textContent = `本次店铺：${task.shops.map(s => s.name).join('、')}`;
  $('saved-count').textContent = task.saved;
  $('failed-count').textContent = task.items.filter(item => ['failed', 'uncertain'].includes(item.status)).length;
  $('remaining-count').textContent = task.items.filter(item => ['pending', 'saving'].includes(item.status)).length;
  const stop = task.stopPosition;
  const stopKey = JSON.stringify(stop);
  if ($('stop-position').dataset.key !== stopKey) {
    $('stop-position').hidden = !stop;
    $('stop-position').replaceChildren();
    if (stop) {
      $('stop-position').append(element('strong', stop.reason || task.message));
      facts($('stop-position'), [['原标题分组', stop.original], ['店铺 / 商品', stop.productId ? `${stop.shopName || ''} / ${stop.productId}` : '查询阶段'], ['目标新标题', stop.target]]);
    }
    $('stop-position').dataset.key = stopKey;
  }
  const groupsKey = JSON.stringify(task.groups);
  if ($('group-results').dataset.key !== groupsKey) {
    $('group-results').replaceChildren();
    task.groups.forEach((group, index) => {
      const block = element('div', '', 'group-result');
      block.append(element('strong', `第 ${index + 1} 组${group.status === 'no-match' ? ' · 无匹配商品' : ''}`));
      const original = element('p', group.original); original.title = group.original; block.append(original);
      const stats = element('div', '', 'group-stats');
      [['查询', group.productCount ?? '等待', '件'], ['保存', group.saved, '件'], ['失败跳过', group.failed || 0, '件'], ['未修改', group.unmodified ?? '待查询', '件'], ['未使用标题', group.unused, '个']].forEach(([label, value, unit]) => {
        const stat = element('span', `${label} `); stat.append(element('b', value), document.createTextNode(` ${unit}`)); stats.append(stat);
      });
      block.append(stats); $('group-results').append(block);
    });
    $('group-results').dataset.key = groupsKey;
  }
  const itemsKey = JSON.stringify(task.items);
  if ($('items').dataset.key === itemsKey) return;
  const openDetails = new Set([...$('items').querySelectorAll('.item-details[open]')].map(detail => detail.dataset.key));
  $('items').replaceChildren();
  for (const item of task.items) {
    const card = element('article', '', 'result-item');
    card.setAttribute('aria-label', `${item.shopName}，商品 ${item.id}，${labels[item.status] || item.status}`);
    const main = element('div', '', 'item-main');
    const status = element('div', ''); status.append(element('span', item.skipped ? '失败跳过' : labels[item.status] || item.status, `badge ${item.status}`));
    const shop = element('div', '', 'item-identity'); shop.append(element('strong', item.shopName), element('span', item.id, 'product-id'));
    const comparison = element('div', '', 'title-comparison');
    const before = element('div', '', 'before-title'); before.append(element('p', '修改前', 'comparison-label'), element('p', item.before, 'comparison-copy'));
    const after = element('div', '', 'after-title');
    const saved = ['success', 'unchanged'].includes(item.status);
    after.append(element('p', saved ? '修改后' : item.target ? '目标新标题' : '保持原标题', 'comparison-label'), element('p', saved ? item.after : item.target || item.before, 'comparison-copy'));
    comparison.append(before, after); main.append(status, shop, comparison); card.append(main);
    if (['failed', 'uncertain', 'stopped', 'unmodified'].includes(item.status) && item.reason) card.append(element('p', item.reason, 'item-reason'));
    const detail = element('details', '', 'item-details'); detail.dataset.key = `${item.shopId}:${item.id}:${item.original}`;
    detail.open = openDetails.has(detail.dataset.key);
    detail.append(element('summary', '查看详情'));
    facts(detail, [['查询词', item.original], ['保存后标题', item.after], ['处理说明', item.reason || '等待执行'], ['保存尝试', `${item.attempts} 次`], ['表格位置', item.excelRow ? `第 ${item.excelRow} 行` : '未分配新标题']]);
    card.append(detail); $('items').append(card);
  }
  if (!task.items.length) $('items').append(element('p', task.status === 'running' ? '正在等待查询结果…' : '本次没有可修改的商品', 'muted-empty'));
  $('items').dataset.key = itemsKey;
}

function render(next) {
  state = next;
  if (state.task?.status === 'running') {
    selected.clear();
    state.task.shops.forEach(shop => selected.add(shop.id));
  }
  const available = new Set(state.shops.map(s => s.id));
  for (const id of selected) if (!available.has(id)) selected.delete(id);
  $('connection').textContent = state.phase === 'ready' ? '浏览器已连接' : state.phase === 'waiting-login' ? '等待登录' : state.phase === 'error' ? '连接异常' : state.phase === 'disconnected' ? '未连接' : '正在连接';
  $('connection').title = state.message;
  $('connection').className = `connection ${state.phase}`;
  $('connection-help').hidden = ['ready', 'connecting'].includes(state.phase);
  $('connection-help').textContent = state.message;
  const shopKey = JSON.stringify(state.shops);
  if ($('shops').dataset.key !== shopKey) {
    $('shops').replaceChildren();
    for (const shop of state.shops) {
      const label = element('label', '', 'shop-option'); const input = document.createElement('input');
      input.type = 'checkbox'; input.value = shop.id; input.checked = selected.has(shop.id);
      input.addEventListener('change', () => { if (input.checked) selected.add(shop.id); else selected.delete(shop.id); controls(); });
      label.append(input, element('span', shop.name)); $('shops').append(label);
    }
    $('shops').dataset.key = shopKey;
  }
  $('shops-empty').hidden = !!state.shops.length;
  renderInput();
  renderResults(state.task);
  const taskKey = state.task?.startedAt || (state.task ? 'current' : null);
  if (taskKey && taskKey !== shownTask) selectView('results');
  shownTask = taskKey;
  if (state.reportError) showNotice(state.reportError);
  controls();
}

function showNotice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
async function post(url, body = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function action(work) {
  busy = true; controls(); showNotice('');
  try { await work(); await poll(); } catch (error) { showNotice(error.message); }
  finally { busy = false; controls(); }
}
async function poll() {
  if (stoppedService) return;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('服务不可用');
    render(await response.json());
  } catch {
    stoppedService = true; $('connection').textContent = '服务已退出'; $('connection').className = 'connection error';
    $('connection-help').hidden = false; $('connection-help').textContent = '工作台服务已退出，请重新运行启动脚本。'; controls();
  }
}
$('all').onclick = () => { state.shops.forEach(s => selected.add(s.id)); controls(); };
$('none').onclick = () => { selected.clear(); controls(); };
for (const name of ['preview', 'results']) {
  $(`${name}-tab`).onclick = () => selectView(name);
  $(`${name}-tab`).onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      selectView(event.key === 'Home' ? 'preview' : event.key === 'End' ? 'results' : activeView === 'preview' ? 'results' : 'preview', true);
    }
  };
}
$('refresh').onclick = () => action(async () => { render(await post('/api/refresh')); });
$('connect').onclick = () => action(async () => { render(await post('/api/connect')); });
$('start').onclick = () => action(async () => { await post('/api/start', { shopIds: [...selected] }); });
$('stop').onclick = () => action(async () => { const result = await post('/api/stop'); showNotice(result.message); });
$('exit').onclick = async () => {
  try { await post('/api/shutdown'); } catch (error) { showNotice(error.message); }
  stoppedService = true; $('connection').textContent = '工作台已退出'; controls();
};
void poll();
setInterval(poll, 1000);
