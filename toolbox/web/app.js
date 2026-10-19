"use strict";
const $ = (selector) => document.querySelector(selector);
const labels = {
  queued: "排队中",
  running: "执行中",
  pausing: "正在暂停",
  paused: "已暂停",
  waiting_user: "等待处理",
  stopping: "正在停止",
  cancelled: "已停止",
  interrupted: "意外中断",
  failed: "任务失败",
  completed_with_errors: "部分失败",
  completed: "已完成",
  pending: "待处理", saving: "提交中 · 待核对", success: "保存成功",
  uncertain: "结果待核对", unchanged: "无需修改", unmodified: "未修改",
};
const state = {
  view: "tasks",
  tools: [],
  offset: 0,
  seq: 0,
  options: {},
  selected: new Set(),
  captureOffset: 0,
  captureQuery: "",
  captureText: "",
  captureOperations: new Map(),
  task: null,
  artifactOffset: 0,
  resultOffset: 0,
  resultSection: 'results',
  files: new Set(),
  titleInput: null,
  titleShops: new Set(),
  titleStatus: '',
  titlePlan: null,
  titleOperation: null,
  titleOffset: 0,
};
const content = $("#content");
let costView = null;
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, fn, className) {
  const node = el("button", text, className);
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await fn();
    } catch (error) {
      notice(error.message, true);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}
