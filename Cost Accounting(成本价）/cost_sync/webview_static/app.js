"use strict";

const refreshModel = globalThis.CostAssistantRefresh;
const shippingFilters = globalThis.CostAssistantShippingFilters;
const byId = (id) => document.getElementById(id);
const ui = {
  pageTitle: byId("page-title"),
  servicePill: byId("service-pill"),
  serviceStatus: byId("service-status"),
  serviceDetail: byId("service-detail"),
  activity: byId("activity"),
  environment: byId("metric-environment"),
  products: byId("metric-products"),
  mappings: byId("metric-mappings"),
  updated: byId("metric-updated"),
  refreshState: byId("refresh-state"),
  startService: byId("start-service"),
  stopService: byId("stop-service"),
  ordinaryName: byId("ordinary-name"),
  combinationName: byId("combination-name"),
  mappingName: byId("mapping-name"),
  previewCatalog: byId("preview-catalog"),
  applyCatalog: byId("apply-catalog"),
  catalogProgress: byId("catalog-progress"),
  catalogPreview: byId("catalog-preview"),
  catalogPreviewTitle: byId("catalog-preview-title"),
  catalogPreviewGuidance: byId("catalog-preview-guidance"),
  catalogPreviewSeal: byId("catalog-preview-seal"),
  catalogOrdinary: byId("catalog-ordinary"),
  catalogCombination: byId("catalog-combination"),
  catalogMerged: byId("catalog-merged"),
  catalogEmpty: byId("catalog-empty"),
  catalogResolved: byId("catalog-resolved"),
  catalogChanges: byId("catalog-changes"),
  catalogConflicts: byId("catalog-conflicts"),
  catalogResult: byId("catalog-result"),
  shopName: byId("shop-name"),
  knownShops: byId("known-shops"),
  previewMapping: byId("preview-mapping"),
  applyMapping: byId("apply-mapping"),
  saveMappingReviews: byId("save-mapping-reviews"),
  mappingProgress: byId("mapping-progress"),
  mappingPreview: byId("mapping-preview"),
  mappingPreviewTitle: byId("mapping-preview-title"),
  mappingPreviewGuidance: byId("mapping-preview-guidance"),
  mappingPreviewSeal: byId("mapping-preview-seal"),
  mappingTotal: byId("mapping-total"),
  mappingMatched: byId("mapping-matched"),
  mappingNew: byId("mapping-new"),
  mappingChange: byId("mapping-change"),
  mappingExisting: byId("mapping-existing"),
  mappingPending: byId("mapping-pending"),
  mappingErrors: byId("mapping-errors"),
  mappingCategoryComplete: byId("mapping-category-complete"),
  mappingCategoryIncomplete: byId("mapping-category-incomplete"),
  mappingMajorConfigured: byId("mapping-major-configured"),
  mappingMajorUnconfigured: byId("mapping-major-unconfigured"),
  mappingFeeMatched: byId("mapping-fee-matched"),
  mappingFeeUnconfigured: byId("mapping-fee-unconfigured"),
  mappingFeeDisabled: byId("mapping-fee-disabled"),
  mappingConflicts: byId("mapping-conflicts"),
  mappingResult: byId("mapping-result"),
  refreshHistory: byId("refresh-history"),
  historyList: byId("history-list"),
  historyEmpty: byId("history-empty"),
  historyResult: byId("history-result"),
  /* RELEASE_EXCLUDE_START: v2 */
  refreshServiceFee: byId("refresh-service-fee"),
  importOfficialServiceFee: byId("import-official-service-fee"),
  archiveLegacyServiceFee: byId("archive-legacy-service-fee"),
  toggleServiceFeeArchive: byId("toggle-service-fee-archive"),
  newServiceFee: byId("new-service-fee"),
  serviceFeeList: byId("service-fee-list"),
  serviceFeeEmpty: byId("service-fee-empty"),
  serviceFeeForm: byId("service-fee-form"),
  serviceFeeSourceId: byId("service-fee-source-id"),
  serviceFeeFormTitle: byId("service-fee-form-title"),
  serviceFeeMajorCategory: byId("service-fee-major-category"),
  serviceFeeMajorFilter: byId("service-fee-major-filter"),
  serviceFeeSearch: byId("service-fee-search"),
  serviceFeeRateFilter: byId("service-fee-rate-filter"),
  serviceFeeCategories: [1, 2, 3, 4].map((index) => byId(`service-fee-category-${index}`)),
  serviceFeeRate: byId("service-fee-rate"),
  serviceFeeSpecialRate: byId("service-fee-special-rate"),
  serviceFeeEffective: byId("service-fee-effective"),
  serviceFeeNote: byId("service-fee-note"),
  toggleServiceFee: byId("toggle-service-fee"),
  previewServiceFee: byId("preview-service-fee"),
  serviceFeeProgress: byId("service-fee-progress"),
  serviceFeeResult: byId("service-fee-result"),
  refreshShipping: byId("refresh-shipping"),
  newShippingTemplate: byId("new-shipping-template"),
  shippingTemplateList: byId("shipping-template-list"),
  shippingEmpty: byId("shipping-empty"),
  shippingForm: byId("shipping-form"),
  shippingTemplateId: byId("shipping-template-id"),
  shippingFormTitle: byId("shipping-form-title"),
  shippingEnabled: byId("shipping-enabled"),
  shippingName: byId("shipping-name"),
  shippingFirstWeight: byId("shipping-first-weight"),
  shippingFirstFee: byId("shipping-first-fee"),
  shippingAdditionalWeight: byId("shipping-additional-weight"),
  shippingAdditionalFee: byId("shipping-additional-fee"),
  shippingPreviewWeight: byId("shipping-preview-weight"),
  shippingPreviewRegion: byId("shipping-preview-region"),
  shippingPreviewCost: byId("shipping-preview-cost"),
  shippingRuleList: byId("shipping-rule-list"),
  addShippingRule: byId("add-shipping-rule"),
  previewShipping: byId("preview-shipping"),
  shippingProgress: byId("shipping-progress"),
  shippingResult: byId("shipping-result"),
  shippingBindingForm: byId("shipping-binding-form"),
  shippingBindingShop: byId("shipping-binding-shop"),
  shippingBindingStatus: byId("shipping-binding-status"),
  shippingBindingSearch: byId("shipping-binding-search"),
  shippingBindingTemplate: byId("shipping-binding-template"),
  shippingProductList: byId("shipping-product-list"),
  shippingUnboundCount: byId("shipping-unbound-count"),
  shippingBindingProgress: byId("shipping-binding-progress"),
  /* RELEASE_EXCLUDE_END: v2 */
  /* RELEASE_EXCLUDE_START: reviews */
  refreshReviews: byId("refresh-reviews"),
  reviewTotal: byId("review-total"),
  reviewList: byId("review-list"),
  reviewEmpty: byId("review-empty"),
  /* RELEASE_EXCLUDE_END: reviews */
  refreshLogs: byId("refresh-logs"),
  openLogs: byId("open-logs"),
  logContent: byId("log-content"),
  confirmDialog: byId("confirm-dialog"),
  confirmTitle: byId("confirm-title"),
  confirmMessage: byId("confirm-message"),
  confirmAccept: byId("confirm-accept"),
  toast: byId("toast")
};

const state = {
  bridgeReady: false,
  busy: false,
  refreshing: false,
  refreshPromise: null,
  lastRefreshFailed: false,
  serviceExpected: false,
  ownsService: false,
  files: { ordinary: null, combination: null, mapping: null },
  catalogPreview: null,
  mappingPreview: null,
  /* RELEASE_EXCLUDE_START: v2 */
  serviceFeeRates: [],
  serviceFeeArchivedView: false,
  serviceFeeCoverageRequest: 0,
  selectedServiceFeeId: null,
  shippingTemplates: [],
  shippingProducts: [],
  shippingPreview: null,
  /* RELEASE_EXCLUDE_END: v2 */
  rollbackRefreshRequired: false,
  toastTimer: null
};

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "—";
}

function displayTime(value) {
  if (typeof value !== "string" || !value) return "尚无记录";
  return value.replace("T", " ").replace("+08:00", "");
}

function showToast(message, success = false) {
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  ui.toast.textContent = String(message || "操作未完成");
  ui.toast.className = `toast${success ? " success" : ""}`;
  ui.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, 7000);
}

async function invoke(action, payload = {}) {
  if (!state.bridgeReady || !window.pywebview?.api?.invoke) {
    throw new Error("桌面桥接尚未就绪，请稍候重试");
  }
  let response;
  try {
    response = await window.pywebview.api.invoke(action, payload);
  } catch (cause) {
    const error = new Error("桌面连接在返回结果前中断");
    error.resultUncertain = true;
    error.cause = cause;
    throw error;
  }
  if (!response || typeof response.ok !== "boolean") {
    const error = new Error("桌面桥接没有返回可确认的结果");
    error.resultUncertain = true;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(response.error || "桌面操作未完成");
    error.resultUncertain = false;
    throw error;
  }
  return response.result;
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  if (message) ui.activity.textContent = message;
  syncControls();
}

