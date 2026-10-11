const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../core.js");
const panel = require("../panel.js");

class FakeElement {
  constructor(tagName, options = {}, children = []) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...(options.attributes ?? {}) };
    this.classNames = new Set(options.classNames ?? []);
    this.ownText = options.text ?? "";
    this.value = options.value ?? "";
    this.children = [];
    this.parentElement = null;
    for (const child of children) this.append(child);
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  get textContent() {
    return [this.ownText, ...this.children.map((child) => child.textContent)].filter(Boolean).join("");
  }

  get innerText() {
    return [this.ownText, ...this.children.map((child) => child.innerText)].filter(Boolean).join("\n");
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  closest(selector) {
    const tag = selector.toUpperCase();
    let current = this;
    while (current) {
      if (current.tagName === tag) return current;
      current = current.parentElement;
    }
    return null;
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector) {
    if (selector === "*") return true;
    if (selector === ".antd-table-row[data-row-key]") {
      return this.classNames.has("antd-table-row") && this.getAttribute("data-row-key") !== null;
    }
    if (selector === 'input[placeholder="请输入erp编码"]') {
      return this.tagName === "INPUT" && this.getAttribute("placeholder") === "请输入erp编码";
    }
    if (selector === '[role="dialog"], [class*="drawer"], [class*="Drawer"]') {
      return this.getAttribute("role") === "dialog" ||
        Array.from(this.classNames).some((name) => name.includes("drawer") || name.includes("Drawer"));
    }
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const descendants = this.descendants();
    if (selector === "thead th") {
      return descendants.filter((candidate) => {
        if (candidate.tagName !== "TH") return false;
        let parent = candidate.parentElement;
        while (parent && parent !== this) {
          if (parent.tagName === "THEAD") return true;
          parent = parent.parentElement;
        }
        return false;
      });
    }
    return descendants.filter((candidate) => candidate.matches(selector));
  }
}

const el = (tag, options, children) => new FakeElement(tag, options, children);

test("route detector recognizes parent and child activity pages without using event titles", () => {
  assert.equal(
    core.detectPageRoute("https://fxg.jinritemai.com", "/ffa/merchant/parent-campaign-detail"),
    "activity"
  );
  assert.equal(
    core.detectPageRoute("https://fxg.jinritemai.com", "/ffa/merchant/child-campaign-detail"),
    "activity"
  );
  assert.equal(
    core.detectPageRoute("https://fxg.jinritemai.com", "/ffa/merchant/campaign-list"),
    null
  );
  assert.equal(
    core.detectPageRoute("https://untrusted.example", "/ffa/merchant/child-campaign-detail"),
    null
  );
});

test("coalesced runner keeps one in-flight task and one latest follow-up", async () => {
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const runner = core.createCoalescedRunner(async () => {
    calls += 1;
    if (calls === 1) await firstPending;
  });

  const first = runner.run();
  assert.equal(runner.run(), false);
  assert.equal(runner.run(), false);
  assert.deepEqual(runner.status(), { running: true, pending: true });
  releaseFirst();
  await first;

  assert.equal(calls, 2);
  assert.deepEqual(runner.status(), { running: false, pending: false });
});

function activityRow({ productId = "P-001", skuIds = ["9001"], prices = ["12.30"], specs = ["标准装"] } = {}) {
  const skuColumn = el(
    "div",
    {},
    skuIds.map((skuId, index) =>
      el("div", { text: `${specs[index]}\nSKUID：${skuId}\n原价\n¥19.90` })
    )
  );
  const bidColumn = el(
    "div",
    {},
    skuIds.map(() => el("div", { text: "报名价\n¥15.00" }))
  );
  const priceColumn = el(
    "div",
    {},
    prices.map((price) =>
      el("div", { text: `校验价\n¥18.00\n普惠到手价\n¥16.00\n最低到手价\n${price ? `¥${price}` : "--"}` })
    )
  );
  return el(
    "div",
    { classNames: ["antd-table-row"], attributes: { "data-row-key": productId } },
    [
      el("div", { classNames: ["antd-table-cell"], text: `脱敏商品\n商品ID：${productId}` }),
      el("div", { classNames: ["antd-table-cell"] }, [skuColumn, bidColumn, priceColumn])
    ]
  );
}

