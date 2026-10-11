(function startCostAccountingContentScript() {
  "use strict";

  const core = globalThis.CostAccountingCore;
  const panelApi = globalThis.CostAccountingPanel;
  if (!core || !panelApi) return;

  let route = null;
  let controller = null;
  let debounceTimer = null;
  let requestSequence = 0;
  const activityRunner = core.createCoalescedRunner(async () => {
    if (route !== "activity") return;
    const sequence = requestSequence;
    try {
      await refreshActivity(sequence);
    } catch {
      if (sequence === requestSequence && route === "activity") {
        controller?.update({ serviceStatus: "unavailable", items: [] });
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
    if (route === "activity") controller = panelApi.mountActivityPanel(document);
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
      controller?.update({
        environment: "unknown",
        serviceStatus: limited ? "limited" : "unavailable",
        serviceError: response?.error ?? "扩展后台不可用",
        activitySource: parsed.source,
        warnings: [
          ...(parsed.warnings ?? []),
          { productId: null, message: response?.error ?? "扩展后台不可用" }
        ],
        items: limited
          ? []
          : parsed.records.map((record) => ({ ...record, status: "service_unavailable" }))
      });
      return;
    }
    controller?.update({ ...response.state, activitySource: parsed.source, warnings: parsed.warnings });
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
    if (route === "edit") refreshEdit(sequence).catch(() => {
      if (sequence === requestSequence) controller?.error();
    });
  }

  function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 320);
  }

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pageshow", scheduleRefresh, { passive: true });
  window.addEventListener("popstate", scheduleRefresh, { passive: true });
  window.addEventListener("hashchange", scheduleRefresh, { passive: true });
  setInterval(() => {
    if (currentRoute() !== route) scheduleRefresh();
  }, 1000);
  scheduleRefresh();
})();
