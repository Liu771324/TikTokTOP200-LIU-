"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const model = require(path.join(__dirname, "..", "cost_sync", "webview_static", "refresh_model.js"));

function controlledClock() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimer(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearTimer(id) { callbacks.delete(id); },
    async advanceOne() {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, "expected a scheduled refresh");
      callbacks.delete(entry[0]);
      await entry[1]();
      await new Promise((resolve) => setImmediate(resolve));
    },
    count() { return callbacks.size; }
  };
}

test("health availability is independent from window process ownership", () => {
  assert.equal(model.serviceMode({ expected: true, health: { status: "ok" }, owns_service: false }), "running");
  assert.equal(model.serviceMode({ expected: false, health_present: true, owns_service: true }), "foreign");
  assert.equal(model.serviceMode({ expected: false, health_present: false, owns_service: true }), "offline");
});

test("every start or attach result has explicit operator feedback", () => {
  assert.match(model.startFeedback("started"), /已启动/);
  assert.match(model.startFeedback("already_running"), /已接管/);
  assert.match(model.startFeedback("already_owned"), /无需重复/);
  assert.match(model.startFeedback("unknown"), /已完成/);
});

test("refresh loop continues after both success and failure", async () => {
  const clock = controlledClock();
  const errors = [];
  let calls = 0;
  const loop = model.createRefreshLoop({
    task: async () => {
      calls += 1;
      if (calls === 2) throw new Error("transient timeout");
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (error) => errors.push(error.message)
  });
  loop.start({ immediate: false });
  for (let index = 0; index < 1000; index += 1) await clock.advanceOne();

  assert.equal(calls, 1000);
  assert.deepEqual(errors, ["transient timeout"]);
  assert.equal(clock.count(), 1);
  assert.deepEqual(loop.status(), { running: true, inFlight: false, scheduled: true });
});

test("refresh loop never overlaps a pending health request", async () => {
  const clock = controlledClock();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const loop = model.createRefreshLoop({
    task: async () => { calls += 1; await pending; },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  loop.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  assert.equal(loop.trigger(), false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.count(), 1);
});