function activityRoot(rows) {
  return el("div", {}, rows);
}

function activityDrawer({ productId = "P-001", rows = [], categoryLevels = null } = {}) {
  return el("div", { classNames: ["ecom-g-drawer"], attributes: { role: "dialog" } }, [
    el("h2", { text: "修改报名信息" }),
    el("div", { text: `脱敏商品\nID: ${productId}` }),
    ...(categoryLevels ? [el("div", { classNames: ["product-category"] }, [
      el("span", { text: "商品类目" }),
      el("div", {}, categoryLevels.map((level) => el("span", { text: level })))
    ])] : []),
    el("div", { text: "SKU规格\n报名价\n到手价" }),
    el("div", { classNames: ["ecom-g-virtual-list-holder"] }, rows.map((row) =>
      el("div", { classNames: ["sku-row"], text: `${row.spec}\nID: ${row.skuId}\n原价：¥19.90\n报名价\n¥15.00\n最低到手价\n¥${row.lowest}` })
    ))
  ]);
}

test("activity drawer preserves four structured page category levels on every SKU", () => {
  const parsed = core.parseActivityRows(pageWithDrawer(activityDrawer({
    categoryLevels: ["休闲食品", "糕点", "点心", "蛋黄酥"],
    rows: [
      { skuId: "9001", spec: "5袋*1件", lowest: "12.30" },
      { skuId: "9002", spec: "10袋*1件", lowest: "20.00" }
    ]
  })));

  assert.deepEqual(
    parsed.records.map((record) => record.categoryLevels),
    [
      ["休闲食品", "糕点", "点心", "蛋黄酥"],
      ["休闲食品", "糕点", "点心", "蛋黄酥"]
    ]
  );
});

function pageWithDrawer(drawer, outerRows = [activityRow(), activityRow()]) {
  return el("div", {}, [...outerRows, drawer]);
}

function editRoot({ skuId = "000123", merchantCode = "ERP-0001", header = true } = {}) {
  const input = el("input", {
    attributes: { placeholder: "请输入erp编码" },
    value: merchantCode
  });
  const headers = header
    ? el("thead", {}, [el("tr", {}, [el("th", { text: "规格" }), el("th", { text: "SKUID" }), el("th", { text: "商家编码" })])])
    : el("thead", {}, [el("tr", {}, [el("th", { text: "规格" }), el("th", { text: "平台编码" }), el("th", { text: "商家编码" })])]);
  const body = el("tbody", {}, [
    el("tr", {}, [el("td", { text: "标准装" }), el("td", { text: skuId }), el("td", {}, [input])])
  ]);
  return el("div", {}, [el("table", {}, [headers, body])]);
}

function virtualEditRoot({ skuId = "000123", merchantCode = "ERP-0001" } = {}) {
  const input = el("input", {
    attributes: { placeholder: "请输入erp编码" },
    value: merchantCode
  });
  return el("div", {}, [
    el("tr", {}, [
      el("td", { classNames: ["attr-column-field_spec_0"], text: "标准装" }),
      el("td", { classNames: ["attr-column-field_sku_id"], text: skuId }),
      el("td", { classNames: ["attr-column-field_code"] }, [input])
    ])
  ]);
}

test("main-row parser reads one exact lowest-price slot", () => {
  const parsed = core.parseMainActivityRows(activityRoot([activityRow()]));
  assert.equal(parsed.warnings.length, 0);
  assert.deepEqual(parsed.records[0], {
    key: "P-001::9001",
    productId: "P-001",
    productName: "脱敏商品",
    platformSkuId: "9001",
    spec: "标准装",
    lowestPrice: "12.30"
  });
});

