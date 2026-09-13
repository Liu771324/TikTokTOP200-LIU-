const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const core = require("../core.js");

function createWorkerHarness(fetchImpl) {
  let listener = null;
  const storage = {};
  const context = {
    AbortController,
    CostAccountingCore: core,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    fetch: fetchImpl,
    importScripts() {},
    setTimeout,
    structuredClone,
    chrome: {
      runtime: {
        id: "extension-id",
        onMessage: {
          addListener(callback) { listener = callback; }
        }
      },
      storage: {
        local: {
          async get(key) { return { [key]: storage[key] }; },
          async set(values) { Object.assign(storage, structuredClone(values)); }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  assert.equal(typeof listener, "function");

  function dispatch(message, sender) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker response timeout")), 1000);
      listener(message, sender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  return { dispatch, storage };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(payload); }
  };
}

test("worker rejects messages outside the verified Douyin origin", async () => {
  let fetchCount = 0;
  const harness = createWorkerHarness(async () => {
    fetchCount += 1;
    return jsonResponse({});
  });
  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records: [] },
    { id: "extension-id", url: "https://untrusted.example/ffa/merchant/parent-campaign-detail" }
  );
  assert.equal(response.ok, false);
  assert.equal(fetchCount, 0);
});

test("worker accepts cost reads from a child campaign detail page", async () => {
  let fetchCount = 0;
  const harness = createWorkerHarness(async () => {
    fetchCount += 1;
    return jsonResponse({ environment: "test" });
  });
  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records: [] },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/child-campaign-detail?id=redacted" }
  );
  assert.equal(response.ok, true);
  assert.equal(fetchCount, 1);
});

test("worker uses the true-cost capability and keeps SKU-price pairs aligned", async () => {
  const requestedPaths = [];
  const harness = createWorkerHarness(async (url) => {
    const parsed = new URL(String(url));
    requestedPaths.push(parsed.pathname);
    if (parsed.pathname === "/health") {
      return jsonResponse({
        environment: "production",
        capabilities: ["true_cost_breakdown_v1", "page_category_context_v1"]
      });
    }
    assert.equal(parsed.pathname, "/api/v1/true-costs");
    assert.deepEqual(parsed.searchParams.getAll("douyin_sku_id"), ["D1"]);
    assert.deepEqual(parsed.searchParams.getAll("lowest_price"), ["30"]);
    assert.deepEqual(parsed.searchParams.getAll("category_level_1"), ["休闲食品"]);
    assert.deepEqual(parsed.searchParams.getAll("category_level_2"), ["糕点"]);
    assert.deepEqual(parsed.searchParams.getAll("category_level_3"), ["点心"]);
    assert.deepEqual(parsed.searchParams.getAll("category_level_4"), ["蛋黄酥"]);
    return jsonResponse({ true_costs: [{
      douyin_sku_id: "D1", available: true, jushuitan_sku_id: "SKU-1",
      product_cost: "12", shipping_fee: "10", shipping_region: "河北省",
      basic_service_fee_rate: "0.05", basic_service_fee: "1.5",
      lowest_price: "30", true_cost: "23.5", cost_difference: "6.5",
      difference_rate_percent: "+27.66", unconfigured_reasons: [], estimated: true
    }] });
  });

  const response = await harness.dispatch(
    {
      type: "GET_ACTIVITY_STATE",
      records: [{
        platformSkuId: "D1",
        lowestPrice: "30",
        categoryLevels: ["休闲食品", "糕点", "点心", "蛋黄酥"]
      }]
    },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/parent-campaign-detail" }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(requestedPaths, ["/health", "/api/v1/true-costs"]);
  assert.equal(response.state.items[0].status, "above_cost");
  assert.equal(response.state.items[0].trueCost.true_cost, "23.5");
});

test("worker rejects cost reads from other merchant pages", async () => {
  let fetchCount = 0;
  const harness = createWorkerHarness(async () => {
    fetchCount += 1;
    return jsonResponse({});
  });
  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records: [] },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/campaign-list" }
  );
  assert.equal(response.ok, false);
  assert.equal(fetchCount, 0);
});