function notice(text, error = false) {
  const box = $("#notice");
  box.textContent = text;
  box.className = error ? "error" : "";
  box.hidden = !text;
}
async function call(action, payload = {}) {
  const result = await window.pywebview.api.invoke(action, payload);
  if (!result.ok) { const error = Error(result.error.message); error.code = result.error.code; throw error; }
  return result.data;
}
const toolName = (id) => state.tools.find((t) => t.toolId === id)?.name || id;
function progressText(toolId, progress = {}) {
  if (progress.message) return progress.message;
  if (toolId !== 'video-ranking') return '';
  const text = `扫描 ${progress.scanned ?? 0} 件 · 符合条件 ${progress.eligible ?? 0} 件 · 新视频 ${progress.videosSaved ?? 0} 条 · 重复引用 ${progress.duplicatesSkipped ?? 0} 条 · 视频失败 ${progress.videoFailures ?? 0} 条 · 文案缺失 ${progress.captionFailures ?? 0} 条`;
  const current = [progress.currentRank ? `第 ${progress.currentRank} 名` : '', progress.currentProduct || '',
    progress.currentVideo ? `第 ${progress.currentVideo} 条视频` : ''].filter(Boolean).join(' · ');
  return current ? `${text}；当前：${current}` : text;
}
function bytes(value) {
  return value < 1024 * 1024
    ? (value / 1024).toFixed(1) + " KB"
    : value < 1024 ** 3
      ? (value / 1024 ** 2).toFixed(1) + " MB"
      : (value / 1024 ** 3).toFixed(2) + " GB";
}
function time(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function pager(total, offset, limit, change) {
  const row = el("div", undefined, "pager");
  const previous = button("上一页", () => change(Math.max(0, offset - limit)));
  previous.disabled = offset === 0;
  const next = button("下一页", () => change(offset + limit));
  next.disabled = offset + limit >= total;
  row.append(
    el("span", `共 ${total} 条 · 第 ${Math.floor(offset / limit) + 1} 页`),
    previous,
    next,
  );
  return row;
}
function panel(title) {
  const box = el("section", undefined, "panel");
  if (title) box.append(el("h2", title));
  return box;
}
function empty(title, text) {
  const box = el("div", undefined, "empty");
  box.append(el("h2", title), el("p", text));
  return box;
}
async function navigate(view) {
  state.view = view;
  state.offset = 0;
  notice("");
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const tool = state.tools.find((t) => t.toolId === view);
  $("#section-label").textContent = tool ? "工具" : "工作记录";
  $("#title").textContent =
    tool?.name || { tasks: "任务中心", storage: "存储管理" }[view];
  $("#subtitle").textContent = {
    tasks: "采集进度与历史结果，集中在这里。",
    storage: "查看本机占用，保留结果，清理可重建缓存。",
    "business-center": "按类目与成交金额筛选商机，生成可交付报告。",
    top200: "采集商品榜前 200 名，保留榜单变化与商品链接。",
    "video-ranking": "按趋势条件采集商品视频，视频与文案集中管理。",
    "manual-video": "读取当前页或粘贴分享链接，勾选后下载。",
    "product-title": "选择标题表格，核对具体商品的新旧标题后确认修改。",
    "cost-assistant": "导入成本目录，维护商品对应、基础服务费和运费模板。",
  }[view];
  await render();
}
async function render() {
  const isCost = state.view === 'cost-assistant';
  content.hidden = isCost;
  $('#cost-content').hidden = !isCost;
  if (isCost) {
    if (!costView) {
      costView = globalThis.ToolboxCostMount($('#cost-host'), async (action, parameters = {}) => {
        try {
          let data;
          if (action === 'choose_file') data = await call('cost.choose_file', parameters);
          else if (action === 'open_logs') data = await call('cost.open_logs');
          else data = await call('cost.invoke', {action, parameters});
          return {ok: true, result: data};
        } catch (error) { return {ok: false, error: error.message, uncertain: error.code === 'COST_RESULT_UNCERTAIN'}; }
      });
    } else costView.resume();
    return;
  }
  costView?.pause();
  if (state.view === "tasks") return tasks();
  if (state.view === "storage") return storage();
  if (state.view === "manual-video") return capture();
  if (state.view === "product-title") return titleWorkbench();
  return toolForm();
}
async function tasks() {
  const data = await call("tasks.list", { offset: state.offset, limit: 20 });
  if (state.view !== "tasks") return;
  content.replaceChildren();
  if (!data.total) {
    content.append(
      empty(
        "还没有任务",
        "从左侧选择工具，读取平台条件后开始。完成的结果会保留在任务记录中。",
      ),
    );
    return;
  }
  const box = panel();
  for (const task of data.items) {
    const row = el("div", undefined, "task-row");
    row.dataset.taskId = task.id;
    const name = el("div");
    name.append(
      el("h3", toolName(task.toolId)),
      el("small", time(task.createdAt)),
      el(
        "small",
        task.error?.message || progressText(task.toolId, task.progress) || "查看详情与结果",
      ),
    );
    const status = el("div");
    status.append(el("span", labels[task.state], `tag ${task.state}`));
    if (task.progress.total)
      status.append(
        el(
          "div",
          `${task.progress.current ?? 0} / ${task.progress.total}`,
          "task-progress",
        ),
      );
    const actions = el("div", undefined, "toolbar");
    actions.append(button("查看", () => taskDetail(task.id)));
    if (
      ["running", "pausing", "paused", "waiting_user", "queued"].includes(
        task.state,
      )
    )
      actions.append(
        button("停止", async () => {
          await call("tasks.control", { taskId: task.id, command: "cancel" });
          await tasks();
        }),
      );
    row.append(name, status, actions);
    box.append(row);
  }
  content.append(
    box,
    pager(data.total, state.offset, 20, async (offset) => {
      state.offset = offset;
      await tasks();
    }),
  );
}
async function taskDetail(taskId) {
  $("#dialog").dataset.kind = "task";
  if (state.task !== taskId) {
    state.artifactOffset = 0;
    state.resultOffset = 0;
    state.resultSection = 'results';
    state.files.clear();
  }
  state.task = taskId;
  const task = await call("tasks.get", { taskId });
  const box = $("#dialog-content");
  const header = el("div", undefined, "task-detail-header");
  const close = button("×", () => $("#dialog").close(), "task-detail-close quiet");
  close.setAttribute("aria-label", "关闭任务详情");
  header.append(el("h2", toolName(task.toolId)), close);
  box.replaceChildren(
    header,
    el("p", `${labels[task.state]} · ${time(task.createdAt)}`, "detail-status"),
  );
  const progress = el("p", progressText(task.toolId, task.progress), "hint detail-progress");
  progress.dataset.toolId = task.toolId;
  box.append(progress);
  if (task.state === "waiting_user") box.append(el("p", "请在受管浏览器完成登录或验证，然后点击“继续”。等待期间该任务保留浏览器使用权。", "hint"));
  if (task.toolId === 'product-title') box.append(el('p', '标题任务不自动继续或重试。若商品显示“结果待核对”，请先在平台核对；已成功保存的标题不会回滚。停止时当前提交最多需要约一分钟核对。', 'hint'));
  const actions = el("div", undefined, "toolbar");
  const caps = task.capabilities;
  for (const [command, text, enabled] of [
    ["pause", "暂停", task.state === "running" && caps.supportsPause],
    [
      "resume",
      "继续",
      ["paused", "waiting_user"].includes(task.state) ||
        (["interrupted", "cancelled", "failed"].includes(task.state) &&
          caps.supportsResume),
    ],
    [
      "retry_failed",
      "重试异常项",
      ["failed", "completed_with_errors"].includes(task.state) &&
        caps.supportsRetryFailed,
    ],
  ])
    if (enabled)
      actions.append(
        button(text, async () => {
          await call("tasks.control", { taskId, command });
          await taskDetail(taskId);
        }),
      );
  actions.append(
    button("查看日志", () => logPage(taskId, 0)),
    button("删除任务", () => deleteTask(taskId), "danger"),
  );
  box.append(el("div", undefined, "divider"), actions);
  if (task.error) box.append(el("p", task.error.message, "hint"));
  const files = el("section"); files.id = "detail-files";
  const results = el("section"); results.id = "detail-results";
  const logs = el("section"); logs.id = "detail-logs";
  box.append(files, results, logs);
  await artifactPage(taskId, state.artifactOffset);
  state.detailTool = task.toolId;
  await resultPage(taskId, state.resultOffset);
  if (!$("#dialog").open) $("#dialog").showModal();
}
async function exportFiles(taskId, artifactIds) {
  const result = await call("artifacts.export", {taskId, artifactIds});
  notice(result.cancelled ? "已取消导出。" : `已导出 ${result.exported} 项，跳过 ${result.skipped} 项，失败 ${result.failed} 项。`, result.failed > 0);
}
async function artifactPage(taskId, offset) {
  state.artifactOffset = offset;
  const data = await call("tasks.artifacts", {taskId, offset, limit:50});
  const box = $("#detail-files");
  box.replaceChildren(el("h3", `交付文件 · ${data.total} 个`));
  if (!data.total) return;
  const controls = el("div", undefined, "toolbar");
  const selected = button("导出所选", () => exportFiles(taskId, [...state.files]));
  const count = el("small");
  const update = () => {selected.disabled = !state.files.size; count.textContent = `已选 ${state.files.size} 个（最多200个）`;};
  controls.append(button("选中本页", () => {for (const f of data.items) if(state.files.size < 200) state.files.add(f.id); return artifactPage(taskId, offset);}),
    button("清空选择", () => {state.files.clear(); return artifactPage(taskId, offset);}), selected, count);
  box.append(controls);
  for (const file of data.items) {
    const row = el("div", undefined, "artifact");
    const check = el("input"); check.type = "checkbox"; check.checked = state.files.has(file.id);
    check.setAttribute("aria-label", `选择 ${file.displayName}`);
    check.addEventListener("change", () => {if(check.checked && state.files.size >= 200) {check.checked=false;notice("每次最多导出200个文件。",true);return;} check.checked ? state.files.add(file.id) : state.files.delete(file.id); update();});
    const details = el("div");
    details.append(el("strong", file.displayName), el("small", `${file.metadata.productName || file.metadata.productGroup || "视频/报告"} · ${bytes(file.size)}`));
    if (file.metadata.caption) details.append(el("p", file.metadata.caption, "caption"));
    else if (file.metadata.sourceKind === "compass_ranking") details.append(el("p", "未读取到文案，可重试异常项补充", "hint"));
    row.append(check, details, button("打开", () => call("artifacts.open", {artifactId:file.id})), button("导出", () => exportFiles(taskId, [file.id])));
    box.append(row);
  }
  update();
  box.append(pager(data.total, offset, 50, n => artifactPage(taskId,n)));
}
async function logPage(taskId, afterSeq) {
  const logs = await call("tasks.logs", {taskId, afterSeq, limit:100});
  const box = $("#detail-logs");
  box.replaceChildren(el("h3", "任务日志"), el("pre", logs.items.map(i => `${time(i.at)} ${i.message}`).join("\n") || "暂无更多日志"));
  if (logs.items.length === 100) box.append(button("下一页日志", () => logPage(taskId, logs.nextSeq)));
  if (afterSeq) box.append(button("返回首屏日志", () => logPage(taskId,0)));
}
async function resultPage(taskId, offset) {
  state.resultOffset = offset;
  const result = await call("tasks.results", { taskId, offset, limit: 50, section:state.resultSection });
  const box = $("#detail-results");
  box.replaceChildren(
    el("h3", `业务结果 · ${result.total} 条`),
    resultTable(result.items),
    pager(result.total, offset, 50, (n) => resultPage(taskId, n)),
  );
  if (result.engine === 'business-python-v1') {
    box.prepend(el('p', `已检查 ${result.stats.checkedPages || 0} 页 · 列表范围${result.stats.listCoverageComplete ? '已覆盖' : '未完成'} · 失败 ${result.failures} 条 · 无法解析 ${result.unparseable} 条。昨日成交档位由今日金额与环比反推，非平台昨日原值。`, 'hint'));
  } else if (result.readOnly) {
    box.prepend(el('p', '这是旧版商机任务，结果和文件可查看、导出；请重新读取类目并创建 Python 采集任务。', 'hint'));
  }
  if(['business-center','top200'].includes(state.detailTool)) {
    const choices = el('div',undefined,'toolbar');
    const sections = [['results','正常结果'],['failures','失败记录']];
    if(state.detailTool === 'business-center') sections.push(['unparseableItems','无法解析']);
    for(const [key,name] of sections) choices.append(button(name, () => {state.resultSection=key;return resultPage(taskId,0);}, state.resultSection===key?'primary':''));
    box.prepend(choices);
  }
}
function resultTable(items) {
  if (!items.length) return el("p", "暂无结果，可稍后刷新。", "hint");
  const wrap = el("div", undefined, "table-wrap");
  const table = el("table");
  const names = {rank:"排名", trendText:"趋势", productName:"商品", keyword:"商机词", totalSales:"成交金额", yesterday:"昨日", today:"今日", growth:"增长", categoryPath:"类目", rankingType:"榜单", actualPeriod:"实际周期", priceRange:"价格", productUrl:"商品链接", shopName:"店铺", title:"标题", status:"状态", sourceKind:"来源", caption:"文案", message:"说明", reason:"失败原因", error:"错误信息", stage:"处理阶段", page:"页码", attempts:"尝试次数", retries:"重试次数", at:"记录时间", downloadedVideos:"下载视频", failedVideos:"失败视频", matchedVideos:"命中视频"};
  if (items.some(item => item.yesterdaySource)) names.yesterday = '昨日（反推）';
  if (items.some(item => item.indicatorIdBinding)) names.growth = '今日环比';
  names.classification = '分类';
  Object.assign(names, {productId:'商品 ID', before:'修改前标题', target:'目标新标题', excelRow:'表格行号'});
  const columns = Object.keys(names).filter(key => items.some(item => key in item));
  if (!columns.length) return el("p", "结果已保存，详情可查看交付文件和任务日志。", "hint");
  const head = el("tr");
  columns.forEach((key) => head.append(el("th", names[key])));
  table.append(head);
  for (const item of items) {
    const row = el("tr");
    for (const key of columns) {
      const value = item[key];
      row.append(
        el(
          "td",
          value === null
            ? "—"
            : typeof value === "object"
              ? Array.isArray(value) ? value.join(" / ") : value.message || "—"
              : key === 'status' ? labels[value] || value : String(value ?? ""),
        ),
      );
    }
    table.append(row);
  }
  wrap.append(table);
  return wrap;
}
async function deleteTask(taskId) {
  const preview = await call("storage.preview_delete", { taskIds: [taskId] });
  if (
    !window.confirm(
      `删除此任务及其结果引用？预计释放 ${bytes(preview.releasableBytes)}，仍被其他任务使用的 ${preview.sharedFiles} 个文件会保留。`,
    )
  )
    return;
  await call("storage.confirm_delete", { token: preview.token });
  $("#dialog").close();
  await render();
  notice("任务已删除。");
}
function field(title, input, full = false) {
  const box = el("div", undefined, "field" + (full ? " full" : ""));
  const label = el("label", title);
  label.append(input);
  box.append(label);
  return box;
}
function select(options, name) {
  const input = el("select");
  input.name = name;
  for (const value of options) {
    const option = el(
      "option",
      typeof value === "string"
        ? value
        : value.displayPath || value.name || value.label || value.text || value.id,
    );
    option.value = typeof value === "string" ? value : name === 'rankingTypes' ? value.name
      : name === 'period' ? value.label : name === 'trendMode' ? value.id : JSON.stringify(value);
    option.disabled = value.disabled === true;
    input.append(option);
  }
  return input;
}
function checklist(options, name) {
  const box = el("div", undefined, "choices");
  box.dataset.multiple = name;
  const search = el("input"); search.type="search"; search.placeholder="输入文字筛选";
  search.setAttribute("aria-label", name === "category" ? "筛选类目" : "筛选榜单");
  box.append(search);
  const list = el("div", undefined, "choice-list");
  for (const value of options) {
    const title = typeof value === "string" ? value : value.displayPath || value.name;
    const label = el("label", undefined, "check");
    const input = el("input"); input.type="checkbox";
    input.value = name === "rankingTypes" ? value.name : JSON.stringify(value);
    label.append(input, el("span", title)); list.append(label);
  }
  search.addEventListener("input", () => {for (const label of list.children) label.hidden = !label.textContent.toLowerCase().includes(search.value.toLowerCase());});
  const actions = el("div", undefined, "toolbar");
  actions.append(button("选择可见项", () => {for (const label of list.children) if(!label.hidden) label.firstChild.checked=true;}),
    button("清空", () => {for(const input of list.querySelectorAll("input")) input.checked=false;}));
  box.append(actions,list);
  return box;
}
async function discover(toolId) {
  const { operationId } = await call("tools.discover", { toolId });
  state.options[toolId] = { operationId };
  notice("已加入读取队列，请在受管浏览器完成登录。");
}
function invalidateTitlePlan() {
  state.titlePlan = null;
  state.titleOffset = 0;
  $('#title-plan')?.replaceChildren(el('p', '范围已变化，请重新预览商品修改。', 'hint'));
}
async function titleWorkbench() {
  content.replaceChildren();
  const importing = panel('1. 选择标题表格');
  const input = state.titleInput;
  const busy = Boolean(state.titleOperation);
  const choose = button(input ? '更换表格' : '选择 .xls / .xlsx 表格', async () => {
    const data = await call('title.choose_input');
    if (data.cancelled) return;
    state.titleInput = data;
    invalidateTitlePlan();
    if (state.view === 'product-title') await titleWorkbench();
  });
  choose.disabled = busy;
  importing.append(el('p', 'Sheet1 第一行为“原标题”和“新标题”。原标题留空时沿用上一组，新标题为空时跳过。表格正文不会改写。', 'hint'), choose);
  if (input) {
    importing.append(el('p', `${input.fileName} · ${input.groupCount} 组 · ${input.titleCount} 个新标题 · 跳过 ${input.skippedCount} 行`));
    const rows = (input.groups || []).flatMap(group => group.titles.map((title, i) => ({
      before: group.original, target: title, excelRow: group.rows[i]})));
    importing.append(resultTable(rows));
    if (input.previewTruncated) importing.append(el('p', '表格预览仅显示前 100 行；商品预览会处理完整表格。', 'hint'));
  }
  const scope = panel('2. 选择店铺与商品状态');
  const read = button('读取店铺和商品状态', async () => {
    invalidateTitlePlan();
    state.titleShops.clear();
    state.titleStatus = '';
    await discover('product-title');
    if (state.view === 'product-title') await titleWorkbench();
  });
  const options = state.options['product-title'];
  const discovering = options?.operationId && !options.result && !options.error;
  read.disabled = busy || Boolean(discovering);
  const scopeActions = el('div', undefined, 'toolbar');
  scopeActions.append(button('打开小猪 / 登录', () => call('browser.open', {source:'title-platform'})), read);
  scope.append(el('p', '需要在专用浏览器登录抖店和小猪。店铺默认不勾选；只查询所选范围。', 'hint'), scopeActions);
  if (discovering) scope.append(el('p', '正在排队读取店铺，请稍候…', 'hint'));
  if (options?.error) scope.append(el('p', options.error, 'hint'));
  const choices = options?.result;
  if (choices) {
    const shopSummary = el('p', undefined, 'hint title-shop-summary');
    const updateShopSummary = () => {shopSummary.textContent = `共 ${choices.shops.length} 家店铺 · 已选 ${choices.shops.filter(shop => state.titleShops.has(shop.id)).length} 家`;};
    updateShopSummary();
    const list = el('div', undefined, 'title-shops');
    list.setAttribute('role','group'); list.setAttribute('aria-label','店铺选择');
    for (const shop of choices.shops || []) {
      const label = el('label', undefined, 'check');
      const check = el('input'); check.type = 'checkbox'; check.checked = state.titleShops.has(shop.id); check.disabled = busy;
      check.addEventListener('change', () => {
        check.checked ? state.titleShops.add(shop.id) : state.titleShops.delete(shop.id);
        updateShopSummary();
        invalidateTitlePlan();
      });
      label.append(check, el('span', shop.name)); list.append(label);
    }
    const statuses = el('select'); statuses.disabled = busy;
    for (const status of choices.productStatuses || []) {
      const option = el('option', status.label); option.value = status.value; statuses.append(option);
    }
    if ([...statuses.options].some(option => option.value === state.titleStatus)) statuses.value = state.titleStatus;
    else state.titleStatus = statuses.value;
    statuses.addEventListener('change', () => {state.titleStatus = statuses.value; invalidateTitlePlan();});
    const statusField = field('商品状态', statuses);
    scope.append(shopSummary, list, statusField);
  }
  const preview = button('预览商品修改', async () => {
    if (!state.titleInput) throw Error('请先选择标题表格。');
    const shops = (choices?.shops || []).filter(shop => state.titleShops.has(shop.id));
    if (!shops.length) throw Error('请至少选择一家店铺。');
    const productStatus = choices.productStatuses.find(status => status.value === state.titleStatus);
    invalidateTitlePlan();
    const result = await call('title.preview', {inputId:state.titleInput.inputId, shops, productStatus});
    state.titleOperation = result.operationId;
    if (state.view === 'product-title') await titleWorkbench();
  }, 'primary');
  preview.disabled = busy || !input || !choices;
  const previewActions = el('div', undefined, 'toolbar title-preview-actions');
  previewActions.append(preview);
  scope.append(previewActions);
  const plan = panel('3. 核对商品的新旧标题'); plan.id = 'title-plan';
  content.append(importing, scope, plan);
  if (busy) {
    const loading = el('div', undefined, 'title-loading'); loading.setAttribute('role', 'status');
    loading.append(el('div', undefined, 'loading-spinner'), el('p', '正在排队或查询所选店铺，尚未修改商品。多组原标题可能需要几分钟。'));
    plan.append(loading, button('取消预览', async () => {
      await call('title.cancel_preview', {operationId:state.titleOperation});
      state.titleOperation = null;
      if (state.view === 'product-title') await titleWorkbench();
    }));
    return;
  }
  const approved = state.titlePlan;
  if (!approved) {plan.append(el('p', '先完成表格和范围选择，再预览具体商品。', 'hint')); return;}
  const summary = approved.summary;
  plan.append(el('p', `匹配 ${summary.productCount} 件 · 拟修改 ${summary.changeCount} 件 · 无需修改 ${summary.unchangedCount || 0} 件 · 标题不足保留 ${summary.unmodifiedCount || 0} 件 · 未使用新标题 ${summary.unusedCount || 0} 个`),
    el('p', '预览有效期 10 分钟。成功保存无法自动回滚；停止后会核对当前提交，随后结束。', 'hint'));
  const create = button('确认修改商品标题', async () => {
    const result = await call('title.create', {token:approved.token});
    if (result.cancelled) return;
    invalidateTitlePlan();
    await navigate('tasks');
    await taskDetail(result.taskId);
  }, 'primary');
  create.disabled = !summary.changeCount;
  plan.append(create);
  try {
    const data = await call('title.plan_page', {token:approved.token, offset:state.titleOffset, limit:50});
    if (state.view !== 'product-title' || state.titlePlan?.token !== approved.token) return;
    plan.append(resultTable(data.items), pager(data.total, state.titleOffset, 50, offset => {state.titleOffset = offset; return titleWorkbench();}));
  } catch (error) {
    create.disabled = true;
    plan.append(el('p', error.message, 'hint'));
  }
}
async function toolForm() {
  const tool = state.tools.find((t) => t.toolId === state.view);
  content.replaceChildren();
  if (!tool.available) {
    content.append(
      empty("此工具正在接入", "功能完成验收后开放。现有独立工具入口仍可使用。"),
    );
    return;
  }
  const box = panel("采集条件");
  box.append(
    el("p", "先读取平台当前可用条件，再创建任务。", "hint"),
    button("读取平台条件", () => discover(tool.toolId)),
  );
  const options = state.options[tool.toolId];
  if (options?.result) {
    const form = el("form");
    form.addEventListener("submit", (e) => e.preventDefault());
    const grid = el("div", undefined, "form-grid");
    const categories = options.result.categories || [];
    const category = tool.toolId === "video-ranking" ? select(categories, "category") : checklist(categories,"category");
    grid.append(
      field(
        tool.toolId === "video-ranking" ? "类目" : "勾选类目（可多选）",
        category,
        true,
      ),
    );
    if (tool.toolId === "business-center") {
      form.prepend(el('p', '使用 Python API 采集，支持一级至三级官方类目；三级采集包含其下属类目。任务可暂停、继续和停止，异常数据会单独记录。', 'hint'));
      for (const [name, title, value] of [
        ["minSales", "最低成交金额（元）", 10000],
        ["maxSales", "最高成交金额（元，留空不限）", ""],
      ]) {
        const input = el("input");
        input.type = "number";
        input.min = "0";
        input.name = name;
        input.value = value;
        grid.append(field(title, input));
      }
      const check = el("input");
      check.type = "checkbox";
      check.name = "only30dGrowth";
      const toggle = el("label", undefined, "check option-toggle");
      toggle.append(check, el("span", "仅看近 30 天增长"));
      grid.append(toggle);
    } else {
      grid.append(
        field(
          "品牌",
          select(options.result.brandTypes || [], "brandType"),
        ),
      );
      if (tool.toolId === "top200") {
        const rankings = checklist(
          options.result.rankingTypes || [],
          "rankingTypes",
        );
        grid.append(field("榜单（可多选）", rankings));
      } else {
        grid.append(
          field("周期", select(options.result.periods || [], "period")),
        );
        grid.append(
          field(
            "趋势",
            select(
              [
                { id: "first", name: "首次上榜" },
                { id: "up_and_first", name: "上升与首次上榜" },
              ],
              "trendMode",
            ),
          ),
        );
      }
    }
    form.append(
      grid,
      el("div", undefined, "divider"),
      button(
        "创建采集任务",
        async () => {
          const parameters = {};
          for (const input of form.querySelectorAll("[name]")) {
            const parse = (value) => {
              try {
                return JSON.parse(value);
              } catch {
                return value;
              }
            };
            parameters[input.name] =
              input.type === "checkbox"
                ? input.checked
                : input.type === "number"
                  ? input.value === '' ? null : Number(input.value)
                  : input.multiple
                    ? Array.from(input.selectedOptions).map((o) =>
                        parse(o.value),
                      )
                    : parse(input.value);
          }
          for (const group of form.querySelectorAll('[data-multiple]')) {
            parameters[group.dataset.multiple] = [...group.querySelectorAll('input:checked')].map(input => {
              try {return JSON.parse(input.value);} catch {return input.value;}
            });
          }
          if (tool.toolId !== "video-ranking") {
            parameters.categories = parameters.category;
            delete parameters.category;
            if (!parameters.categories.length) throw Error("请至少勾选一个类目。");
          }
          if (tool.toolId === "top200" && !parameters.rankingTypes.length) throw Error("请至少勾选一个榜单。");
          const result = await call("tasks.create", {
            toolId: tool.toolId,
            parameters,
          });
          await navigate("tasks");
          notice("任务已加入队列。");
          await taskDetail(result.taskId);
        },
        "primary",
      ),
    );
    box.append(el("div", undefined, "divider"), form);
  }
  content.append(box);
}
async function capture() {
  if (state.view !== "manual-video") return;
  content.replaceChildren();
  const tool = state.tools.find((t) => t.toolId === "manual-video");
  const box = panel("添加视频");
  const text = el("textarea");
  text.placeholder = "粘贴抖音分享链接或完整分享文案，可一次添加多个";
  text.value = state.captureText;
  text.addEventListener("input", () => { state.captureText = text.value; });
  box.append(field("分享链接 / 文案", text, true));
  const actions = el("div", undefined, "toolbar");
  actions.append(
    button("添加到待选列表", async () => {
      const result = await call("capture.add_text", { text: text.value });
      state.captureText = "";
      notice(
        `已添加 ${result.added} 条，更新 ${result.updated} 条，忽略 ${result.rejectedCount} 个不支持链接。`,
      );
      await capture();
    }),
  );
  const read = button("读取当前页", async () => {
    const pages = (await call("browser.list_pages")).filter(page => ["compass_ranking", "compass", "douyin"].includes(page.source));
    const dialog = $("#dialog-content");
    $("#dialog").dataset.kind = "pages";
    dialog.replaceChildren(el("h2", "选择要读取的视频页面"), el("p", "支持罗盘短视频榜，以及抖音视频详情、作者主页、搜索和推荐中已加载的视频。", "hint"));
    for (const page of pages)
      dialog.append(
        button(`${page.source === "douyin" ? "抖音" : "罗盘"} · ${page.title || "未命名页面"}`, async () => {
          const result = await call("capture.read_page", { pageId: page.id });
          state.captureOperations.set(result.operationId, "capture_page");
          $("#dialog").close();
          await capture();
          notice("正在读取所选页面，完成后会更新待选列表。");
        }),
      );
    if (!pages.length)
      dialog.append(
        el("p", "没有可读页面。请先打开罗盘或抖音，浏览到有视频的页面。"),
      );
    $("#dialog").showModal();
  });
  read.disabled = !tool.available || [...state.captureOperations.values()].includes("capture_page");
  actions.append(button("打开罗盘", async () => { await call("browser.open", { source: "manual-video" }); notice("在罗盘短视频榜选择商品和筛选条件后，回到这里读取页面。"); }),
    button("打开抖音", async () => { await call("browser.open", { source: "douyin" }); notice("在抖音浏览需要的视频后，回到这里读取页面。"); }), read);
  box.append(
    el("div", undefined, "divider"),
    actions,
    el("p", "读取当前已加载视频，不限制罗盘上榜趋势；翻页或浏览新视频后可继续读取。罗盘没有公开分享链接时，可先提取播放链接或直接下载。", "hint"),
  );
  if (state.captureOperations.size) box.append(el("p", `正在处理 ${state.captureOperations.size} 批读取/链接提取，请稍候……`, "hint"));
  content.append(box);
  const data = await call("capture.list", {
    offset: state.captureOffset,
    limit: 50,
    query: state.captureQuery,
  });
  if (state.view !== "manual-video" || !content.contains(box)) return;
  const list = panel();
  const head = el("div", undefined, "capture-heading");
  const count = el("strong");
  head.append(el("h2", `待选视频 · ${data.total} 条${state.captureQuery ? "筛选结果" : ""}`), count);
  const filter = el("form", undefined, "capture-filter");
  const search = el("input");
  search.type = "search"; search.maxLength = 100; search.placeholder = "筛选标题、商品或作者";
  search.setAttribute("aria-label", search.placeholder); search.value = state.captureQuery;
  const submit = el("button", "筛选"); submit.type = "submit";
  const reset = button("清空筛选", async () => { state.captureQuery = ""; state.captureOffset = 0; await capture(); }); reset.type = "button";
  filter.append(search, submit, reset);
  filter.addEventListener("submit", async event => {
    event.preventDefault(); state.captureQuery = search.value.trim(); state.captureOffset = 0;
    try { await capture(); } catch (error) { notice(error.message, true); }
  });
  const controls = el("div", undefined, "toolbar capture-controls");
  const download = button("下载所选", () => downloadCaptured([...state.selected]), "primary");
  const resolve = button("提取所选链接", () => resolveCaptured([...state.selected]));
  const selectPage = button("选择本页", () => {
    for (const item of data.items) { if (state.selected.size >= 200) break; state.selected.add(item.id); }
    for (const check of list.querySelectorAll('[data-capture-id]')) check.checked = state.selected.has(check.dataset.captureId);
    updateControls();
  });
  const clear = button("清空选择", () => {
    state.selected.clear(); for (const check of list.querySelectorAll('[data-capture-id]')) check.checked = false;
    updateControls();
  });
  const selectionActions = [download, resolve,
    button("复制标题", () => copy("title")), button("复制链接", () => copy("link")),
    button("导出列表", async () => {
      const result = await call("capture.export", { itemIds: [...state.selected] });
      notice(result.cancelled ? "已取消导出。" : `已导出 ${result.exported} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条。`, result.failed > 0);
    }),
    button("移除所选", async () => {
      await call("capture.remove", { itemIds: [...state.selected] });
      state.selected.clear();
      state.captureOffset = 0;
      await capture();
    }), clear];
  controls.append(selectPage, ...selectionActions);
  const updateControls = () => {
    count.textContent = `已选 ${state.selected.size} 条 / 最多 200 条`;
    for (const action of selectionActions) action.disabled = !state.selected.size;
    download.disabled = !tool.available || !state.selected.size;
    resolve.disabled = !tool.available || !state.selected.size || [...state.captureOperations.values()].includes("resolve_items");
    selectPage.disabled = !data.items.length || state.selected.size >= 200;
  };
  updateControls();
  list.append(head, filter, controls, el("p", "按封面和标题选择具体视频。公开链接可直接复制；罗盘播放链接需先提取，可能随平台会话过期。", "hint"));
  const groups = new Map();
  for (const item of data.items) {
    const details = item.details || {};
    const product = details.productName || item.title.match(/^商品“(.+?)”的视频/)?.[1];
    const groupKey = item.locator?.productKey || `${item.sourcePage}:${details.authorName || product || ""}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { title: product || details.authorName || (item.sourceKind === "compass_ranking" ? "罗盘视频 · 重新读取可补充商品信息" : "抖音视频"), items: [] });
    groups.get(groupKey).items.push(item);
  }
  for (const group of groups.values()) {
    const section = el("section", undefined, "capture-group");
    const groupHead = el("div", undefined, "capture-group-heading");
    groupHead.append(el("h3", group.title), el("small", `本页 ${group.items.length} 条`)); section.append(groupHead);
    group.items.sort((a, b) => (a.details?.videoIndex || 0) - (b.details?.videoIndex || 0));
    for (const item of group.items) {
    const details = item.details || {};
    const row = el("div", undefined, "capture-video");
    const check = el("input");
    check.type = "checkbox";
    check.dataset.captureId = item.id;
    check.checked = state.selected.has(item.id);
    check.setAttribute("aria-label", `选择 ${details.productName || details.authorName || item.title}${details.videoIndex ? ` 第${details.videoIndex}条视频` : ""}`);
    check.addEventListener("change", () => {
      if(check.checked && state.selected.size >= 200) {check.checked=false;notice("每次最多选择200条视频。",true);return;}
      check.checked ? state.selected.add(item.id) : state.selected.delete(item.id);
      updateControls();
    });
    const cover = el("div", undefined, "capture-cover");
    if (details.coverUrl) {
      const image = el("img"); image.src = details.coverUrl; image.loading = "lazy";
      image.alt = "视频封面"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => { cover.replaceChildren(el("span", "封面不可用")); }); cover.append(image);
    } else cover.append(el("span", "暂无封面"));
    const info = el("div", undefined, "capture-video-info");
    info.append(el("small", [details.sourceLabel || (item.sourceKind === "compass_ranking" ? "罗盘" : "抖音"), details.videoIndex ? `第 ${details.videoIndex} 条` : "", details.duration].filter(Boolean).join(" · ")),
      el("h4", details.titleKnown === false || /标题未读取/.test(item.title) ? "视频标题未读取" : item.title),
      el("p", [details.authorName && `作者：${details.authorName}`, details.shopName && `店铺：${details.shopName}`].filter(Boolean).join(" · "), "hint"),
      el("small", item.providerId ? `视频 ID：${item.providerId}` : `卡片：${(item.locator?.cardKey || item.id).slice(0, 10)}`),
      el("small", `读取于 ${time(item.capturedAt)}`),
      el("p", details.linkError || (item.publicUrl ? "可复制公开链接" : item.temporaryAvailable ? "播放链接已提取，可能过期" : "可从原页面提取链接并下载"), "capture-link-state"));
    const itemActions = el("div", undefined, "capture-video-actions");
    const itemDownload = button("下载这条", () => downloadCaptured([item.id])); itemDownload.disabled = !tool.available;
    const itemCopy = button("复制链接", () => copy("link", [item.id])); itemCopy.disabled = !item.publicUrl && !item.temporaryAvailable;
    itemActions.append(itemDownload, itemCopy);
    if (!item.publicUrl) { const extract = button("提取链接", () => resolveCaptured([item.id])); extract.disabled = !tool.available || [...state.captureOperations.values()].includes("resolve_items"); itemActions.append(extract); }
    row.append(check, cover, info, itemActions); section.append(row);
    }
    list.append(section);
  }
  if (!data.total)
    list.append(
      el("p", state.captureQuery ? "没有匹配的视频，请修改筛选文字或清空筛选。" : "打开罗盘或抖音读取视频，也可粘贴分享链接添加。", "hint"),
    );
  list.append(
    pager(data.total, state.captureOffset, 50, async (offset) => {
      state.captureOffset = offset;
      await capture();
    }),
  );
  content.append(list);
}
async function downloadCaptured(itemIds) {
  await call("tasks.create", { toolId: "manual-video", itemIds });
  await navigate("tasks"); notice("所选视频已加入下载队列。");
}
async function resolveCaptured(itemIds) {
  let submitted = 0;
  try {
    for (let index = 0; index < itemIds.length; index += 10) {
      const batch = itemIds.slice(index, index + 10);
      const result = await call("capture.resolve", { itemIds: batch });
      state.captureOperations.set(result.operationId, "resolve_items"); submitted += batch.length;
    }
    notice(`已提交 ${submitted} 条链接提取，完成后可复制链接。`);
  } catch (error) { notice(`已提交 ${submitted} 条，其余未提交：${error.message}`, true); }
  await capture();
}
async function copy(field, itemIds = [...state.selected]) {
  const result = await call("capture.copy", {
    itemIds,
    field,
  });
  notice(
    `已复制 ${result.copied} 条${result.unavailable ? `，${result.unavailable} 条暂无可用内容` : ""}。`,
  );
}
async function storage() {
  if (state.view !== "storage") return;
  const loading = empty("正在统计存储占用", "请稍候，正在读取本机存储信息……");
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  loading.setAttribute("aria-busy", "true");
  const spinner = el("div", undefined, "loading-spinner");
  spinner.setAttribute("aria-hidden", "true");
  loading.prepend(spinner);
  content.replaceChildren(loading);
  let usage, location, exportLocation;
  try {
    [usage, location, exportLocation] = await Promise.all([
      call("storage.get_usage"),
      call("storage.get_location"),
      call("storage.get_export_location"),
    ]);
  } catch (error) {
    if (state.view !== "storage" || !content.contains(loading)) return;
    content.replaceChildren(empty("存储信息读取失败", "请点击右上角“刷新”重试。"));
    throw error;
  }
  if (state.view !== "storage" || !content.contains(loading)) return;
  const position = panel("数据保存位置");
  position.append(el("p", location.path), el("p", `磁盘剩余 ${bytes(location.freeBytes)} / 共 ${bytes(location.totalBytes)}`, "hint"),
    button("更改数据位置", async () => {
      const result = await call("storage.choose_location");
      if (result.cancelled) { notice("已取消更改数据位置。"); return; }
      await storage();
      if (result.restartRequired) notice("数据位置已选择。请退出软件，再次打开完成复制校验迁移。");
    }),
    el("p", "在系统窗口选择文件夹，工具箱会使用其下的 ScriptAllToolbox 数据目录。完成选择后退出软件，再次打开完成复制校验迁移；迁移成功后可在此清理旧位置。", "hint"),
    el("p", "更改前请先结束运行或暂停的任务，并等待页面读取操作完成。", "hint"));
  if (location.error) position.append(el("p", location.error, "hint"));
  if (location.pending) position.append(el("p", `待迁移位置：${location.requestedPath || "已选择的新位置"}。请退出软件后再次打开。`, "hint"));
  if (location.previousPath) position.append(el("p", `旧位置：${location.previousPath}`, "hint"),
    button("清理旧位置", async () => {
      const result = await call("storage.clean_old_location");
      await storage();
      notice(result.removed ? `已清理旧位置，释放 ${bytes(result.releasedBytes)}。` : "没有需要清理的旧位置。");
    }));
  const exportPosition = panel("默认导出位置");
  exportPosition.append(el("p", exportLocation.path || "尚未设置，导出时选择文件夹。"),
    button("选择文件夹", async () => {
      const result = await call("storage.choose_export_location");
      if (result.cancelled) { notice("已取消选择默认导出位置。"); return; }
      await storage();
      notice("默认导出位置已保存。");
    }),
    el("p", "视频点击导出后保存到这里，按任务和商品归类并附带文案；报表保存窗口默认打开这里。内部视频继续统一去重，下载完成不会自动复制或生成备份。", "hint"));
  const box = panel("本机存储");
  const metrics = el("div", undefined, "metrics");
  for (const [key, title] of Object.entries({
    results: "报表与文本",
    media: "共享视频",
    recovery: "恢复数据",
    cache: "可重建缓存",
    logs: "运行日志",
    browser: "平台登录资料",
    database: "索引与其他",
    cost: "成本业务库与导出",
    costBackups: "成本恢复备份",
    costLogs: "成本运行日志",
    costTemporary: "成本预览临时资料",
  })) {
    const metric = el("div", undefined, "metric");
    metric.append(el("strong", bytes(usage[key] || 0)), el("span", title));
    metrics.append(metric);
  }
  box.append(
    metrics,
    el("div", undefined, "divider"),
    button("清理可重建缓存", async () => {
      const result = await call("storage.clean_cache");
      await storage();
      notice(
        `已释放 ${bytes(result.releasedBytes)}。活动任务、结果与恢复进度已保留。`,
      );
    }),
    el(
      "p",
      "删除结果请到任务详情操作。共享视频只在最后一个任务引用被删除后释放。",
      "hint",
    ),
  );
  const login = panel("平台登录资料");
  login.append(
    el("p", "清除后需要重新登录受管浏览器，不影响你日常使用的 Edge。", "hint"),
    button(
      "清除受管浏览器登录",
      async () => {
        if (window.confirm("确认清除受管浏览器的全部登录资料？")) {
          await call("browser.clear_login", { confirmed: true });
          notice("登录资料已清除。");
        }
      },
      "danger",
    ),
  );
  content.replaceChildren(position, exportPosition, box, login);
}
async function poll() {
  try {
    const data = await call("events.read", { afterSeq: state.seq });
    state.seq = data.nextSeq;
    if (data.resetRequired) {
      await refreshState();
      await render();
    }
    let changed = false, detailChanged = false, filesChanged = false;
    for (const event of data.events) {
      if (
        event.type === "operation.state" &&
        event.data.state === "completed"
      ) {
        const captureOperation = state.captureOperations.delete(event.data.operationId);
        if (captureOperation && state.view === "manual-video") changed = true;
        if (event.data.kind === "discover") {
          for (const options of Object.values(state.options))
            if (options.operationId === event.data.operationId)
              options.result = event.data.result;
          changed = state.options[state.view]?.operationId === event.data.operationId;
        }
        if (event.data.kind === 'title_plan' && event.data.operationId === state.titleOperation) {
          state.titleOperation = null;
          state.titlePlan = event.data.result;
          state.titleOffset = 0;
          changed = state.view === 'product-title';
        }
        if (["capture_page", "resolve_items"].includes(event.data.kind)) {
          const result = event.data.result || {};
          notice(event.data.kind === "resolve_items" ? `链接提取完成${result.failed ? `，${result.failed} 条未成功，请查看对应视频提示` : "，可复制链接"}。`
            : `已读取 ${result.added || 0} 条新视频，更新 ${result.updated || 0} 条。${result.scope || ""}`, Boolean(result.failed));
        } else notice("读取完成。");
        if (event.data.kind === "capture_page") changed = state.view === "manual-video";
      } else if (
        event.type === "operation.state" &&
        event.data.state === "failed"
      ) {
        for (const options of Object.values(state.options)) {
          if (options.operationId === event.data.operationId) {
            options.error = event.data.error.message;
            if (state.options[state.view] === options) changed = true;
          }
        }
        if (event.data.operationId === state.titleOperation) {
          state.titleOperation = null;
          changed = state.view === 'product-title';
        }
        if (state.captureOperations.delete(event.data.operationId) && state.view === "manual-video") changed = true;
        notice(event.data.error.message, true);
      }
      else if (event.type === "task.state" || event.type === "task.progress") {
        if (state.view === "tasks") changed = true;
        if (event.taskId === state.task && $("#dialog").open && $("#dialog").dataset.kind === "task") {
          if (event.type === "task.state") detailChanged = true;
          else {
            const progress = $(".detail-progress");
            if(progress) progress.textContent = progressText(progress.dataset.toolId, event.data) || `${event.data.current ?? 0} / ${event.data.total ?? "—"}`;
          }
        }
      }
      else if(event.type === "task.artifact" && event.taskId === state.task) filesChanged = true;
      else if(event.type === "capture.updated" && state.view === "manual-video") changed = true;
      else if (event.type === "browser.state") browserState(event.data);
    }
    if (changed && $("#dialog").open === false) await render();
    if(detailChanged) await taskDetail(state.task);
    else if(filesChanged && $("#detail-files")) await artifactPage(state.task,state.artifactOffset);
  } catch (error) {
    notice(error.message, true);
  }
  setTimeout(poll, document.hidden ? 5000 : 1000);
}
function browserState(value) {
  $("#browser-state").textContent = value.holder
    ? "浏览器使用中"
    : value.connected
      ? "浏览器已连接 · 登录需检查"
      : value.edgeAvailable
        ? "浏览器待打开"
        : "未检测到 Edge";
}
async function refreshState() {
  const data = await call("app.get_state");
  state.tools = data.tools;
  browserState(data.browser);
}
async function initialize() {
  try {
    await refreshState();
    for (const tool of state.tools) {
      const node = button(tool.name, () => navigate(tool.toolId));
      node.dataset.view = tool.toolId;
      $("#tools").append(node);
    }
    $("#work-nav")
      .querySelectorAll("button")
      .forEach((b) =>
        b.addEventListener("click", () =>
          navigate(b.dataset.view).catch((e) => notice(e.message, true)),
        ),
      );
    $("#refresh").addEventListener("click", () =>
      (state.view === 'cost-assistant' ? costView?.refresh() : render()).catch((e) => notice(e.message, true)),
    );
    $("#open-browser").addEventListener("click", async () => {
      try {
        await call("browser.open", {
          source: state.tools.some((t) => t.toolId === state.view)
            ? state.view
            : "top200",
        });
        notice("请在打开的受管浏览器登录并浏览。");
      } catch (error) {
        notice(error.message, true);
      }
    });
    $("#quit").addEventListener("click", () => call("app.request_exit"));
    $('#cost-extension-folder').addEventListener('click', () => call('cost.open_extension').catch(e => notice(e.message, true)));
    $('#cost-extension-page').addEventListener('click', () => call('browser.open', {source: 'cost-extension'}).catch(e => notice(e.message, true)));
    $("#dialog-close").addEventListener("click", () => $("#dialog").close());
    $("#dialog").addEventListener("close", () => {
      if ($("#dialog").dataset.kind !== "task") return;
      state.task = null;
      state.files.clear();
      state.artifactOffset = 0;
      state.resultOffset = 0;
      state.resultSection = 'results';
    });
    await navigate("tasks");
    poll();
  } catch (error) {
    notice(error.message, true);
  }
}
window.addEventListener("pywebviewready", initialize);