test("activity parser zips multiple SKU columns by row-local index", () => {
  const parsed = core.parseMainActivityRows(
    activityRoot([activityRow({ skuIds: ["9001", "9002"], prices: ["12.30", "8.05"], specs: ["大份", "小份"] })])
  );
  assert.deepEqual(parsed.records.map((record) => [record.platformSkuId, record.spec, record.lowestPrice]), [
    ["9001", "大份", "12.30"],
    ["9002", "小份", "8.05"]
  ]);
});

test("activity parser fails closed when SKU and price slot counts differ", () => {
  const parsed = core.parseMainActivityRows(
    activityRoot([activityRow({ skuIds: ["9001", "9002"], prices: ["12.30"], specs: ["大份", "小份"] })])
  );
  assert.equal(parsed.records.length, 0);
  assert.match(parsed.warnings[0].message, /数量不一致/);
});

test("lowest price never falls back to universal or check price", () => {
  const parsed = core.parseMainActivityRows(activityRoot([activityRow({ prices: [null] })]));
  assert.equal(parsed.records[0].lowestPrice, null);
});

test("lowest price rejects ranges instead of silently taking the first amount", () => {
  const parsed = core.parseMainActivityRows(activityRoot([activityRow({ prices: ["5.00 - 6.00"] })]));
  assert.equal(parsed.records[0].lowestPrice, null);
});

test("rows without exact semantic labels are ignored", () => {
  const row = el("div", { classNames: ["antd-table-row"], attributes: { "data-row-key": "P" } }, [
    el("div", { text: "SKUID 9001 普惠到手价 ¥10.00" })
  ]);
  assert.equal(core.parseMainActivityRows(activityRoot([row])).records.length, 0);
});

test("activity parser rejects repeated exact lowest-price labels in one slot", () => {
  const row = activityRow();
  const priceSlot = row.descendants().find((candidate) => candidate.ownText.includes("最低到手价"));
  priceSlot.ownText = "最低到手价\n¥12.30\n最低到手价\n¥13.30";
  const parsed = core.parseMainActivityRows(activityRoot([row]));
  assert.equal(parsed.records.length, 0);
  assert.match(parsed.warnings[0].message, /歧义/);
});

test("activity parser suppresses conflicting duplicate virtual rows", () => {
  const parsed = core.parseMainActivityRows(activityRoot([
    activityRow({ productId: "P-001", skuIds: ["9001"], prices: ["12.30"] }),
    activityRow({ productId: "P-001", skuIds: ["9001"], prices: ["13.30"] })
  ]));
  assert.equal(parsed.records.length, 0);
  assert.match(parsed.warnings.at(-1).message, /重复 SKU 行数据不一致/);
});

test("activity parser uses only the expanded all-SKU drawer and ignores outer rows", () => {
  const root = pageWithDrawer(activityDrawer({ rows: [
    { skuId: "9001", spec: "大份", lowest: "12.30" },
    { skuId: "9002", spec: "小份", lowest: "8.05" }
  ] }));
  const parsed = core.parseActivityRows(root);
  assert.equal(parsed.source, "all_sku_drawer");
  assert.equal(parsed.scopeKey, "P-001");
  assert.deepEqual(parsed.records.map((record) => [record.platformSkuId, record.spec, record.lowestPrice]), [
    ["9001", "大份", "12.30"],
    ["9002", "小份", "8.05"]
  ]);
});

test("drawer parser reads the currently mounted nine and seven SKU rows", () => {
  const rows = Array.from({ length: 15 }, (_, index) => ({
    skuId: String(9001 + index),
    spec: `规格 ${index + 1}`,
    lowest: `${index + 1}.00`
  }));
  const top = core.parseActivityRows(pageWithDrawer(activityDrawer({ rows: rows.slice(0, 9) })));
  const bottom = core.parseActivityRows(pageWithDrawer(activityDrawer({ rows: rows.slice(8) })));
  assert.equal(top.records.length, 9);
  assert.equal(bottom.records.length, 7);
});

test("activity parser returns no partial main-table records until the all-SKU drawer is open", () => {
  const parsed = core.parseActivityRows(activityRoot([activityRow()]));
  assert.equal(parsed.source, "drawer_closed");
  assert.equal(parsed.records.length, 0);
  assert.match(parsed.warnings[0].message, /页面结构可能已更新/);
});

