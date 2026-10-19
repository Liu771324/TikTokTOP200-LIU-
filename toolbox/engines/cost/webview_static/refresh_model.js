(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CostAssistantRefresh = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  function serviceMode(snapshot) {
    if (snapshot?.expected === true && snapshot?.health) return "running";
    if (snapshot?.health_present === true) return "foreign";
    return "offline";
  }

  function startFeedback(result) {
    return {
      started: "本机服务已启动，状态已经刷新。",
      already_running: "已接管正在运行的本机服务，状态已经刷新。",
      already_owned: "本窗口管理的服务已经运行，无需重复启动。"
    }[result] || "本机服务操作已完成，状态已经刷新。";
  }

  function createRefreshLoop({
    task,
    intervalMs = 2000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onError = () => {}
  }) {
    let running = false;
    let inFlight = false;
    let timer = null;

    function schedule() {
      if (running && timer === null) timer = setTimer(tick, intervalMs);
    }

    async function tick() {
      timer = null;
      if (!running || inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        await task();
      } catch (error) {
        onError(error);
      } finally {
        inFlight = false;
        schedule();
      }
    }

    return {
      start({ immediate = true } = {}) {
        if (running) return;
        running = true;
        if (immediate) void tick();
        else schedule();
      },
      trigger() {
        if (!running || inFlight) return false;
        if (timer !== null) clearTimer(timer);
        timer = null;
        void tick();
        return true;
      },
      stop() {
        running = false;
        if (timer !== null) clearTimer(timer);
        timer = null;
      },
      status() {
        return { running, inFlight, scheduled: timer !== null };
      }
    };
  }

  return { createRefreshLoop, serviceMode, startFeedback };
});
