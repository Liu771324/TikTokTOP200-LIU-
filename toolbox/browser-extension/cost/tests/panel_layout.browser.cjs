const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

function overlaps(first, second) {
  return first.left < second.right && first.right > second.left
    && first.top < second.bottom && first.bottom > second.top;
}

function relativeLuminance(color) {
  const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

let browser;

(async () => {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; min-height: 100vh; font-family: sans-serif; background: #f4f6f8; color: #25364d; }
    header { height: 64px; background: white; border-bottom: 1px solid #dce3eb; }
    main { margin-left: 220px; padding: 34px; }
    .mock { height: 900px; border: 1px solid #dce3eb; border-radius: 10px; background: white; }
    .mock::before { content: "活动商品管理 · 查看全部 SKU 信息"; display: block; padding: 24px; font-size: 24px; font-weight: 700; border-bottom: 1px solid #e6ebf0; }
    #drawer-close { position: fixed; top: 90px; right: 24px; width: 36px; height: 36px; }
  </style></head><body><header></header><main><div class="mock"></div></main><button id="drawer-close">×</button></body></html>`);
  await page.addScriptTag({ path: path.resolve(__dirname, "../panel.js") });

  const contrast = await page.evaluate(() => {
    const controller = CostAccountingPanel.mountActivityPanel(document);
    controller.update({
      environment: "test",
      serviceStatus: "limited",
      lastSuccessfulSync: "2026-09-02 10:30:00",
      warnings: ["页面结构提示"],
      items: [
        { spec: "绿色状态", platformSkuId: "1", status: "above_cost", comparison: { lowest: "2", cost: "1", delta: "+1", rate: "+100%" } },
        { spec: "红色状态", platformSkuId: "2", status: "below_cost", comparison: { lowest: "1", cost: "2", delta: "-1", rate: "-50%" } },
        { spec: "黄色状态", platformSkuId: "3", status: "cost_missing", lowestPrice: "1" }
      ]
    });
    const shadow = document.getElementById("__ca_cost_panel__").shadowRoot;
    const pair = (selector, backgroundSelector = selector) => {
      const element = shadow.querySelector(selector);
      const background = shadow.querySelector(backgroundSelector);
      return {
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(background).backgroundColor
      };
    };
    return {
      muted: pair(".ca-kicker", ".ca-header"),
      footer: pair(".ca-sync", ".ca-footer"),
      green: pair('[data-tone="positive"] .ca-rate', '[data-tone="positive"]'),
      red: pair('[data-tone="negative"] .ca-rate', '[data-tone="negative"]'),
      amber: pair('[data-tone="warning"] .ca-rate', '[data-tone="warning"]'),
      amberService: pair('.ca-service[data-status="limited"]', ".ca-footer"),
      warningText: pair(".ca-warning"),
      badge: pair(".ca-badge")
    };
  });
  const contrastRatios = Object.fromEntries(
    Object.entries(contrast).map(([name, colors]) => [
      name, Number(contrastRatio(colors.foreground, colors.background).toFixed(2))
    ])
  );
  for (const [name, ratio] of Object.entries(contrastRatios)) {
    assert.ok(
      ratio >= 4.5,
      `${name} contrast is below 4.5:1: ${JSON.stringify(contrast[name])}`
    );
  }

  async function render(itemCount) {
    await page.evaluate((count) => {
      document.getElementById("__ca_cost_panel__")?.remove();
      const controller = CostAccountingPanel.mountActivityPanel(document);
      const specs = ["亲民款", "升级款", "优质款", "家庭装", "实惠装", "组合装", "尝鲜装"];
      const items = Array.from({ length: count }, (_, index) => {
        const base = {
          spec: `${specs[index % specs.length]}/${250 * ((index % 4) + 1)}g*${(index % 3) + 1}袋`,
          platformSkuId: String(370907311624700 + index),
          mapping: { merchantSkuCode: `ERP-${String(index + 1).padStart(3, "0")}-LONG-CODE` },
          priceSource: "drawer_lowest_price"
        };
        if (index % 5 === 4) {
          return { ...base, status: "cost_not_found", lowestPrice: (8.6 + index).toFixed(2) };
        }
        return {
          ...base,
          status: "above_cost",
          trueCost: {
            product_cost: (3 + index / 2).toFixed(2),
            shipping_fee: "1.00",
            shipping_region: "河北省",
            basic_service_fee_rate: "0.05",
            basic_service_fee: "0.43",
            true_cost: (4 + index / 2).toFixed(2),
            estimated: true
          },
          comparison: {
            lowest: (8.6 + index).toFixed(2),
            cost: (4 + index / 2).toFixed(2),
            delta: `+${(4.6 + index / 2).toFixed(2)}`,
            rate: `+${(56.9 + index * 3.17).toFixed(2)}%`
          }
        };
      });
      controller.update({
        environment: "test",
        serviceStatus: "ok",
        lastSuccessfulSync: "2026-09-02 10:30:00",
        activitySource: "cached_drawer",
        items
      });
    }, itemCount);
  }

  async function metrics() {
    return page.evaluate(() => {
      const shadow = document.getElementById("__ca_cost_panel__").shadowRoot;
      const panel = shadow.querySelector(".ca-panel");
      const list = shadow.querySelector(".ca-list");
      const cards = [...shadow.querySelectorAll(".ca-item")];
      const panelRect = panel.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const closeRect = document.getElementById("drawer-close").getBoundingClientRect();
      return {
        viewport: [innerWidth, innerHeight],
        panelRect: { left: panelRect.left, top: panelRect.top, right: panelRect.right, bottom: panelRect.bottom, width: panelRect.width, height: panelRect.height },
        closeRect: { left: closeRect.left, top: closeRect.top, right: closeRect.right, bottom: closeRect.bottom },
        columns: getComputedStyle(list).gridTemplateColumns.split(" ").length,
        cardCount: cards.length,
        listClientHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        listOverflow: getComputedStyle(list).overflowY,
        panelClientHeight: panel.clientHeight,
        panelScrollHeight: panel.scrollHeight,
        panelOverflow: getComputedStyle(panel).overflowY,
        horizontallyContained: cards.every((card) => {
          const rect = card.getBoundingClientRect();
          return rect.left >= listRect.left && rect.right <= listRect.right;
        }),
        fieldsContained: cards.every((card) => {
          const cardRect = card.getBoundingClientRect();
          return [...card.querySelectorAll(".ca-spec, .ca-sku, .ca-rate, .ca-values, .ca-reason")]
            .every((field) => {
              const rect = field.getBoundingClientRect();
              return rect.top >= cardRect.top && rect.bottom <= cardRect.bottom;
            });
        })
      };
    });
  }

  await render(15);
  const desktop = await metrics();
  assert.ok(desktop.panelRect.width >= 900 && desktop.panelRect.width <= 930, JSON.stringify(desktop));
  assert.equal(desktop.columns, 3);
  assert.equal(desktop.cardCount, 15);
  assert.ok(desktop.listScrollHeight > desktop.listClientHeight, JSON.stringify(desktop));
  assert.ok(desktop.horizontallyContained && desktop.fieldsContained, JSON.stringify(desktop));
  assert.equal(overlaps(desktop.panelRect, desktop.closeRect), false);

  if (process.env.PANEL_LAYOUT_SCREENSHOT) {
    await page.screenshot({ path: path.resolve(process.env.PANEL_LAYOUT_SCREENSHOT), fullPage: false });
  }

  await page.setViewportSize({ width: 1024, height: 768 });
  const tablet = await metrics();
  assert.equal(tablet.columns, 2);
  assert.ok(tablet.listScrollHeight > tablet.listClientHeight, JSON.stringify(tablet));
  assert.ok(tablet.horizontallyContained && tablet.fieldsContained, JSON.stringify(tablet));

  await page.setViewportSize({ width: 640, height: 800 });
  const mobile = await metrics();
  assert.equal(mobile.columns, 1);
  assert.ok(mobile.listScrollHeight > mobile.listClientHeight, JSON.stringify(mobile));
  assert.ok(mobile.horizontallyContained && mobile.fieldsContained, JSON.stringify(mobile));

  await page.setViewportSize({ width: 1920, height: 360 });
  const shortViewport = await metrics();
  assert.equal(shortViewport.columns, 3);
  assert.equal(shortViewport.panelOverflow, "auto");
  assert.equal(shortViewport.listOverflow, "visible");
  assert.ok(shortViewport.panelScrollHeight > shortViewport.panelClientHeight, JSON.stringify(shortViewport));
  assert.ok(shortViewport.horizontallyContained && shortViewport.fieldsContained, JSON.stringify(shortViewport));

  await page.setViewportSize({ width: 1920, height: 1080 });
  await render(18);
  const overflowItems = await metrics();
  assert.equal(overflowItems.columns, 3);
  assert.ok(overflowItems.listScrollHeight > overflowItems.listClientHeight, JSON.stringify(overflowItems));
  assert.ok(overflowItems.horizontallyContained && overflowItems.fieldsContained, JSON.stringify(overflowItems));

  process.stdout.write(`${JSON.stringify({ contrastRatios, desktop, tablet, mobile, shortViewport, overflowItems }, null, 2)}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
});
