const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const core = require("../core.js");

test("a transient content-worker communication failure recovers without a data change", async () => {
  const timers = new Map();
  let timerId = 0, queries = 0, failHealth = false;
  const displays = [];
  const context = {
    URLSearchParams, console,
    location: { origin: "https://fxg.jinritemai.com", pathname: "/ffa/merchant/child-campaign-detail", search: "" },
    document: { hidden: false, documentElement: {}, addEventListener() {} },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
    CostAccountingCore: { ...core, parseActivityRows: () => ({ records: [], warnings: [], source: "synthetic" }) },
    CostAccountingPanel: { mountActivityPanel: () => ({ update(state) { displays.push(state); }, destroy() {} }) },
    chrome: { runtime: { async sendMessage(message) {
      if (message.type === "GET_ACTIVITY_STATE") { queries++; return { ok: true, state: { serviceStatus: "ok", items: [] } }; }
      if (failHealth) throw new Error("transient worker failure");
      return { ok: true, state: { generation: 1, serviceStatus: "ok", boot_id: "same", data_revision: "same" } };
    } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  async function tick(delay) {
    const item = [...timers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(item, `missing ${delay} ms timer`);
    timers.delete(item[0]); item[1].fn();
    for (let index = 0; index < 20; index++) await Promise.resolve();
  }
  await tick(320);
  await tick(3000);
  const healthyQueries = queries;
  failHealth = true;
  await tick(5000);
  assert.equal(displays.at(-1).serviceStatus, "extension_error");
  failHealth = false;
  await tick(6000);
  assert.ok(queries > healthyQueries);
  assert.equal(displays.at(-1).serviceStatus, "ok");
});
