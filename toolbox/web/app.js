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
};
const state = {
  view: "tasks",
  tools: [],
  offset: 0,
  seq: 0,
  options: {},
  selected: new Set(),
  captureOffset: 0,
  task: null,
};
const content = $("#content");
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
  if (!result.ok) throw Error(result.error.message);
  return result.data;
}
const toolName = (id) => state.tools.find((t) => t.toolId === id)?.name || id;
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
    "business-center": "按类目与销量范围筛选商机，生成可交付报告。",
    top200: "采集商品榜前 200 名，保留榜单变化与商品链接。",
    "video-ranking": "按趋势条件采集商品视频，视频与文案集中管理。",
    "manual-video": "读取当前页或粘贴分享链接，勾选后下载。",
  }[view];
  await render();
}
async function render() {
  if (state.view === "tasks") return tasks();
  if (state.view === "storage") return storage();
  if (state.view === "manual-video") return capture();
  return toolForm();
}
async function tasks() {
  const data = await call("tasks.list", { offset: state.offset, limit: 20 });
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
    const name = el("div");
    name.append(
      el("h3", toolName(task.toolId)),
      el("small", time(task.createdAt)),
      el(
        "small",
        task.error?.message || task.progress.message || "查看详情与结果",
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
  state.task = taskId;
  const task = await call("tasks.get", { taskId });
  const box = $("#dialog-content");
  box.replaceChildren(
    el("h2", toolName(task.toolId)),
    el("p", `${labels[task.state]} · ${time(task.createdAt)}`),
  );
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
    button("查看日志", async () => {
      const logs = await call("tasks.logs", { taskId });
      const pre = el(
        "pre",
        logs.items.map((i) => `${i.at} ${i.message}`).join("\n") || "暂无日志",
      );
      box.append(pre);
    }),
    button("删除任务", () => deleteTask(taskId), "danger"),
  );
  box.append(el("div", undefined, "divider"), actions);
  if (task.error) box.append(el("p", task.error.message, "hint"));
  const artifacts = task.artifacts.items;
  if (artifacts.length) {
    box.append(el("h3", "交付文件"));
    for (const file of artifacts) {
      const row = el("div", undefined, "artifact");
      row.append(
        el("span", `${file.displayName} · ${bytes(file.size)}`),
        button("打开", () => call("artifacts.open", { artifactId: file.id })),
        button("导出", () =>
          call("artifacts.export", { artifactIds: [file.id] }),
        ),
      );
      box.append(row);
    }
    if (task.artifacts.total > artifacts.length)
      box.append(
        el(
          "p",
          `共 ${task.artifacts.total} 个文件，当前显示前 ${artifacts.length} 个。`,
          "hint",
        ),
      );
  }
  const result = await call("tasks.results", { taskId, offset: 0, limit: 50 });
  box.append(el("h3", `业务结果 · ${result.total} 条`));
  box.append(resultTable(result.items));
  if (result.total > 50)
    box.append(
      pager(result.total, 0, 50, async (offset) => resultPage(taskId, offset)),
    );
  $("#dialog").showModal();
}
async function resultPage(taskId, offset) {
  const result = await call("tasks.results", { taskId, offset, limit: 50 });
  const box = $("#dialog-content");
  box.replaceChildren(
    el(
      "h2",
      `${toolName((await call("tasks.get", { taskId })).toolId)} · 结果`,
    ),
    resultTable(result.items),
    pager(result.total, offset, 50, (n) => resultPage(taskId, n)),
  );
}
function resultTable(items) {
  if (!items.length) return el("p", "暂无结果，可稍后刷新。", "hint");
  const wrap = el("div", undefined, "table-wrap");
  const table = el("table");
  const columns = Object.keys(items[0])
    .filter(
      (key) => !["fingerprint", "locator", "mediaUrl", "url"].includes(key),
    )
    .slice(0, 9);
  const head = el("tr");
  columns.forEach((key) => head.append(el("th", key)));
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
              ? JSON.stringify(value)
              : String(value ?? ""),
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
        : value.name || value.label || value.text || value.id,
    );
    option.value = typeof value === "string" ? value : JSON.stringify(value);
    input.append(option);
  }
  return input;
}
async function discover(toolId) {
  const { operationId } = await call("tools.discover", { toolId });
  state.options[toolId] = { operationId };
  notice("已加入读取队列，请在受管浏览器完成登录。");
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
    const category = select(categories, "category");
    if (tool.toolId === "business-center" || tool.toolId === "top200") {
      category.multiple = true;
      category.size = Math.min(7, categories.length || 1);
    }
    grid.append(
      field(
        tool.toolId === "video-ranking" ? "类目" : "类目（按 Ctrl 多选）",
        category,
        true,
      ),
    );
    if (tool.toolId === "business-center") {
      for (const [name, title, value] of [
        ["minSales", "最低销量", 0],
        ["maxSales", "最高销量", 999999],
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
      grid.append(field("仅看近 30 天增长", check));
    } else {
      grid.append(
        field(
          "品牌",
          select(options.result.brandTypes || ["全部"], "brandType"),
        ),
      );
      if (tool.toolId === "top200") {
        const rankings = select(
          options.result.rankingTypes || [],
          "rankingTypes",
        );
        rankings.multiple = true;
        rankings.size = 6;
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
                  ? Number(input.value)
                  : input.multiple
                    ? Array.from(input.selectedOptions).map((o) =>
                        parse(o.value),
                      )
                    : parse(input.value);
          }
          if (tool.toolId !== "video-ranking") {
            parameters.categories = parameters.category;
            delete parameters.category;
          }
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
  content.replaceChildren();
  const tool = state.tools.find((t) => t.toolId === "manual-video");
  const box = panel("添加视频");
  const text = el("textarea");
  text.placeholder = "粘贴抖音分享链接或完整分享文案，可一次添加多个";
  box.append(field("分享链接 / 文案", text, true));
  const actions = el("div", undefined, "toolbar");
  actions.append(
    button("添加到待选列表", async () => {
      const result = await call("capture.add_text", { text: text.value });
      notice(
        `已添加 ${result.added} 条，更新 ${result.updated} 条，忽略 ${result.rejectedCount} 个不支持链接。`,
      );
      await capture();
    }),
  );
  const read = button("读取当前页", async () => {
    const pages = await call("browser.list_pages");
    const dialog = $("#dialog-content");
    dialog.replaceChildren(el("h2", "选择受管浏览器标签页"));
    for (const page of pages)
      dialog.append(
        button(`${page.title || "未命名页面"} · ${page.source}`, async () => {
          await call("capture.read_page", { pageId: page.id });
          $("#dialog").close();
          notice("已加入当前页读取队列。");
        }),
      );
    if (!pages.length)
      dialog.append(
        el("p", "没有可读页面。请先打开平台并浏览到包含视频的商品榜。"),
      );
    $("#dialog").showModal();
  });
  read.disabled = !tool.available;
  actions.append(read);
  box.append(
    el("div", undefined, "divider"),
    actions,
    el("p", "当前页读取仅处理已加载内容；手动翻页后可以继续追加。", "hint"),
  );
  content.append(box);
  const data = await call("capture.list", {
    offset: state.captureOffset,
    limit: 50,
  });
  const list = panel(`待选列表 · ${data.total} 条`);
  const controls = el("div", undefined, "toolbar");
  controls.append(
    button(
      "下载所选",
      async () => {
        await call("tasks.create", {
          toolId: "manual-video",
          itemIds: [...state.selected],
        });
        await navigate("tasks");
        notice("所选视频已加入下载队列。");
      },
      "primary",
    ),
    button("复制标题", () => copy("title")),
    button("复制公开链接", () => copy("publicUrl")),
    button("复制临时链接", () => copy("temporaryUrl")),
    button("导出列表", () =>
      call("capture.export", { itemIds: [...state.selected] }),
    ),
    button("移除所选", async () => {
      await call("capture.remove", { itemIds: [...state.selected] });
      state.selected.clear();
      await capture();
    }),
  );
  controls.firstChild.disabled = !tool.available;
  list.append(controls, el("div", undefined, "divider"));
  for (const item of data.items) {
    const row = el("div", undefined, "artifact");
    const check = el("input");
    check.type = "checkbox";
    check.checked = state.selected.has(item.id);
    check.addEventListener("change", () =>
      check.checked
        ? state.selected.add(item.id)
        : state.selected.delete(item.id),
    );
    row.append(
      check,
      el("span", item.title),
      el(
        "small",
        item.publicUrl
          ? "公开页面"
          : item.temporaryAvailable
            ? "临时媒体"
            : "需重新读取",
      ),
    );
    list.append(row);
  }
  if (!data.total)
    list.append(
      el("p", "添加链接，或在受管浏览器打开商品榜后读取视频。", "hint"),
    );
  list.append(
    pager(data.total, state.captureOffset, 50, async (offset) => {
      state.captureOffset = offset;
      await capture();
    }),
  );
  content.append(list);
}
async function copy(field) {
  const result = await call("capture.copy", {
    itemIds: [...state.selected],
    field,
  });
  notice(
    `已复制 ${result.copied} 条${result.unavailable ? `，${result.unavailable} 条暂无可用内容` : ""}。`,
  );
}
async function storage() {
  const usage = await call("storage.get_usage");
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
  content.replaceChildren(box, login);
}
async function poll() {
  try {
    const data = await call("events.read", { afterSeq: state.seq });
    state.seq = data.nextSeq;
    if (data.resetRequired) {
      await refreshState();
      await render();
    }
    let changed = false;
    for (const event of data.events) {
      if (
        event.type === "operation.state" &&
        event.data.state === "completed"
      ) {
        if (event.data.kind === "discover") {
          for (const options of Object.values(state.options))
            if (options.operationId === event.data.operationId)
              options.result = event.data.result;
        }
        notice("读取完成。");
        changed = true;
      } else if (
        event.type === "operation.state" &&
        event.data.state === "failed"
      )
        notice(event.data.error.message, true);
      else if (event.type === "task.state" || event.type === "capture.updated")
        changed = true;
      else if (event.type === "browser.state") browserState(event.data);
    }
    if (changed && $("#dialog").open === false) await render();
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
      render().catch((e) => notice(e.message, true)),
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
    $("#dialog-close").addEventListener("click", () => $("#dialog").close());
    await navigate("tasks");
    poll();
  } catch (error) {
    notice(error.message, true);
  }
}
window.addEventListener("pywebviewready", initialize);