test("worker stores exact edit mapping then queries by merchant code, never platform SKUID", async () => {
  const requested = [];
  const harness = createWorkerHarness(async (url, options) => {
    requested.push({ url: String(url), options });
    if (String(url).endsWith("/health")) {
      return jsonResponse({ environment: "test", last_successful_sync: "now", total_count: 1, enabled_count: 1 });
    }
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/mappings") return jsonResponse({ mappings: [] });
    assert.deepEqual(parsed.searchParams.getAll("sku_id"), ["ERP-1,001"]);
    return jsonResponse({ products: [{ sku_id: "ERP-1,001", cost_price: "4.00", name: "fixture" }] });
  });

  const stored = await harness.dispatch(
    {
      type: "STORE_MAPPINGS",
      observations: [{ platformSkuId: "DOUYIN-999", merchantSkuCode: "ERP-1,001", sourcePath: "/ffa/g/create" }]
    },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/g/create?product_id=P-1" }
  );
  assert.equal(stored.ok, true);

  const activity = await harness.dispatch(
    {
      type: "GET_ACTIVITY_STATE",
      records: [{ platformSkuId: "DOUYIN-999", lowestPrice: "5.00", spec: "fixture" }]
    },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/parent-campaign-detail?id=redacted" }
  );
  assert.equal(activity.ok, true);
  assert.equal(activity.state.items[0].status, "above_cost");
  assert.equal(activity.state.items[0].comparison.rate, "+25.00%");
  assert.equal(requested.length, 3);
  assert.equal(requested.every(({ options }) => options.method === "GET" && options.credentials === "omit"), true);
  const mappingRequests = requested.filter(({ url }) => new URL(url).pathname === "/api/v1/mappings");
  const productRequests = requested.filter(({ url }) => new URL(url).pathname === "/api/v1/products");
  assert.equal(mappingRequests.some(({ url }) => url.includes("DOUYIN-999")), true);
  assert.equal(productRequests.some(({ url }) => url.includes("DOUYIN-999")), false);
});

test("worker marks all items unavailable if any local API request fails", async () => {
  const harness = createWorkerHarness(async () => { throw new TypeError("offline"); });
  await harness.dispatch(
    {
      type: "STORE_MAPPINGS",
      observations: [{ platformSkuId: "D1", merchantSkuCode: "M1", sourcePath: "/ffa/g/create" }]
    },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/g/create" }
  );
  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records: [{ platformSkuId: "D1", lowestPrice: "5" }] },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/parent-campaign-detail" }
  );
  assert.equal(response.state.serviceStatus, "unavailable");
  assert.equal(response.state.items[0].status, "service_unavailable");
  assert.equal(response.state.items[0].comparison, undefined);
});

test("a failed true-cost batch is retried and does not mark a healthy service unavailable", async () => {
  let failedBatchAttempts = 0;
  const harness = createWorkerHarness(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/health") {
      return jsonResponse({
        environment: "production",
        capabilities: ["true_cost_breakdown_v1"]
      });
    }
    const skuIds = parsed.searchParams.getAll("douyin_sku_id");
    if (skuIds.includes("D100")) {
      failedBatchAttempts += 1;
      throw new TypeError("transient batch failure");
    }
    return jsonResponse({
      true_costs: skuIds.map((douyin_sku_id) => ({
        douyin_sku_id,
        available: true,
        jushuitan_sku_id: `SKU-${douyin_sku_id}`,
        product_cost: "2",
        shipping_fee: "1",
        basic_service_fee: "1",
        basic_service_fee_rate: "0.1",
        true_cost: "4",
        unconfigured_reasons: []
      }))
    });
  });
  const records = Array.from({ length: 101 }, (_, index) => ({
    platformSkuId: `D${index}`,
    lowestPrice: "5"
  }));

  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/parent-campaign-detail" }
  );

  assert.equal(response.state.serviceStatus, "ok");
  assert.equal(response.state.items[0].status, "above_cost");
  assert.equal(response.state.items[100].status, "true_cost_unconfigured");
  assert.deepEqual(
    response.state.items[100].unconfiguredReasons,
    ["真实成本批次查询失败，请重试"]
  );
  assert.equal(failedBatchAttempts, 2);
  assert.equal(response.state.retriedBatchCount, 1);
  assert.equal(response.state.failedBatchCount, 1);
  assert.match(response.state.lastSuccessfulConnectionAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("worker reports the record safety limit separately from service outages", async () => {
  const harness = createWorkerHarness(async () => jsonResponse({ environment: "test" }));
  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records: Array.from({ length: 2001 }, () => ({ platformSkuId: "D1" })) },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/parent-campaign-detail" }
  );
  assert.equal(response.ok, false);
  assert.equal(response.code, "record_limit_exceeded");
  assert.match(response.error, /2000/);
});