test("drawer parser never falls back to registration or original price", () => {
  const drawer = activityDrawer({ rows: [{ skuId: "9001", spec: "大份", lowest: "12.30" }] });
  const row = drawer.descendants().find((candidate) => candidate.classNames.has("sku-row"));
  row.ownText = "大份\nID: 9001\n原价：¥19.90\n报名价\n¥15.00";
  const parsed = core.parseActivityRows(pageWithDrawer(drawer));
  assert.equal(parsed.records.length, 0);
});

test("drawer parser rejects repeated lowest-price labels and multiple SKU IDs", () => {
  const repeated = activityDrawer({ rows: [{ skuId: "9001", spec: "大份", lowest: "12.30" }] });
  repeated.descendants().find((candidate) => candidate.classNames.has("sku-row")).ownText += "\n最低到手价\n¥13.30";
  assert.equal(core.parseActivityRows(pageWithDrawer(repeated)).records.length, 0);

  const multipleIds = activityDrawer({ rows: [{ skuId: "9001", spec: "大份", lowest: "12.30" }] });
  multipleIds.descendants().find((candidate) => candidate.classNames.has("sku-row")).ownText += "\nID: 9002";
  assert.equal(core.parseActivityRows(pageWithDrawer(multipleIds)).records.length, 0);
});

test("drawer price ranges remain missing instead of taking the first amount", () => {
  const drawer = activityDrawer({ rows: [{ skuId: "9001", spec: "大份", lowest: "12.30" }] });
  const row = drawer.descendants().find((candidate) => candidate.classNames.has("sku-row"));
  row.ownText = row.ownText.replace("¥12.30", "¥12.30 - ¥13.30");
  const parsed = core.parseActivityRows(pageWithDrawer(drawer));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].lowestPrice, null);
});

test("edit parser reads exact same-row SKUID and ERP input while preserving leading zeroes", () => {
  const parsed = core.parseEditMappings(editRoot(), "/ffa/g/create", "P-001");
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(parsed.observations, [
    {
      platformSkuId: "000123",
      merchantSkuCode: "ERP-0001",
      sourcePath: "/ffa/g/create",
      sourceProductId: "P-001"
    }
  ]);
});

test("edit parser fails closed when exact SKUID header is absent", () => {
  const parsed = core.parseEditMappings(editRoot({ header: false }));
  assert.equal(parsed.observations.length, 0);
  assert.equal(parsed.skipped, 1);
});

test("edit parser reads the live virtual-table row classes without a table ancestor", () => {
  const parsed = core.parseEditMappings(virtualEditRoot(), "/ffa/g/create", "P-001");
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.observations[0].platformSkuId, "000123");
  assert.equal(parsed.observations[0].merchantSkuCode, "ERP-0001");
});

test("edit parser skips empty merchant codes", () => {
  const parsed = core.parseEditMappings(editRoot({ merchantCode: "  " }));
  assert.equal(parsed.observations.length, 0);
  assert.equal(parsed.skipped, 1);
});

test("edit parser preserves comma-containing merchant codes for repeated batch queries", () => {
  const parsed = core.parseEditMappings(editRoot({ merchantCode: "ERP-1,ERP-2" }));
  assert.equal(parsed.observations.length, 1);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.observations[0].merchantSkuCode, "ERP-1,ERP-2");
});

test("mapping observations retain an auditable exact-row source", () => {
  const merged = core.mergeMappingObservations(
    {},
    [{ platformSkuId: "9001", merchantSkuCode: "ERP-1", sourcePath: "/ffa/g/create", sourceProductId: "P-001" }],
    "2026-08-30T12:00:00Z"
  );
  assert.equal(merged.added, 1);
  assert.equal(merged.mappings["9001"].status, "observed_exact_row");
  assert.equal(merged.mappings["9001"].merchantSkuCode, "ERP-1");
  assert.equal(merged.mappings["9001"].sourcePath, "/ffa/g/create");
  assert.equal(merged.mappings["9001"].sourceProductId, "P-001");
});