function syncControls() {
  const disabled = state.busy || !state.bridgeReady;
  ui.refreshState.disabled = disabled;
  ui.refreshHistory.disabled = disabled;
  /* RELEASE_EXCLUDE_START: v2 */
  ui.refreshServiceFee.disabled = disabled;
  ui.importOfficialServiceFee.disabled = disabled || state.serviceFeeArchivedView;
  ui.archiveLegacyServiceFee.disabled = disabled || state.serviceFeeArchivedView;
  ui.toggleServiceFeeArchive.disabled = disabled;
  ui.newServiceFee.disabled = disabled || state.serviceFeeArchivedView;
  ui.previewServiceFee.disabled = disabled || state.serviceFeeArchivedView;
  ui.toggleServiceFee.disabled = disabled || state.serviceFeeArchivedView || !state.selectedServiceFeeId;
  for (const button of ui.serviceFeeList.querySelectorAll("button")) {
    button.disabled = disabled || state.serviceFeeArchivedView;
  }
  ui.refreshShipping.disabled = disabled;
  ui.newShippingTemplate.disabled = disabled;
  ui.addShippingRule.disabled = disabled;
  ui.previewShipping.disabled = disabled;
  for (const button of ui.shippingTemplateList.querySelectorAll("button")) button.disabled = disabled;
  for (const control of ui.shippingBindingForm.querySelectorAll("button, select, input")) control.disabled = disabled;
  /* RELEASE_EXCLUDE_END: v2 */
  /* RELEASE_EXCLUDE_START: reviews */
  ui.refreshReviews.disabled = disabled;
  /* RELEASE_EXCLUDE_END: reviews */
  ui.refreshLogs.disabled = disabled;
  ui.openLogs.disabled = disabled;
  ui.startService.disabled = disabled || state.serviceExpected;
  ui.stopService.disabled = disabled || !state.ownsService;
  ui.previewCatalog.disabled = disabled || !state.serviceExpected || !state.files.ordinary || !state.files.combination;
  ui.applyCatalog.disabled = disabled || !state.serviceExpected || !state.catalogPreview?.ready;
  ui.previewMapping.disabled = disabled || !state.serviceExpected || !state.files.mapping || !ui.shopName.value.trim();
  ui.applyMapping.disabled = disabled || !state.serviceExpected || !state.mappingPreview?.ready;
  ui.saveMappingReviews.disabled = disabled || !state.serviceExpected || !state.mappingPreview?.canSaveReviews;
  ui.shopName.disabled = disabled;
  for (const button of document.querySelectorAll(".history-rollback")) {
    button.disabled = disabled || state.rollbackRefreshRequired;
  }
}

function selectPage(pageName) {
  for (const button of document.querySelectorAll(".nav-item")) {
    button.classList.toggle("active", button.dataset.page === pageName);
  }
  for (const page of document.querySelectorAll(".page")) {
    const active = page.id === `page-${pageName}`;
    page.hidden = !active;
    page.classList.toggle("active", active);
    if (active) ui.pageTitle.textContent = page.dataset.title;
  }
  if (pageName === "history" && state.bridgeReady) {
    refreshUpdateHistory();
  }
  /* RELEASE_EXCLUDE_START: v2 */
  if (pageName !== "service-fee") state.serviceFeeCoverageRequest += 1;
  if (pageName === "service-fee" && state.bridgeReady) {
    refreshBasicServiceFees();
  }
  if (pageName === "shipping" && state.bridgeReady) {
    refreshShippingTemplates();
  }
  /* RELEASE_EXCLUDE_END: v2 */
  /* RELEASE_EXCLUDE_START: reviews */
  if (pageName === "reviews" && state.bridgeReady) {
    refreshMappingReviews();
  }
  /* RELEASE_EXCLUDE_END: reviews */
}

function historySummary(entry) {
  if (entry.kind === "catalog") {
    return `启用商品 ${count(entry.enabled_count)} · 普通商品 ${count(entry.ordinary_count)} · 组合商品 ${count(entry.combination_count)}`;
  }
  /* RELEASE_EXCLUDE_START: v2 */
  if (entry.kind === "shipping") {
    return `${entry.shop_name || "未命名店铺"} · ${entry.name || "未命名模板"} · 地区规则 ${count(entry.region_rule_count)}`;
  }
  if (entry.kind === "service_fee") {
    if (entry.operation === "archive_legacy_rates") {
      return `归档 ${count(entry.count)} 条无经营大类旧费率 · 可由最新更新回滚恢复`;
    }
    return `操作 ${entry.operation || "费率更新"} · 规则 ${count(entry.count ?? 1)} 条`;
  }
  /* RELEASE_EXCLUDE_END: v2 */
  return `${entry.shop_name || "未命名店铺"} · 精确匹配 ${count(entry.verified_rows)} · 新增 ${count(entry.inserted_rows)} · 更新 ${count(entry.updated_rows)} · 移除 ${count(entry.removed_rows)} · 待核验 ${count(entry.pending_rows)}`;
}

function renderUpdateHistory(entries) {
  const history = Array.isArray(entries) ? entries : [];
  ui.historyList.replaceChildren();
  ui.historyEmpty.hidden = history.length > 0;
  ui.historyEmpty.textContent = history.length ? "" : "尚无可显示的更新记录。完成首次更新后会在这里按时间出现。";
  for (const entry of history) {
    const item = document.createElement("li");
    item.className = `history-entry${entry.is_latest ? " latest" : ""}${entry.status === "rolled_back" ? " rolled-back" : ""}`;

    const marker = document.createElement("span");
    marker.className = "history-marker";
    marker.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "history-content";
    const heading = document.createElement("div");
    heading.className = "history-heading";
    const title = document.createElement("h3");
    title.textContent = String(entry.title || "更新记录");
    const time = document.createElement("time");
    time.dateTime = String(entry.completed_at || "");
    time.textContent = displayTime(entry.completed_at);
    heading.append(title, time);

    const summary = document.createElement("p");
    summary.textContent = historySummary(entry);
    const labels = document.createElement("div");
    labels.className = "history-labels";
    const kind = document.createElement("span");
    kind.textContent = entry.kind === "catalog" ? "成本商品" : "店铺映射";
    labels.append(kind);
    if (entry.is_latest) {
      const latest = document.createElement("strong");
      latest.textContent = "当前最新";
      labels.append(latest);
    }
    if (entry.status === "rolled_back") {
      const rolledBack = document.createElement("em");
      rolledBack.textContent = "已回滚";
      labels.append(rolledBack);
    }

    const footer = document.createElement("div");
    footer.className = "history-footer";
    footer.append(labels);
    if (entry.can_rollback === true) {
      const rollbackable = document.createElement("strong");
      rollbackable.textContent = "可回滚";
      labels.append(rollbackable);
      const rollback = document.createElement("button");
      rollback.type = "button";
      rollback.className = "button danger history-rollback";
      rollback.textContent = "回滚这次更新";
      rollback.disabled = state.busy || state.rollbackRefreshRequired || !state.bridgeReady;
      rollback.addEventListener("click", () => rollbackUpdate(entry));
      footer.append(rollback);
    }

    content.append(heading, summary, footer);
    item.append(marker, content);
    ui.historyList.append(item);
  }
}