test("worker preserves 101 activity records and queries merchant codes in two batches", async () => {
  const mappingBatchSizes = [];
  const productBatchSizes = [];
  const harness = createWorkerHarness(async (url) => {
    if (String(url).endsWith("/health")) return jsonResponse({ environment: "test" });
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/mappings") {
      const douyinSkuIds = parsed.searchParams.getAll("douyin_sku_id");
      mappingBatchSizes.push(douyinSkuIds.length);
      return jsonResponse({ mappings: [] });
    }
    const skuIds = parsed.searchParams.getAll("sku_id");
    productBatchSizes.push(skuIds.length);
    return jsonResponse({ products: skuIds.map((sku_id) => ({ sku_id, cost_price: "4" })) });
  });
  const observations = Array.from({ length: 101 }, (_, index) => ({
    platformSkuId: `D${index}`,
    merchantSkuCode: `M${index}`
  }));
  const stored = await harness.dispatch(
    { type: "STORE_MAPPINGS", observations },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/g/create" }
  );
  assert.equal(stored.ok, true);
  const records = observations.map(({ platformSkuId }) => ({ platformSkuId, lowestPrice: "5" }));
  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/parent-campaign-detail" }
  );
  assert.equal(response.state.items.length, 101);
  assert.deepEqual(mappingBatchSizes, [100, 1]);
  assert.deepEqual(productBatchSizes, [100, 1]);
});

test("worker prefers a verified database mapping over a conflicting local observation", async () => {
  const requestedProductCodes = [];
  const harness = createWorkerHarness(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/health") return jsonResponse({ environment: "test" });
    if (parsed.pathname === "/api/v1/mappings") {
      return jsonResponse({
        mappings: [
          { douyin_sku_id: "D1", jushuitan_sku_id: "DB-001", status: "verified" }
        ]
      });
    }
    const codes = parsed.searchParams.getAll("sku_id");
    requestedProductCodes.push(...codes);
    return jsonResponse({ products: [{ sku_id: "DB-001", cost_price: "4" }] });
  });
  await harness.dispatch(
    { type: "STORE_MAPPINGS", observations: [{ platformSkuId: "D1", merchantSkuCode: "LOCAL-001" }] },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/g/create" }
  );

  const response = await harness.dispatch(
    { type: "GET_ACTIVITY_STATE", records: [{ platformSkuId: "D1", lowestPrice: "5" }] },
    { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/merchant/child-campaign-detail" }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(requestedProductCodes, ["DB-001"]);
  assert.equal(response.state.items[0].mapping.merchantSkuCode, "DB-001");
  assert.equal(response.state.items[0].status, "above_cost");
});

test("worker serializes concurrent conflicting mapping observations", async () => {
  const harness = createWorkerHarness(async () => jsonResponse({}));
  const sender = { id: "extension-id", url: "https://fxg.jinritemai.com/ffa/g/create" };
  const [first, second] = await Promise.all([
    harness.dispatch({ type: "STORE_MAPPINGS", observations: [{ platformSkuId: "D1", merchantSkuCode: "M1" }] }, sender),
    harness.dispatch({ type: "STORE_MAPPINGS", observations: [{ platformSkuId: "D1", merchantSkuCode: "M2" }] }, sender)
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(harness.storage.skuMappings.D1.status, "conflict");
  assert.deepEqual(
    Array.from(harness.storage.skuMappings.D1.candidateMerchantCodes),
    ["M1", "M2"]
  );
});