test("conflicting merchant codes disable automatic mapping", () => {
  const first = core.mergeMappingObservations(
    {},
    [{ platformSkuId: "9001", merchantSkuCode: "ERP-1" }],
    "2026-08-30T12:00:00Z"
  );
  const second = core.mergeMappingObservations(
    first.mappings,
    [{ platformSkuId: "9001", merchantSkuCode: "ERP-2" }],
    "2026-08-30T12:01:00Z"
  );
  assert.equal(second.mappings["9001"].status, "conflict");
  assert.equal(second.mappings["9001"].merchantSkuCode, null);
  assert.deepEqual(second.mappings["9001"].candidateMerchantCodes, ["ERP-1", "ERP-2"]);
  assert.deepEqual(
    second.mappings["9001"].observationHistory.map((entry) => [entry.merchantSkuCode, entry.observedAt]),
    [["ERP-1", "2026-08-30T12:00:00Z"], ["ERP-2", "2026-08-30T12:01:00Z"]]
  );
});

test("verified database mappings override local observations while invalid rows are ignored", () => {
  const merged = core.mergeMappingSources(
    {
      D1: { status: "observed_exact_row", merchantSkuCode: "LOCAL-1" },
      D2: { status: "conflict", merchantSkuCode: null }
    },
    [
      { douyin_sku_id: "D1", jushuitan_sku_id: "DB-1", status: "verified" },
      { douyin_sku_id: "D2", jushuitan_sku_id: "", status: "verified" },
      { douyin_sku_id: "D3", jushuitan_sku_id: "DB-3", status: "pending" }
    ]
  );
  assert.equal(merged.D1.status, "verified_import");
  assert.equal(merged.D1.merchantSkuCode, "DB-1");
  assert.equal(merged.D2.status, "conflict");
  assert.equal(merged.D3, undefined);
});

test("lookup plan never queries by platform SKUID without a mapping", () => {
  const records = [{ platformSkuId: "9001" }];
  const plan = core.buildLookupPlan(records, {});
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.recordMappings[0].mapping.status, "mapping_missing");
});

test("lookup plan deduplicates exact merchant codes and caps batches at 100", () => {
  const records = [];
  const mappings = {};
  for (let index = 0; index < 101; index += 1) {
    const platformSkuId = `D${index}`;
    const merchantSkuCode = `M${index}`;
    records.push({ platformSkuId });
    mappings[platformSkuId] = { status: "observed_exact_row", merchantSkuCode };
  }
  records.push({ platformSkuId: "D0" });
  const plan = core.buildLookupPlan(records, mappings);
  assert.equal(plan.batches.length, 2);
  assert.equal(plan.batches[0].length, 100);
  assert.equal(plan.batches[1].length, 1);
});

test("positive relative-to-cost rate uses decimal arithmetic", () => {
  assert.deepEqual(core.calculateComparison("5.27", "4.00"), {
    status: "above_cost",
    lowest: "5.27",
    cost: "4.00",
    delta: "+1.27",
    rate: "+31.75%"
  });
});

test("negative rate rounds half away from zero to two decimals", () => {
  const result = core.calculateComparison("2", "3");
  assert.equal(result.status, "below_cost");
  assert.equal(result.delta, "-1.00");
  assert.equal(result.rate, "-33.33%");
});

test("equal price and cost keep an explicit plus zero rate", () => {
  const result = core.calculateComparison("4", "4.000");
  assert.equal(result.status, "at_cost");
  assert.equal(result.delta, "+0.00");
  assert.equal(result.rate, "+0.00%");
});

test("missing and zero values produce explicit non-computable states", () => {
  assert.equal(core.calculateComparison(null, "4").status, "lowest_missing");
  assert.equal(core.calculateComparison("4", null).status, "cost_missing");
  assert.equal(core.calculateComparison("4", "0").status, "zero_cost");
  assert.equal(core.calculateComparison("not-money", "4").status, "lowest_missing");
  assert.equal(core.calculateComparison("4", "-1").status, "invalid_cost");
});

