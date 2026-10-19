(function startCostAccountingContentScript() {
  "use strict";

  const core = globalThis.CostAccountingCore;
  const panelApi = globalThis.CostAccountingPanel;
  if (!core || !panelApi) return;

  let route = null;
  let controller = null;
  let debounceTimer = null;
  let requestSequence = 0;
  let probeTimer = null;
  let probeFailures = 0;
  let serviceSignature = null;
  let lastDisplayState = null;
  const activityRunner = core.createCoalescedRunner(async () => {
    if (route !== "activity") return;
    const sequence = requestSequence;
    try {
      await refreshActivity(sequence);
    } catch {
      if (sequence === requestSequence && route === "activity") {
        lastDisplayState = { serviceStatus: "extension_error", serviceError: "扩展通信或页面解析失败，请刷新页面后重试", items: [] };
        controller?.update(lastDisplayState);
      }
    }
  });

  function currentRoute() {
    return core.detectPageRoute(location.origin, location.pathname);
  }

  function switchRouteIfNeeded() {
    const nextRoute = currentRoute();
    if (nextRoute === route) return;
    controller?.destroy();
    controller = null;
    route = nextRoute;
    if (route === "activity") controller = panelApi.mountActivityPanel(document, {
      onPair: async (pairing) => {
        if (!window.confirm(`将扩展连接到“${pairing.label}”（${pairing.environment === "production" ? "正式" : "测试"}）成本目录？请先与成本助手运行概览核对。`)) return;
        try {
          const response = await chrome.runtime.sendMessage({ type: "PAIR_COST_SERVICE", service_id: pairing.service_id });
          if (!response?.ok) throw new Error(response?.error || "连接未完成");
          serviceSignature = null;
          await probeService(true);
        } catch (error) {
          controller?.update({ serviceStatus: "extension_error", serviceError: error.message, items: [] });
        }
      }
    });
    if (route === "edit") controller = panelApi.mountCollectorBadge(document);
  }

  async function refreshActivity(sequence) {
    const parsed = core.parseActivityRows(document);
    const response = await chrome.runtime.sendMessage({
      type: "GET_ACTIVITY_STATE",
      records: parsed.records
    });
    if (sequence !== requestSequence || route !== "activity") return;
    if (!response?.ok) {
      const limited = response?.code === "record_limit_exceeded";
      lastDisplayState = {
        environment: "unknown",
        serviceStatus: limited ? "limited" : "extension_error",
        serviceError: response?.error ?? "扩展后台不可用",
        activitySource: parsed.source,
        warnings: [
          ...(parsed.warnings ?? []),
          { productId: null, message: response?.error ?? "扩展后台不可用" }
        ],
        items: limited
          ? []
          : parsed.records.map((record) => ({ ...record, status: "service_unavailable" }))
      };
      controller?.update(lastDisplayState);
      return;
    }
    lastDisplayState = { ...response.state, activitySource: parsed.source, warnings: parsed.warnings };
    controller?.update(lastDisplayState);
  }

  async function refreshEdit(sequence) {
    const sourceProductId = new URLSearchParams(location.search).get("product_id");
    const parsed = core.parseEditMappings(document, location.pathname, sourceProductId);
    if (parsed.observations.length === 0) {
      if (sequence === requestSequence && route === "edit") controller?.error();
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: "STORE_MAPPINGS",
      observations: parsed.observations
    });
    if (sequence !== requestSequence || route !== "edit") return;
    if (response?.ok) controller?.update(response);
    else controller?.error();
  }

  function refresh() {
    switchRouteIfNeeded();
    requestSequence += 1;
    const sequence = requestSequence;
    if (route === "activity") activityRunner.run();
    if (route === "activity" && probeTimer === null) scheduleProbe(3000);
    if (route === "edit") refreshEdit(sequence).catch(() => {
      if (sequence === requestSequence) controller?.error();
    });
  }

  function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 320);
  }

  function scheduleProbe(delay) {
    clearTimeout(probeTimer);
    probeTimer = null;
    if (!document.hidden && route === "activity") {
      probeTimer = setTimeout(() => { probeTimer = null; void probeService(); }, delay);
    }
  }

  async function probeService(force = false) {
    if (document.hidden || route !== "activity") return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_SERVICE_HEALTH", force });
      if (route !== "activity" || document.hidden) return;
      if (!response?.ok || !response.state) throw new Error("扩展后台没有返回连接状态");
      const state = response.state;
      const signature = JSON.stringify([state.generation, state.serviceStatus, state.boot_id, state.data_revision]);
      const changed = signature !== serviceSignature;
      serviceSignature = signature;
      if (state.serviceStatus === "ok") {
        probeFailures = 0;
        if (changed || lastDisplayState?.serviceStatus !== "ok" || Number(lastDisplayState?.failedBatchCount) > 0) refresh();
      } else {
        probeFailures = Math.min(probeFailures + 1, 4);
        lastDisplayState = { ...lastDisplayState, ...state, items: [] };
        controller?.update(lastDisplayState);
      }
    } catch (error) {
      probeFailures = Math.min(probeFailures + 1, 4);
      serviceSignature = null;
      lastDisplayState = { serviceStatus: "extension_error", serviceError: error.message, items: [] };
      controller?.update(lastDisplayState);
    } finally {
      scheduleProbe(probeFailures ? Math.min(30000, 3000 * 2 ** probeFailures) : 5000);
    }
  }

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pageshow", scheduleRefresh, { passive: true });
  window.addEventListener("popstate", scheduleRefresh, { passive: true });
  window.addEventListener("hashchange", scheduleRefresh, { passive: true });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(probeTimer);
    probeTimer = null;
    if (!document.hidden) {
      switchRouteIfNeeded();
      serviceSignature = null;
      if (route === "activity") {
        controller?.update({ serviceStatus: "checking", items: [] });
        void probeService(true);
      } else refresh();
    }
  });
  window.addEventListener("pageshow", () => { void probeService(true); }, { passive: true });
  setInterval(() => {
    if (currentRoute() !== route) scheduleRefresh();
  }, 1000);
  scheduleRefresh();
})();