async function refreshUpdateHistory({ reconcile = false } = {}) {
  if (state.busy || !state.bridgeReady) return;
  setBusy(true, "正在读取更新历史……");
  try {
    if (reconcile) {
      renderState(await invoke("get_state", { force_log: true }));
    }
    renderUpdateHistory(await invoke("get_update_history"));
    if (reconcile) state.rollbackRefreshRequired = false;
    ui.activity.textContent = "更新历史已刷新";
  } catch (error) {
    ui.historyList.replaceChildren();
    ui.historyEmpty.hidden = false;
    ui.historyEmpty.textContent = "更新历史暂时无法读取，请稍后重试。";
    ui.activity.textContent = "更新历史读取失败";
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function refreshAfterRollbackAttempt() {
  renderState(await invoke("get_state", { force_log: true }));
  renderUpdateHistory(await invoke("get_update_history"));
}

async function rollbackUpdate(entry) {
  if (state.busy || state.rollbackRefreshRequired || entry?.can_rollback !== true) return;
  const updateId = entry.update_id;
  if (typeof updateId !== "string" || !updateId) return;
  const accepted = await confirmAction(
    "确认回滚最新更新",
    `${entry.title || "这次更新"} · ${displayTime(entry.completed_at)}\n系统会先保存当前完整数据，再复核原备份、哈希和数据库完整性。回滚提交后不能用同一条记录重复执行。`,
    "确认回滚"
  );
  if (!accepted || state.busy) return;

  setBusy(true, "正在复核备份并回滚最新更新……");
  try {
    let result;
    try {
      result = await invoke("rollback_update", { update_id: updateId });
    } catch (error) {
      state.rollbackRefreshRequired = true;
      const uncertain = error.resultUncertain === true;
      const prefix = uncertain ? "回滚结果不明确" : "回滚失败";
      const detail = uncertain
        ? "桌面连接在结果确认前中断。不要重复提交；请先查看运行状态和日志，再点击“刷新记录”核对。"
        : `${error.message}。当前页面已锁定重复提交；请先查看运行状态和日志，再点击“刷新记录”核对。`;
      showResult(ui.historyResult, `${prefix}：${detail}`, true);
      ui.activity.textContent = prefix;
      showToast(`${prefix}，请先核对状态和日志。`);
      try {
        await refreshAfterRollbackAttempt();
      } catch {
        ui.activity.textContent = `${prefix}，自动核对未完成`;
      }
      return;
    }

    let refreshed = true;
    try {
      await refreshAfterRollbackAttempt();
    } catch {
      refreshed = false;
    }
    state.rollbackRefreshRequired = !refreshed;
    const excel = result?.rebuilt_excel ? "，启用商品成本表已同步重建" : "";
    const refreshMessage = refreshed
      ? "状态、历史和日志已刷新。"
      : "但状态、历史和日志刷新未完成。不要重复提交；请先查看日志，再点击“刷新记录”核对。";
    showResult(
      ui.historyResult,
      `回滚完成：${entry.title || "最新更新"}已恢复。当前数据的恢复备份：${result?.recovery_backup_file || "已创建"}${excel}。${refreshMessage}`,
      !refreshed
    );
    ui.activity.textContent = refreshed
      ? "回滚完成，状态、历史和日志已刷新"
      : "回滚完成，但自动刷新未完成";
    showToast(
      refreshed
        ? "最新更新已安全回滚，状态、历史和日志已刷新。"
        : "回滚已完成，但刷新未完成，请先核对状态和日志。",
      refreshed
    );
  } finally {
    setBusy(false);
  }
}

/* RELEASE_EXCLUDE_START: v2 */
function localDateText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fillServiceFeeForm(version = null) {
  const current = version || {};
  state.selectedServiceFeeId = version ? Number(current.id) : null;
  ui.serviceFeeSourceId.value = current.id ?? "";
  ui.serviceFeeMajorCategory.value = current.major_category ?? "";
  ui.serviceFeeCategories.forEach((input, index) => {
    input.value = current.category_levels?.[index] ?? "";
  });
  ui.serviceFeeRate.value = current.rate ?? "";
  ui.serviceFeeSpecialRate.value = current.special_channel_rate ?? "";
  ui.serviceFeeEffective.value = version ? "" : localDateText();
  ui.serviceFeeNote.value = current.note ?? "";
  ui.serviceFeeFormTitle.textContent = version
    ? `基于版本 #${current.id} 新建`
    : "新建基础服务费版本";
  ui.toggleServiceFee.textContent = current.enabled === false ? "启用所选版本" : "停用所选版本";
  ui.toggleServiceFee.classList.toggle("danger", current.enabled !== false);
  ui.toggleServiceFee.classList.toggle("secondary", current.enabled === false);
  ui.serviceFeeProgress.textContent = version
    ? "已复制旧版本内容。请选择新的生效日期后预览；原版本不会被覆盖。"
    : "填写完整四级类目、费率和生效日期后先预览。";
  ui.serviceFeeResult.hidden = true;
  for (const button of ui.serviceFeeList.querySelectorAll(".service-fee-version")) {
    button.classList.toggle("active", Number(button.dataset.rateId) === state.selectedServiceFeeId);
  }
  syncControls();
  ui.serviceFeeMajorCategory.focus();
}

function renderServiceFeeDirectory() {
  const major = ui.serviceFeeMajorFilter.value;
  const rate = ui.serviceFeeRateFilter.value;
  const query = ui.serviceFeeSearch.value.trim().toLocaleLowerCase("zh-CN");
  const visible = state.serviceFeeRates.filter((version) => {
    const path = [version.major_category, ...(version.category_levels || [])].join(" ").toLocaleLowerCase("zh-CN");
    return (!major || version.major_category === major)
      && (!rate || version.rate === rate)
      && (!query || path.includes(query));
  });
  ui.serviceFeeList.replaceChildren();
  ui.serviceFeeEmpty.hidden = visible.length > 0;
  ui.serviceFeeEmpty.textContent = state.serviceFeeRates.length
    ? "没有符合筛选条件的费率规则。"
    : state.serviceFeeArchivedView
      ? "还没有归档的基础服务费版本。"
      : "还没有费率版本。可先导入内置官方目录。";
  const groupCounts = visible.reduce((result, version) => {
    const key = version.major_category || "未配置经营大类";
    result.set(key, (result.get(key) || 0) + 1);
    return result;
  }, new Map());
  const groups = new Map();
  for (const version of visible) {
    const majorName = version.major_category || "未配置经营大类";
    if (!groups.has(majorName)) {
      const details = document.createElement("details");
      details.className = "service-fee-major-group";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = `${majorName} · ${count(groupCounts.get(majorName))} 条`;
      const entries = document.createElement("div");
      entries.className = "service-fee-major-entries";
      details.append(summary, entries);
      ui.serviceFeeList.append(details);
      groups.set(majorName, entries);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `service-fee-version${version.enabled ? "" : " disabled"}`;
    button.dataset.rateId = String(version.id);
    const category = document.createElement("strong");
    const detail = document.createElement("span");
    const status = document.createElement("em");
    category.textContent = `${version.major_category || "未配置大类"} · ${version.category_levels.join(" › ")}`;
    const coverage = version.product_coverage_count == null
      ? "覆盖统计中"
      : `覆盖 ${count(version.product_coverage_count)} 个商品`;
    detail.textContent = `${version.effective_from} 起 · 基础 ${(Number(version.rate) * 100).toFixed(2).replace(/\.00$/, "")}% · ${coverage}`;
    const source = version.source_article_id ? `官方 ${displayTime(version.source_updated_at)}` : (version.note || "人工版本");
    status.textContent = `${version.archived ? `已归档 ${displayTime(version.archived_at)}` : (version.enabled ? "已启用" : "已停用")} · ${version.specificity}/4 级具体 · ${source}`;
    button.append(category, detail, status);
    if (!state.serviceFeeArchivedView) {
      button.addEventListener("click", () => fillServiceFeeForm(version));
    }
    groups.get(majorName).append(button);
  }
  syncControls();
}

function renderBasicServiceFees(rates) {
  state.serviceFeeRates = Array.isArray(rates) ? rates : [];
  const majors = [...new Set(state.serviceFeeRates.map((item) => item.major_category).filter(Boolean))].sort();
  const ratesSeen = [...new Set(state.serviceFeeRates.map((item) => item.rate).filter(Boolean))]
    .sort((left, right) => Number(left) - Number(right));
  const selectedMajor = ui.serviceFeeMajorFilter.value;
  const selectedRate = ui.serviceFeeRateFilter.value;
  ui.serviceFeeMajorFilter.replaceChildren(new Option("全部经营大类", ""), ...majors.map((value) => new Option(value, value)));
  ui.serviceFeeRateFilter.replaceChildren(new Option("全部费率", ""), ...ratesSeen.map((value) => new Option(`${Number(value) * 100}%`, value)));
  ui.serviceFeeMajorFilter.value = majors.includes(selectedMajor) ? selectedMajor : "";
  ui.serviceFeeRateFilter.value = ratesSeen.includes(selectedRate) ? selectedRate : "";
  renderServiceFeeDirectory();
}

async function refreshBasicServiceFees() {
  if (state.busy || !state.bridgeReady) return;
  const requestId = ++state.serviceFeeCoverageRequest;
  let directoryLoaded = false;
  setBusy(true, "正在读取基础服务费版本……");
  try {
    renderBasicServiceFees(await invoke("get_basic_service_fee_rates", {
      archived: state.serviceFeeArchivedView
    }));
    directoryLoaded = true;
    ui.activity.textContent = state.serviceFeeArchivedView
      ? "基础服务费归档已刷新"
      : "基础服务费版本已刷新";
  } catch (error) {
    ui.serviceFeeList.replaceChildren();
    ui.serviceFeeEmpty.hidden = false;
    ui.serviceFeeEmpty.textContent = "基础服务费版本暂时无法读取，请稍后重试。";
    showToast(error.message);
  } finally {
    setBusy(false);
  }
  if (directoryLoaded && !state.serviceFeeArchivedView) {
    await loadBasicServiceFeeCoverage(requestId);
  }
}

async function loadBasicServiceFeeCoverage(
  requestId = ++state.serviceFeeCoverageRequest
) {
  if (state.serviceFeeArchivedView) return;
  ui.activity.textContent = "费率目录已可操作，正在统计商品覆盖……";
  try {
    const coverage = await invoke("get_basic_service_fee_coverage");
    if (requestId !== state.serviceFeeCoverageRequest || state.serviceFeeArchivedView) return;
    const counts = new Map(
      (Array.isArray(coverage) ? coverage : []).map((item) => [
        Number(item.rate_id), Number(item.product_coverage_count)
      ])
    );
    state.serviceFeeRates = state.serviceFeeRates.map((item) => ({
      ...item,
      product_coverage_count: counts.get(Number(item.id)) ?? 0
    }));
    renderServiceFeeDirectory();
    ui.activity.textContent = "基础服务费目录和商品覆盖已刷新";
  } catch {
    if (requestId === state.serviceFeeCoverageRequest) {
      ui.activity.textContent = "费率目录已加载；商品覆盖统计稍后重试";
    }
  }
}

async function toggleServiceFeeArchiveView() {
  if (state.busy || !state.bridgeReady) return;
  state.serviceFeeArchivedView = !state.serviceFeeArchivedView;
  state.selectedServiceFeeId = null;
  ui.toggleServiceFeeArchive.textContent = state.serviceFeeArchivedView
    ? "返回生效版本"
    : "查看归档";
  await refreshBasicServiceFees();
}

async function archiveLegacyServiceFeeRates() {
  if (state.busy || !state.bridgeReady || state.serviceFeeArchivedView) return;
  setBusy(true, "正在核对无经营大类旧费率……");
  try {
    const preview = await invoke("preview_legacy_service_fee_archive");
    if (Number(preview.referenced_product_count) > 0) {
      throw new Error(`旧费率仍被 ${count(preview.referenced_product_count)} 个商品匹配，不能归档。`);
    }
    if (Number(preview.archive_count) === 0) {
      showToast("没有需要归档的无经营大类旧费率。", true);
      return;
    }
    setBusy(false, "旧费率归档预览完成，等待确认");
    const accepted = await confirmAction(
      "确认归档旧基础服务费",
      `将归档 ${count(preview.archive_count)} 条经营大类为空的旧费率。归档后它们不再出现在生效目录或参与匹配，但记录和事件会保留，并会先创建恢复备份。`,
      "确认归档"
    );
    if (!accepted) return;
    setBusy(true, "正在备份并归档旧基础服务费……");
    const result = await invoke("apply_legacy_service_fee_archive", {
      preview_id: preview.preview_id
    });
    renderBasicServiceFees(await invoke("get_basic_service_fee_rates"));
    void loadBasicServiceFeeCoverage();
    showResult(
      ui.serviceFeeResult,
      `已归档 ${count(result.count)} 条旧费率。恢复备份：${result.backup_file}。可在“查看归档”中核对。`
    );
    showToast(`已归档 ${count(result.count)} 条旧费率。`, true);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
    try { await refreshState(true, true); } catch { /* Scheduled refresh will retry. */ }
  }
}

async function importOfficialServiceFeeCatalog() {
  if (state.busy || !state.bridgeReady) return;
  setBusy(true, "正在预览内置官方费率目录……");
  try {
    const preview = await invoke("preview_official_service_fee_catalog");
    setBusy(false, "官方目录预览完成，等待确认");
    const accepted = await confirmAction(
      "确认导入抖店官方费率目录",
      `${preview.source_name}\n官方更新时间：${displayTime(preview.source_updated_at)}\n生效日期：${preview.effective_from}\n共 ${count(preview.rule_count)} 条规则。确认后会先备份成本库；重复导入同一版本不会重复写入。`,
      "确认导入"
    );
    if (!accepted) return;
    setBusy(true, "正在备份并导入官方费率目录……");
    const result = await invoke("apply_official_service_fee_catalog", { preview_id: preview.preview_id });
    renderBasicServiceFees(await invoke("get_basic_service_fee_rates"));
    void loadBasicServiceFeeCoverage();
    const message = result.status === "unchanged"
      ? `该官方版本已经导入，共 ${count(result.count)} 条，无需重复写入。`
      : `已导入 ${count(result.count)} 条官方规则。恢复备份：${result.backup_file}。`;
    showResult(ui.serviceFeeResult, message);
    showToast(message, true);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
    try { await refreshState(true, true); } catch { /* Scheduled refresh will retry. */ }
  }
}

function collectBasicServiceFeeVersion() {
  return {
    operation: "create_version",
    major_category: ui.serviceFeeMajorCategory.value.trim(),
    category_levels: ui.serviceFeeCategories.map((input) => input.value.trim()),
    rate: ui.serviceFeeRate.value.trim(),
    special_channel_rate: ui.serviceFeeSpecialRate.value.trim() || null,
    effective_from: ui.serviceFeeEffective.value,
    note: ui.serviceFeeNote.value.trim()
  };
}

async function saveBasicServiceFeeVersion(event) {
  event.preventDefault();
  if (state.busy || !state.bridgeReady || !ui.serviceFeeForm.reportValidity()) return;
  setBusy(true, "正在预览基础服务费版本……");
  try {
    const preview = await invoke("preview_basic_service_fee_change", collectBasicServiceFeeVersion());
    setBusy(false, "基础服务费预览完成，等待确认");
    const accepted = await confirmAction(
      "确认新增基础服务费版本",
      `${preview.category_levels.join(" › ")}\n${preview.effective_from} 起，费率 ${preview.rate}。\n备注：${preview.note || "无"}。确认后会保留旧版本并先创建恢复备份。`,
      "确认新增版本"
    );
    if (!accepted) {
      ui.serviceFeeProgress.textContent = "已取消保存；费率版本没有变化。";
      return;
    }
    setBusy(true, "正在备份并新增基础服务费版本……");
    const result = await invoke("apply_basic_service_fee_change", { preview_id: preview.preview_id });
    renderBasicServiceFees(await invoke("get_basic_service_fee_rates"));
    void loadBasicServiceFeeCoverage();
    const saved = state.serviceFeeRates.find((item) => Number(item.id) === Number(result.rate_id));
    if (saved) fillServiceFeeForm(saved);
    showResult(ui.serviceFeeResult, `基础服务费版本已新增。恢复备份：${result.backup_file}。`);
    ui.serviceFeeProgress.textContent = "新增完成；旧版本仍保留。";
    showToast("基础服务费版本已新增。", true);
  } catch (error) {
    ui.serviceFeeProgress.textContent = "版本没有保存，请按提示修正后重新预览。";
    showToast(error.message);
  } finally {
    setBusy(false);
    try { await refreshState(true, true); } catch { /* Scheduled refresh will retry. */ }
  }
}

async function toggleBasicServiceFeeVersion() {
  if (state.busy || !state.bridgeReady || !state.selectedServiceFeeId) return;
  const selected = state.serviceFeeRates.find((item) => Number(item.id) === state.selectedServiceFeeId);
  if (!selected) return;
  const enabled = !selected.enabled;
  setBusy(true, `正在预览${enabled ? "启用" : "停用"}操作……`);
  try {
    const preview = await invoke("preview_basic_service_fee_change", {
      operation: "set_enabled", rate_id: selected.id, enabled
    });
    setBusy(false, "启停预览完成，等待确认");
    const accepted = await confirmAction(
      `确认${enabled ? "启用" : "停用"}基础服务费版本`,
      `${selected.category_levels.join(" › ")}\n版本 #${selected.id} · ${selected.effective_from} · 费率 ${selected.rate}。确认后会先创建恢复备份。`,
      `确认${enabled ? "启用" : "停用"}`
    );
    if (!accepted) return;
    setBusy(true, `正在备份并${enabled ? "启用" : "停用"}版本……`);
    const result = await invoke("apply_basic_service_fee_change", { preview_id: preview.preview_id });
    renderBasicServiceFees(await invoke("get_basic_service_fee_rates"));
    void loadBasicServiceFeeCoverage();
    const changed = state.serviceFeeRates.find((item) => Number(item.id) === Number(result.rate_id));
    if (changed) fillServiceFeeForm(changed);
    showResult(ui.serviceFeeResult, `版本已${enabled ? "启用" : "停用"}。恢复备份：${result.backup_file}。`);
    showToast(`基础服务费版本已${enabled ? "启用" : "停用"}。`, true);
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
    try { await refreshState(true, true); } catch { /* Scheduled refresh will retry. */ }
  }
}

function shippingRuleRow(rule = {}) {
  const row = document.createElement("div");
  row.className = "shipping-rule";
  const field = (labelText, className, value, placeholder) => {
    const label = document.createElement("label");
    const text = document.createElement("span");
    const input = document.createElement("input");
    text.textContent = labelText;
    input.className = className;
    input.value = String(value ?? "");
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.required = true;
    if (className !== "shipping-rule-region") input.inputMode = "decimal";
    label.append(text, input);
    return label;
  };
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "shipping-remove";
  remove.textContent = "移除";
  remove.addEventListener("click", () => row.remove());
  row.append(
    field("地区", "shipping-rule-region", rule.region, "例如：北京市"),
    field("首费 / 元", "shipping-rule-first-fee", rule.first_fee ?? "0", "0"),
    field("续费 / 元", "shipping-rule-additional-fee", rule.additional_fee ?? "0", "0"),
    remove
  );
  return row;
}

function updateShippingCostPreview() {
  const weight = Number(ui.shippingPreviewWeight.value);
  const firstWeight = Number(ui.shippingFirstWeight.value);
  const additionalWeight = Number(ui.shippingAdditionalWeight.value);
  const region = ui.shippingPreviewRegion.value.trim();
  const rule = Array.from(ui.shippingRuleList.querySelectorAll(".shipping-rule")).find(
    (row) => row.querySelector(".shipping-rule-region").value.trim() === region && region
  );
  const firstFee = Number(rule
    ? rule.querySelector(".shipping-rule-first-fee").value
    : ui.shippingFirstFee.value);
  const additionalFee = Number(rule
    ? rule.querySelector(".shipping-rule-additional-fee").value
    : ui.shippingAdditionalFee.value);
  if (![weight, firstWeight, additionalWeight, firstFee, additionalFee].every(Number.isFinite)
      || weight <= 0 || firstWeight <= 0 || additionalWeight <= 0
      || firstFee < 0 || additionalFee < 0) {
    ui.shippingPreviewCost.textContent = "填写有效重量和价格后显示试算";
    return;
  }
  const steps = weight > firstWeight ? Math.ceil((weight - firstWeight) / additionalWeight) : 0;
  const fee = firstFee + steps * additionalFee;
  ui.shippingPreviewCost.textContent = `预计内部运费 ${fee.toFixed(2).replace(/\.00$/, "")} 元 · ${rule ? `${region}特殊价格` : "基础规则"}`;
}

function fillShippingForm(template = null) {
  const current = template || {};
  ui.shippingTemplateId.value = current.id ?? "";
  ui.shippingName.value = current.name ?? "";
  ui.shippingFirstWeight.value = current.first_weight ?? "1";
  ui.shippingFirstFee.value = current.first_fee ?? "3";
  ui.shippingAdditionalWeight.value = current.additional_weight ?? "1";
  ui.shippingAdditionalFee.value = current.additional_fee ?? "1";
  ui.shippingEnabled.checked = current.enabled !== false;
  ui.shippingFormTitle.textContent = template ? `编辑：${current.name}` : "新建重量模板";
  ui.shippingRuleList.replaceChildren();
  for (const rule of Array.isArray(current.region_rules) ? current.region_rules : []) {
    ui.shippingRuleList.append(shippingRuleRow(rule));
  }
  updateShippingCostPreview();
  ui.shippingResult.hidden = true;
  ui.shippingProgress.textContent = template
    ? "已载入模板。修改后先预览，再确认保存。"
    : "填写模板后先预览，本页不会自动保存。";
  for (const button of ui.shippingTemplateList.querySelectorAll(".shipping-template")) {
    button.classList.toggle("active", Number(button.dataset.templateId) === Number(current.id));
  }
  ui.shippingName.focus();
}

function renderShippingTemplates(templates) {
  state.shippingTemplates = Array.isArray(templates) ? templates : [];
  ui.shippingTemplateList.replaceChildren();
  ui.shippingEmpty.hidden = state.shippingTemplates.length > 0;
  for (const template of state.shippingTemplates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `shipping-template${template.enabled ? "" : " disabled"}`;
    button.dataset.templateId = String(template.id);
    const name = document.createElement("strong");
    const detail = document.createElement("span");
    const status = document.createElement("em");
    name.textContent = template.name;
    detail.textContent = `${template.first_weight} kg / ${template.first_fee} 元起 · 续重 ${template.additional_weight} kg / ${template.additional_fee} 元`;
    status.textContent = `${template.enabled ? "使用中" : "已停用"} · ${count(template.product_count)} 个商品 · ${count(template.region_rules?.length)} 条特殊地区`;
    button.append(name, detail, status);
    button.addEventListener("click", () => fillShippingForm(template));
    ui.shippingTemplateList.append(button);
  }
  syncControls();
}

function renderShippingProductChoices() {
  const shop = ui.shippingBindingShop.value;
  ui.shippingProductList.replaceChildren();
  const products = shippingFilters.filterShippingProducts(state.shippingProducts, {
    shop,
    status: ui.shippingBindingStatus.value,
    query: ui.shippingBindingSearch.value
  });
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "shipping-empty";
    const shopProducts = state.shippingProducts.filter((item) => item.shop_name === shop);
    empty.textContent = shopProducts.length
      ? "没有符合当前状态和搜索条件的商品。"
      : "该店铺还没有已验证的抖店商品映射。";
    ui.shippingProductList.append(empty);
    return;
  }
  for (const product of products) {
    const label = document.createElement("label");
    label.className = `shipping-product${product.template_id ? " bound" : " unbound"}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = product.douyin_product_id;
    const content = document.createElement("span");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = product.product_name || product.douyin_product_id;
    const template = state.shippingTemplates.find((item) => Number(item.id) === Number(product.template_id));
    detail.textContent = `${product.douyin_product_id} · ${count(product.sku_count)} 个 SKU · ${template ? `当前：${template.name}` : "未绑定"}`;
    content.append(title, detail);
    label.append(checkbox, content);
    ui.shippingProductList.append(label);
  }
}

function renderShippingBindings(payload) {
  state.shippingProducts = Array.isArray(payload?.products) ? payload.products : [];
  ui.shippingUnboundCount.textContent = `${count(payload?.unbound_count)} 个商品未绑定`;
  const selectedShop = ui.shippingBindingShop.value;
  const selectedTemplate = ui.shippingBindingTemplate.value;
  const shops = [...new Set(state.shippingProducts.map((item) => item.shop_name).filter(Boolean))].sort();
  ui.shippingBindingShop.replaceChildren(...shops.map((value) => new Option(value, value)));
  ui.shippingBindingTemplate.replaceChildren(
    ...state.shippingTemplates.filter((item) => item.enabled).map((item) => new Option(`${item.name} · ${count(item.product_count)} 个商品`, String(item.id)))
  );
  if (shops.includes(selectedShop)) ui.shippingBindingShop.value = selectedShop;
  if (state.shippingTemplates.some((item) => String(item.id) === selectedTemplate && item.enabled)) {
    ui.shippingBindingTemplate.value = selectedTemplate;
  }
  renderShippingProductChoices();
}

async function saveShippingProductBindings(event) {
  event.preventDefault();
  if (state.busy || !state.bridgeReady || !ui.shippingBindingForm.reportValidity()) return;
  const productIds = Array.from(
    ui.shippingProductList.querySelectorAll('input[type="checkbox"]:checked'),
    (input) => input.value
  );
  if (!productIds.length) {
    showToast("请至少选择一个要绑定的商品");
    return;
  }
  setBusy(true, "正在预览商品运费模板绑定……");
  try {
    const preview = await invoke("preview_shipping_product_bindings", {
      shop_name: ui.shippingBindingShop.value,
      template_id: Number(ui.shippingBindingTemplate.value),
      douyin_product_ids: productIds
    });
    const template = state.shippingTemplates.find((item) => Number(item.id) === Number(preview.template_id));
    setBusy(false, "商品绑定预览完成，等待确认");
    const accepted = await confirmAction(
      "确认绑定商品运费模板",
      `${preview.shop_name}\n${count(preview.douyin_product_ids.length)} 个商品将统一使用“${template?.name || preview.template_id}”。同一商品下全部 SKU 共用该模板。确认后会先创建恢复备份。`,
      "确认绑定"
    );
    if (!accepted) return;
    setBusy(true, "正在备份并绑定商品……");
    const result = await invoke("apply_shipping_product_bindings", { preview_id: preview.preview_id });
    renderShippingTemplates(await invoke("get_shipping_templates"));
    renderShippingBindings(await invoke("get_shipping_product_bindings"));
    ui.shippingBindingProgress.textContent = `已绑定 ${count(result.product_count)} 个商品；恢复备份：${result.backup_file}。`;
    showToast("商品运费模板绑定完成。", true);
  } catch (error) {
    ui.shippingBindingProgress.textContent = "商品没有绑定，请按提示修正后重试。";
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function refreshShippingTemplates() {
  if (state.busy || !state.bridgeReady) return;
  setBusy(true, "正在读取运费模板……");
  try {
    renderShippingTemplates(await invoke("get_shipping_templates"));
    renderShippingBindings(await invoke("get_shipping_product_bindings"));
    ui.activity.textContent = "运费模板已刷新";
  } catch (error) {
    ui.shippingTemplateList.replaceChildren();
    ui.shippingEmpty.hidden = false;
    ui.shippingEmpty.textContent = "运费模板暂时无法读取，请稍后重试。";
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

function collectShippingTemplate() {
  const templateId = Number(ui.shippingTemplateId.value);
  return {
    template_id: Number.isInteger(templateId) && templateId > 0 ? templateId : null,
    name: ui.shippingName.value.trim(),
    shop_name: "",
    default_region: "",
    first_weight: ui.shippingFirstWeight.value.trim(),
    first_fee: ui.shippingFirstFee.value.trim(),
    additional_weight: ui.shippingAdditionalWeight.value.trim(),
    additional_fee: ui.shippingAdditionalFee.value.trim(),
    is_default: false,
    enabled: ui.shippingEnabled.checked,
    region_rules: Array.from(ui.shippingRuleList.querySelectorAll(".shipping-rule"), (row) => ({
      region: row.querySelector(".shipping-rule-region").value.trim(),
      first_fee: row.querySelector(".shipping-rule-first-fee").value.trim(),
      additional_fee: row.querySelector(".shipping-rule-additional-fee").value.trim(),
      free_shipping: false
    }))
  };
}

async function saveShippingTemplate(event) {
  event.preventDefault();
  if (state.busy || !state.bridgeReady || !ui.shippingForm.reportValidity()) return;
  setBusy(true, "正在预览运费模板……");
  try {
    const preview = await invoke("preview_shipping_template", collectShippingTemplate());
    setBusy(false, "运费模板预览完成，等待确认");
    const accepted = await confirmAction(
      preview.mode === "create" ? "确认新建运费模板" : "确认修改运费模板",
      `${preview.name}\n首重 ${preview.first_weight} kg / ${preview.first_fee} 元；每续重 ${preview.additional_weight} kg / ${preview.additional_fee} 元。\n特殊地区：${count(preview.region_rules.length)} 条。确认后会先创建恢复备份。`,
      preview.mode === "create" ? "确认新建" : "确认修改"
    );
    if (!accepted) {
      ui.shippingProgress.textContent = "已取消保存；当前模板没有变化。";
      return;
    }
    setBusy(true, "正在备份并保存运费模板……");
    ui.activity.textContent = "正在备份并保存运费模板……";
    const result = await invoke("apply_shipping_template", { preview_id: preview.preview_id });
    renderShippingTemplates(await invoke("get_shipping_templates"));
    const saved = state.shippingTemplates.find((item) => Number(item.id) === Number(result.template_id));
    if (saved) fillShippingForm(saved);
    showResult(ui.shippingResult, `运费模板已${result.mode === "create" ? "新建" : "修改"}。恢复备份：${result.backup_file}。`);
    ui.shippingProgress.textContent = "保存完成；再次修改前会重新预览。";
    showToast("运费模板已保存。", true);
  } catch (error) {
    ui.shippingProgress.textContent = "模板没有保存，请按提示修正后重新预览。";
    showToast(error.message);
  } finally {
    setBusy(false);
    try { await refreshState(true, true); } catch { /* Scheduled refresh will retry. */ }
  }
}
/* RELEASE_EXCLUDE_END: v2 */

/* RELEASE_EXCLUDE_START: reviews */
function reviewText(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  return node;
}

function renderMappingReviews(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  ui.reviewTotal.textContent = count(payload?.total_open);
  ui.reviewList.replaceChildren();
  ui.reviewEmpty.hidden = items.length > 0;
  ui.reviewEmpty.textContent = items.length ? "" : "当前没有待核验或冲突项。新的店铺表会在确认更新或单独保存后进入这里。";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = `review-card ${item.reason === "conflict" ? "conflict" : "pending"}`;
    const head = reviewText("div", "review-card-head", "");
    head.append(reviewText("span", "review-reason", item.reason === "conflict" ? "跨店冲突" : "待核验"));
    const title = reviewText("div", "review-title", "");
    title.append(reviewText("strong", "", item.product_name || "未命名商品"));
    const majorLabel = item.major_category || item.major_category_unconfigured_reason || "经营大类未配置";
    title.append(reviewText("small", "", `${item.specification || "无规格说明"} · 经营大类：${majorLabel} · 来源 ${item.source_file} 第 ${item.source_row} 行`));
    head.append(title, reviewText("span", "review-shop", item.shop_name));

    const route = reviewText("div", "review-route", "");
    const incoming = reviewText("div", "", "");
    incoming.append(reviewText("span", "", "抖店表中的关系"));
    incoming.append(reviewText("strong", "", `SKUID ${item.douyin_sku_id} / 商家编码 ${item.merchant_sku_code}`));
    const current = reviewText("div", "", "");
    current.append(reviewText("span", "", item.current_shop_name ? "当前已登记关系" : "当前状态"));
    current.append(reviewText("strong", "", item.current_shop_name
      ? `${item.current_shop_name} / ${item.current_jushuitan_sku_id}`
      : "尚无可用映射"));
    route.append(incoming, reviewText("b", "review-arrow", "→"), current);

    const action = reviewText("div", "review-action", "");
    const label = reviewText("label", "", "确认后的聚水潭商品编码");
    const input = document.createElement("input");
    input.maxLength = 200;
    input.autocomplete = "off";
    input.placeholder = `原表编码：${item.merchant_sku_code}`;
    if (item.reason === "conflict") input.value = item.merchant_sku_code;
    label.append(input);
    const button = reviewText("button", "button primary", "确认这一条关联");
    button.type = "button";
    button.addEventListener("click", async () => {
      const targetSku = input.value.trim();
      if (!targetSku) {
        showToast("请输入确认后的聚水潭商品编码");
        input.focus();
        return;
      }
      const transfer = item.current_shop_name && item.current_shop_name !== item.shop_name
        ? `当前属于“${item.current_shop_name}”，确认后会改归“${item.shop_name}”。\n`
        : "";
      if (!await confirmAction(
        "确认一条人工映射",
        `${transfer}抖店 SKUID：${item.douyin_sku_id}\n聚水潭编码：${targetSku}\n系统会复核原映射并先创建恢复备份。`,
        "确认关联"
      )) return;
      await runAction(
        "正在复核并保存人工映射……",
        () => invoke("resolve_mapping_review", {
          candidate_id: Number(item.id),
          jushuitan_sku_id: targetSku
        }),
        async (result) => {
          showToast(`${result.shop_name} 的 SKUID ${result.douyin_sku_id} 已关联到 ${result.jushuitan_sku_id}`, true);
          renderMappingReviews(await invoke("get_mapping_reviews"));
        }
      );
    });
    action.append(label, button);
    card.append(head, route, action);
    ui.reviewList.append(card);
  }
}

async function refreshMappingReviews() {
  if (state.busy || !state.bridgeReady) return;
  setBusy(true, "正在读取待处理映射……");
  try {
    renderMappingReviews(await invoke("get_mapping_reviews"));
    ui.activity.textContent = "待处理映射已刷新";
  } catch (error) {
    ui.reviewList.replaceChildren();
    ui.reviewEmpty.hidden = false;
    ui.reviewEmpty.textContent = "待处理映射暂时无法读取，请稍后重试。";
    ui.activity.textContent = "待处理映射读取失败";
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}
/* RELEASE_EXCLUDE_END: reviews */

function renderState(snapshot) {
  const health = snapshot?.health;
  state.serviceExpected = snapshot?.expected === true;
  state.ownsService = snapshot?.owns_service === true;
  const serviceMode = refreshModel.serviceMode(snapshot);
  ui.servicePill.className = "service-pill";
  if (serviceMode === "running") {
    ui.servicePill.classList.add("ready");
    ui.serviceStatus.textContent = "成本服务已就绪";
    const environment = health.environment === "test" ? "测试数据" : "正式数据";
    const ownership = state.ownsService ? "本窗口管理" : "已接管现有实例";
    ui.serviceDetail.textContent = `${environment} · ${ownership} · 127.0.0.1:${snapshot.port} · 数据库：${snapshot.database_path}`;
    ui.environment.textContent = environment;
    ui.products.textContent = count(health.enabled_count);
    ui.mappings.textContent = count(health.verified_mapping_count);
    ui.updated.textContent = displayTime(health.last_successful_sync);
    ui.knownShops.replaceChildren();
    for (const shop of Array.isArray(health.mapping_shops) ? health.mapping_shops : []) {
      if (typeof shop !== "string" || !shop.trim()) continue;
      const option = document.createElement("option");
      option.value = shop;
      ui.knownShops.append(option);
    }
  } else if (serviceMode === "foreign") {
    ui.servicePill.classList.add("attention");
    ui.serviceStatus.textContent = "端口被其他服务占用";
    ui.serviceDetail.textContent = `环境或数据目录不一致，已停止自动接管 · 数据库：${snapshot.database_path}`;
    ui.environment.textContent = "需处理";
    ui.products.textContent = "—";
    ui.mappings.textContent = "—";
    ui.updated.textContent = "—";
  } else {
    ui.servicePill.classList.add("blocked");
    ui.serviceStatus.textContent = "成本服务未运行";
    ui.serviceDetail.textContent = `可在运行概览中启动本机服务 · 数据库：${snapshot.database_path}`;
    ui.environment.textContent = "—";
    ui.products.textContent = "—";
    ui.mappings.textContent = "—";
    ui.updated.textContent = "—";
  }
  if (typeof snapshot?.log === "string") {
    ui.logContent.textContent = snapshot.log;
    ui.logContent.scrollTop = ui.logContent.scrollHeight;
  }
  syncControls();
}

async function refreshState(forceLog = false, quiet = false) {
  if (state.refreshing) {
    try { await state.refreshPromise; } catch { /* The caller below decides whether to retry. */ }
    return forceLog ? refreshState(true, quiet) : false;
  }
  state.refreshing = true;
  state.refreshPromise = (async () => {
    if (!quiet) ui.activity.textContent = "正在刷新运行状态……";
    try {
      renderState(await invoke("get_state", { force_log: forceLog }));
      if (!quiet) ui.activity.textContent = "运行状态已刷新";
      else if (state.lastRefreshFailed) ui.activity.textContent = "自动状态刷新已恢复";
      state.lastRefreshFailed = false;
      return true;
    } catch (error) {
      state.lastRefreshFailed = true;
      if (!quiet) showToast(error.message);
      throw error;
    }
  })();
  try {
    return await state.refreshPromise;
  } finally {
    state.refreshing = false;
    state.refreshPromise = null;
  }
}

async function runAction(description, work, success) {
  if (state.busy) return;
  setBusy(true, description);
  try {
    const result = await work();
    await success(result);
    ui.activity.textContent = "操作完成";
  } catch (error) {
    ui.activity.textContent = "操作未完成，请按提示处理";
    showToast(error.message);
  } finally {
    setBusy(false);
    try {
      await refreshState(true, true);
    } catch {
      ui.activity.textContent = "状态刷新失败，后台会继续重试";
    }
  }
}

async function runServiceAction(action, progress) {
  if (state.busy) return;
  setBusy(true, progress);
  ui.servicePill.className = "service-pill checking";
  ui.serviceStatus.textContent = progress.replace(/……$/, "");
  ui.serviceDetail.textContent = "操作完成后会立即重新读取健康状态";
  try {
    const result = await invoke(action);
    await refreshState(true, true);
    const message = action === "start_service"
      ? refreshModel.startFeedback(result)
      : "本窗口管理的服务已停止，状态已经刷新。";
    ui.activity.textContent = message;
    showToast(message, true);
  } catch (error) {
    try { await refreshState(true, true); } catch { /* The scheduled loop will retry. */ }
    ui.activity.textContent = `${progress.replace(/……$/, "")}未完成`;
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

function invalidateCatalogPreview() {
  state.catalogPreview = null;
  ui.catalogPreview.hidden = true;
  ui.catalogResult.hidden = true;
  ui.catalogProgress.textContent = "文件已变化，请重新只读预览。";
  syncControls();
}

function invalidateMappingPreview() {
  state.mappingPreview = null;
  ui.mappingPreview.hidden = true;
  ui.mappingResult.hidden = true;
  ui.mappingProgress.textContent = "店铺或文件已变化，请重新只读预览。";
  syncControls();
}

async function chooseFile(kind) {
  if (state.busy) return;
  try {
    const selected = await invoke("choose_file", { kind });
    if (!selected) return;
    state.files[kind] = selected;
    ({ ordinary: ui.ordinaryName, combination: ui.combinationName, mapping: ui.mappingName })[kind].textContent = selected.name;
    if (kind === "mapping") invalidateMappingPreview();
    else invalidateCatalogPreview();
  } catch (error) {
    showToast(error.message);
  }
}

function showResult(target, message, error = false) {
  target.hidden = false;
  target.className = `result-box${error ? " error" : ""}`;
  target.textContent = message;
}

function renderCatalogPreview(result) {
  const conflicts = Array.isArray(result.conflicting_overlaps) ? result.conflicting_overlaps : [];
  const costMismatches = Array.isArray(result.combination_cost_mismatches) ? result.combination_cost_mismatches : [];
  const ready = result.ready_to_import === true;
  state.catalogPreview = ready ? { id: result.preview_id, ready: true } : null;
  ui.catalogPreview.hidden = false;
  ui.catalogPreview.className = `preview-card${ready ? "" : " blocked"}`;
  ui.catalogPreviewTitle.textContent = ready ? "两份商品表可以安全更新" : "检查已拦截本次更新";
  ui.catalogPreviewGuidance.textContent = ready ? "预览期间没有修改当前成本库。" : "当前成本库保持不变，请先解决提示问题。";
  ui.catalogPreviewSeal.textContent = ready ? "可更新" : "已拦截";
  ui.catalogOrdinary.textContent = `${count(result.ordinary_products)}（${count(result.ordinary_rows)} 行）`;
  ui.catalogCombination.textContent = `${count(result.combination_rows)} → ${count(result.combination_products)}`;
  ui.catalogMerged.textContent = count(result.merged_products);
  ui.catalogEmpty.textContent = count(result.empty_cost_products);
  ui.catalogResolved.textContent = count(result.resolved_overlap_count);
  ui.catalogChanges.textContent = `新增 ${count(result.added_products)} · 移除 ${count(result.removed_products)} · 成本变化 ${count(result.cost_changed_products)} · 状态变化 ${count(result.status_changed_products)}`;
  const messages = [];
  if (conflicts.length) messages.push(`冲突编码示例：${conflicts.slice(0, 10).join("、")}`);
  if (costMismatches.length) messages.push(`组合成本明细与组合成本不一致示例：${costMismatches.slice(0, 10).join("、")}`);
  ui.catalogConflicts.hidden = messages.length === 0;
  ui.catalogConflicts.textContent = messages.join("\n");
  ui.catalogProgress.textContent = ready ? "预览通过；确认后先备份，再原子发布。" : "预览未通过；必须先解决冲突。";
  syncControls();
}

function renderMappingPreview(result) {
  const conflicts = Array.isArray(result.conflicting_sku_ids) ? result.conflicting_sku_ids : [];
  const ready = result.ready_to_import === true;
  state.mappingPreview = {
    id: result.preview_id,
    ready,
    shopName: result.shop_name,
    canSaveReviews: result.can_save_reviews === true,
    reviewCount: Number(result.review_count) || 0
  };
  ui.mappingPreview.hidden = false;
  ui.mappingPreview.className = `preview-card${ready ? "" : " blocked"}`;
  ui.mappingPreviewTitle.textContent = `${result.shop_name}：${ready ? "可以安全更新" : result.already_current ? "已经是当前内容" : "检查已拦截"}`;
  ui.mappingPreviewGuidance.textContent = ready ? "预览期间没有修改当前映射库。" : "当前映射库保持不变。";
  ui.mappingPreviewSeal.textContent = ready ? "可导入" : result.already_current ? "已存在" : "已拦截";
  ui.mappingTotal.textContent = count(result.unique_douyin_skus);
  ui.mappingMatched.textContent = count(result.matched_rows);
  ui.mappingNew.textContent = count(result.new_rows);
  ui.mappingChange.textContent = `${count(result.changed_rows)} / ${count(result.removed_rows)}`;
  ui.mappingExisting.textContent = count(result.current_shop_rows);
  ui.mappingPending.textContent = count(result.pending_rows);
  ui.mappingErrors.textContent = `${count(result.duplicate_rows)} / ${count(result.invalid_rows)}`;
  ui.mappingCategoryComplete.textContent = count(result.complete_category_rows);
  ui.mappingCategoryIncomplete.textContent = count(result.incomplete_category_rows);
  ui.mappingMajorConfigured.textContent = count(result.major_category_configured_rows);
  ui.mappingMajorUnconfigured.textContent = count(result.major_category_unconfigured_rows);
  ui.mappingFeeMatched.textContent = count(result.service_fee_matched_rows);
  ui.mappingFeeUnconfigured.textContent = count(result.service_fee_unconfigured_rows);
  ui.mappingFeeDisabled.textContent = count(result.service_fee_disabled_rows);
  const messages = [];
  if (conflicts.length) messages.push(`冲突 SKUID 示例：${conflicts.slice(0, 10).join("、")}`);
  if (result.shop_file_mismatch) messages.push("已有店铺与本次完整表没有共同 SKUID，请核对店铺。");
  const categoryIncomplete = Number(result.incomplete_category_rows) || 0;
  const feeUnconfigured = Number(result.service_fee_unconfigured_rows) || 0;
  const feeDisabled = Number(result.service_fee_disabled_rows) || 0;
  if (categoryIncomplete || feeUnconfigured || feeDisabled) {
    messages.push(`真实成本配置待补：类目缺失 ${count(categoryIncomplete)} · 费率未配置 ${count(feeUnconfigured)} · 费率已停用 ${count(feeDisabled)}。不影响本次精确映射导入。`);
  }
  ui.mappingConflicts.className = conflicts.length || result.shop_file_mismatch ? "alert danger-alert" : "alert";
  ui.mappingConflicts.hidden = messages.length === 0;
  ui.mappingConflicts.textContent = messages.join("\n");
  ui.mappingProgress.textContent = ready ? "预览通过；确认后只替换该店映射。" : result.already_current ? "该店映射已是当前文件内容，无需重复导入。" : "预览未通过；请处理重复、无效、冲突或店铺不一致。";
  syncControls();
}

function confirmAction(title, message, buttonText) {
  ui.confirmTitle.textContent = title;
  ui.confirmMessage.textContent = message;
  ui.confirmAccept.textContent = buttonText;
  ui.confirmDialog.showModal();
  return new Promise((resolve) => {
    ui.confirmDialog.addEventListener("close", () => resolve(ui.confirmDialog.returnValue === "confirm"), { once: true });
  });
}

async function initialize() {
  if (state.bridgeReady) return;
  state.bridgeReady = true;
  syncControls();
  try {
    await refreshState(true);
  } catch {
    ui.activity.textContent = "首次状态检查失败，后台会继续重试";
  }
  if (window.__desktopAutoStart !== false && !state.serviceExpected && !ui.servicePill.classList.contains("attention")) {
    await runServiceAction("start_service", "正在启动或接管本机服务……");
  }
  refreshLoop.start({ immediate: false });
}

const refreshLoop = refreshModel.createRefreshLoop({
  task: async () => {
    if (state.busy) return;
    await refreshState(false, true);
  },
  intervalMs: 2000,
  onError: () => { ui.activity.textContent = "自动状态刷新失败，后台会继续重试"; }
});

for (const button of document.querySelectorAll(".nav-item")) {
  button.addEventListener("click", () => selectPage(button.dataset.page));
}
for (const button of document.querySelectorAll("[data-file-kind]")) {
  button.addEventListener("click", () => chooseFile(button.dataset.fileKind));
}

ui.refreshState.addEventListener("click", () => refreshState(true).catch(() => {}));
ui.refreshHistory.addEventListener("click", () => refreshUpdateHistory({ reconcile: true }));
/* RELEASE_EXCLUDE_START: v2 */
ui.refreshServiceFee.addEventListener("click", refreshBasicServiceFees);
ui.importOfficialServiceFee.addEventListener("click", importOfficialServiceFeeCatalog);
ui.archiveLegacyServiceFee.addEventListener("click", archiveLegacyServiceFeeRates);
ui.toggleServiceFeeArchive.addEventListener("click", toggleServiceFeeArchiveView);
ui.newServiceFee.addEventListener("click", () => fillServiceFeeForm());
ui.serviceFeeMajorFilter.addEventListener("change", renderServiceFeeDirectory);
ui.serviceFeeRateFilter.addEventListener("change", renderServiceFeeDirectory);
ui.serviceFeeSearch.addEventListener("input", renderServiceFeeDirectory);
ui.serviceFeeForm.addEventListener("submit", saveBasicServiceFeeVersion);
ui.toggleServiceFee.addEventListener("click", toggleBasicServiceFeeVersion);
ui.refreshShipping.addEventListener("click", refreshShippingTemplates);
ui.newShippingTemplate.addEventListener("click", () => fillShippingForm());
ui.addShippingRule.addEventListener("click", () => ui.shippingRuleList.append(shippingRuleRow()));
ui.shippingForm.addEventListener("submit", saveShippingTemplate);
ui.shippingForm.addEventListener("input", updateShippingCostPreview);
ui.shippingBindingShop.addEventListener("change", renderShippingProductChoices);
ui.shippingBindingStatus.addEventListener("change", renderShippingProductChoices);
ui.shippingBindingSearch.addEventListener("input", renderShippingProductChoices);
ui.shippingBindingForm.addEventListener("submit", saveShippingProductBindings);
/* RELEASE_EXCLUDE_END: v2 */
/* RELEASE_EXCLUDE_START: reviews */
ui.refreshReviews.addEventListener("click", refreshMappingReviews);
/* RELEASE_EXCLUDE_END: reviews */
ui.refreshLogs.addEventListener("click", () => refreshState(true).catch(() => {}));
ui.openLogs.addEventListener("click", () => runAction("正在打开日志文件夹……", () => invoke("open_logs"), async () => {}));
ui.startService.addEventListener("click", () => runServiceAction("start_service", "正在启动或接管本机服务……"));
ui.stopService.addEventListener("click", async () => {
  if (!await confirmAction("停止本窗口服务", "停止后浏览器将暂时无法查询成本。确定停止由本窗口管理的服务吗？", "停止服务")) return;
  await runServiceAction("stop_service", "正在停止本窗口服务……");
});

ui.shopName.addEventListener("input", invalidateMappingPreview);

ui.previewCatalog.addEventListener("click", () => runAction(
  "正在只读解析两份商品表……",
  () => invoke("preview_catalog", {
    ordinary_path: state.files.ordinary.path,
    combination_path: state.files.combination.path
  }),
  async (result) => renderCatalogPreview(result)
));

ui.applyCatalog.addEventListener("click", async () => {
  if (!state.catalogPreview?.ready) return;
  const previewId = state.catalogPreview.id;
  if (!await confirmAction(
    "确认更新完整成本库",
    "系统会重新核对本次预览的两份文件，先创建一致性备份，再以一个事务和原子发布完成更新。",
    "确认原子更新"
  )) return;
  await runAction(
    "正在备份并原子更新成本库……",
    () => invoke("apply_catalog", { preview_id: previewId }),
    async (result) => {
      state.catalogPreview = null;
      ui.catalogProgress.textContent = "成本更新完成；再次更新前请重新预览。";
      showResult(ui.catalogResult, `更新完成：启用商品 ${count(result.enabled_count)} 个，空成本 ${count(result.empty_cost_products)} 个。备份：${result.backup_file || "首次建立，无旧库备份"}。`);
    }
  );
});

ui.previewMapping.addEventListener("click", () => {
  const shopName = ui.shopName.value.trim();
  return runAction(
    "正在只读解析店铺商品表……",
    () => invoke("preview_mapping", { shop_name: shopName, mapping_path: state.files.mapping.path }),
    async (result) => {
      if (result.shop_name !== shopName) throw new Error("店铺名称与预览结果不一致，请重新检查");
      renderMappingPreview(result);
    }
  );
});

ui.applyMapping.addEventListener("click", async () => {
  if (!state.mappingPreview?.ready) return;
  const previewId = state.mappingPreview.id;
  const shopName = state.mappingPreview.shopName;
  if (!await confirmAction(
    `确认替换“${shopName}”映射`,
    "其他店铺不会改动；系统会复核店铺名称、文件哈希和预览凭证，并先创建 SQLite 一致性备份。",
    "确认替换该店"
  )) return;
  await runAction(
    "正在备份并替换该店映射……",
    () => invoke("apply_mapping", { preview_id: previewId }),
    async (result) => {
      if (result.shop_name !== shopName) throw new Error("店铺名称与导入结果不一致，请重新检查");
      state.mappingPreview = null;
      ui.mappingProgress.textContent = "店铺映射更新完成；再次更新前请重新预览。";
      showResult(ui.mappingResult, `${result.shop_name} 更新完成：新增 ${count(result.inserted_rows)} 条，更新 ${count(result.updated_rows)} 条，移除 ${count(result.removed_rows)} 条；其他店铺保持不变。备份：${result.backup_file}。`);
    }
  );
});

ui.saveMappingReviews.addEventListener("click", async () => {
  if (!state.mappingPreview?.canSaveReviews) return;
  const previewId = state.mappingPreview.id;
  const shopName = state.mappingPreview.shopName;
  const reviewCount = state.mappingPreview.reviewCount;
  if (!await confirmAction(
    `保存“${shopName}”待处理清单`,
    `将保存本次预览中的 ${count(reviewCount)} 条待核验或跨店冲突，不会改动现有商品映射。保存前会创建恢复备份。`,
    "只保存待处理项"
  )) return;
  await runAction(
    "正在保存待处理映射……",
    () => invoke("save_mapping_reviews", { preview_id: previewId }),
    async (result) => {
      state.mappingPreview = null;
      ui.mappingProgress.textContent = "待处理清单已保存；映射库没有改变。再次操作前请重新预览。";
      showResult(ui.mappingResult, `${result.shop_name}：保存 ${count(result.saved_rows)} 条，已有 ${count(result.unchanged_rows)} 条未变化。备份：${result.backup_file || "没有变化，未新建备份"}。`);
    }
  );
});

window.addEventListener("desktop-bridge-ready", initialize, { once: true });
if (window.__desktopBridgeReady) initialize();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshLoop.trigger();
});
syncControls();