test("display state preserves page order and reports sandbox cost misses", () => {
  const records = [
    { platformSkuId: "D2", lowestPrice: "10" },
    { platformSkuId: "D1", lowestPrice: "5" }
  ];
  const mappings = {
    D1: { status: "observed_exact_row", merchantSkuCode: "M1" },
    D2: { status: "observed_exact_row", merchantSkuCode: "M2" }
  };
  const state = core.buildDisplayState(
    records,
    mappings,
    [{ sku_id: "M1", cost_price: "4" }],
    { environment: "test", last_successful_sync: "now" }
  );
  assert.deepEqual(state.items.map((item) => item.platformSkuId), ["D2", "D1"]);
  assert.deepEqual(state.items.map((item) => item.status), ["cost_not_found", "above_cost"]);
  assert.equal(state.environment, "test");
});

test("true cost display state uses the server breakdown and preserves missing reasons", () => {
  const records = [
    { platformSkuId: "D1", lowestPrice: "30", spec: "800g*2罐" },
    { platformSkuId: "D2", lowestPrice: "20", spec: "未知重量" }
  ];
  const estimates = [
    {
      douyin_sku_id: "D1", available: true, jushuitan_sku_id: "SKU-1",
      product_cost: "12", shipping_fee: "10", shipping_region: "河北省",
      basic_service_fee_rate: "0.05", basic_service_fee: "1.5",
      lowest_price: "30", true_cost: "23.5", cost_difference: "6.5",
      difference_rate_percent: "+27.66", unconfigured_reasons: [], estimated: true
    },
    {
      douyin_sku_id: "D2", available: false, jushuitan_sku_id: "SKU-2",
      lowest_price: "20", true_cost: null,
      unconfigured_reasons: ["商品重量未配置"], estimated: true
    }
  ];

  const state = core.buildTrueCostDisplayState(
    records, estimates, { environment: "production", last_successful_sync: "now" }
  );

  assert.equal(state.items[0].status, "above_cost");
  assert.equal(state.items[0].comparison.cost, "23.50");
  assert.equal(state.items[0].comparison.rate, "+27.66%");
  assert.equal(state.items[0].mapping.merchantSkuCode, "SKU-1");
  assert.equal(state.items[1].status, "true_cost_unconfigured");
  assert.deepEqual(state.items[1].unconfiguredReasons, ["商品重量未配置"]);
});

test("display distinguishes missing page category context from an incomplete stored category", () => {
  const state = core.buildTrueCostDisplayState(
    [{ platformSkuId: "D1", lowestPrice: "20" }],
    [{
      douyin_sku_id: "D1",
      available: false,
      jushuitan_sku_id: "SKU-1",
      category_source: "mapping",
      category_levels: ["休闲食品", "糕点/点心", "蛋黄酥", ""],
      product_cost: "12",
      shipping_fee: "3",
      basic_service_fee: null,
      unconfigured_reasons: ["基础服务费率未配置"]
    }],
    { environment: "production" }
  );

  assert.deepEqual(state.items[0].unconfiguredReasons, [
    "页面商品类目未识别，已使用成本库中的不完整类目",
    "基础服务费率未配置"
  ]);
});

test("service failure never exposes stale-looking calculations", () => {
  const state = core.buildDisplayState(
    [{ platformSkuId: "D1", lowestPrice: "5" }],
    { D1: { status: "observed_exact_row", merchantSkuCode: "M1" } },
    [{ sku_id: "M1", cost_price: "4" }],
    null,
    "offline"
  );
  assert.equal(state.items[0].status, "service_unavailable");
  assert.equal(state.items[0].comparison, undefined);
});

test("panel copy labels sandbox data as not for pricing", () => {
  assert.match(panel.CSS_TEXT, /prefers-reduced-motion/);
  assert.match(panel.CSS_TEXT, /left:\s*18px;\s*bottom:\s*18px;/);
  assert.doesNotMatch(panel.CSS_TEXT, /\.ca-panel\s*\{[^}]*top:\s*18px;[^}]*right:\s*18px;/s);
  assert.match(panel.mountActivityPanel.toString(), /侧栏 SKU/);
  assert.deepEqual(panel.statusPresentation({ status: "mapping_conflict" }), {
    tone: "warning",
    rate: "—",
    reason: "同一 SKUID 观察到不同商家编码，已停止自动匹配。"
  });
  assert.equal(panel.statusPresentation({ status: "invalid_cost" }).reason, "聚水潭成本为负数，无法计算。");
  assert.deepEqual(
    panel.statusPresentation({
      status: "true_cost_unconfigured",
      unconfiguredReasons: ["商品重量未配置", "基础服务费率未配置"]
    }),
    { tone: "warning", rate: "—", reason: "商品重量未配置；基础服务费率未配置" }
  );
  assert.match(panel.mountActivityPanel.toString(), /真实成本/);
  assert.match(panel.mountActivityPanel.toString(), /基础服务费/);
  assert.equal(panel.statusPresentation({ status: "record_limit_exceeded" }).reason, "当前页面 SKU 数量超过 2000 条安全上限，请缩小侧栏范围后重试。");
  assert.equal(panel.signedMoney("+1.27"), "+¥1.27");
  assert.equal(panel.signedMoney("-0.50"), "-¥0.50");
});

test("incomplete true cost keeps each available component visible", () => {
  assert.deepEqual(
    panel.incompleteCostRows({
      lowestPrice: "20",
      trueCost: {
        product_cost: "12",
        shipping_fee: null,
        basic_service_fee: "1",
        basic_service_fee_rate: "0.05"
      }
    }),
    [
      ["最低到手", "¥20"],
      ["聚水潭成本", "¥12"],
      ["估算运费", "未找到"],
      ["基础服务费", "¥1"],
      ["基础费率", "0.05"]
    ]
  );
  assert.equal(
    panel.shippingLabel({ shipping_estimated_from_first_weight: true }),
    "估算运费（按首重估算）"
  );
});

test("service status explains partial retries and the most recent successful connection", () => {
  assert.equal(
    panel.serviceStatusText({ serviceStatus: "ok", retriedBatchCount: 1, failedBatchCount: 0 }),
    "成本服务：已连接（批次重试成功）"
  );
  assert.equal(
    panel.serviceStatusText({ serviceStatus: "ok", retriedBatchCount: 1, failedBatchCount: 1 }),
    "成本服务：已连接（1 个批次待重试）"
  );
  assert.equal(
    panel.serviceStatusText({
      serviceStatus: "unavailable",
      lastSuccessfulConnectionAt: "2026-09-11T02:03:04.000Z"
    }),
    "成本服务：不可用（最近成功 2026-09-11 02:03:04 UTC）"
  );
});

test("expanded panel uses a half-screen multi-column ledger on desktop", () => {
  assert.match(panel.CSS_TEXT, /width:\s*clamp\(720px,\s*48vw,\s*960px\)/);
  assert.match(panel.CSS_TEXT, /\.ca-list\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(panel.CSS_TEXT, /\.ca-list\s*\{[^}]*grid-auto-rows:\s*max-content/s);
  assert.match(panel.CSS_TEXT, /\.ca-item\s*\{[^}]*min-height:\s*210px/s);
  assert.match(panel.CSS_TEXT, /\.ca-item\s*\{[^}]*overflow:\s*visible/s);
  assert.match(panel.CSS_TEXT, /@media\s*\(max-width:\s*1279px\)/);
  assert.match(panel.CSS_TEXT, /@media\s*\(max-width:\s*720px\)/);
  assert.match(panel.CSS_TEXT, /@media\s*\(max-height:\s*520px\)\s*\{[^}]*\.ca-panel\s*\{[^}]*overflow:\s*auto/s);
  assert.match(panel.CSS_TEXT, /@media\s*\(max-height:\s*520px\)[\s\S]*?\.ca-list\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible/s);
  assert.match(panel.CSS_TEXT, /\.ca-panel\[data-collapsed="true"\]\s*\{[^}]*width:\s*272px/s);
});
