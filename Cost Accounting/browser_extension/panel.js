(function initCostAccountingPanel(target) {
  "use strict";

  const CSS_TEXT = `
    :host {
      all: initial;
      color-scheme: light;
      --ink: #14263d;
      --paper: #f8fafc;
      --paper-strong: #ffffff;
      --line: #d7e0ea;
      --muted: #4f6178;
      --amber: #995b05;
      --amber-soft: #fff3d8;
      --green: #0f6846;
      --green-soft: #e9f7f0;
      --red: #982f2f;
      --red-soft: #fff0ef;
      --blue-soft: #eaf1f8;
      font-family: "Microsoft YaHei UI", "PingFang SC", sans-serif;
    }

    *, *::before, *::after { box-sizing: border-box; }

    button { font: inherit; }

    .ca-panel {
      position: fixed;
      left: 18px;
      bottom: 18px;
      z-index: 2147482000;
      width: clamp(720px, 48vw, 960px);
      max-height: calc(100vh - 36px);
      display: grid;
      grid-template-rows: auto auto minmax(80px, 1fr) auto;
      overflow: hidden;
      color: var(--ink);
      background: var(--paper);
      border: 1px solid #bac8d8;
      border-radius: 12px 12px 5px 5px;
      box-shadow: 0 18px 52px rgba(20, 38, 61, .22), 0 2px 8px rgba(20, 38, 61, .10);
      pointer-events: auto;
    }

    .ca-panel[data-collapsed="true"] {
      width: 272px;
      grid-template-rows: auto;
    }

    .ca-panel[data-collapsed="true"] .ca-banner,
    .ca-panel[data-collapsed="true"] .ca-list,
    .ca-panel[data-collapsed="true"] .ca-footer { display: none; }

    .ca-header {
      display: grid;
      grid-template-columns: 8px 1fr auto;
      min-height: 62px;
      background: var(--paper-strong);
      border-bottom: 1px solid var(--line);
    }

    .ca-header-mark {
      background:
        repeating-linear-gradient(to bottom, rgba(255,255,255,.9) 0 1px, transparent 1px 9px),
        var(--ink);
    }

    .ca-heading { padding: 11px 12px 10px; min-width: 0; }

    .ca-kicker {
      margin: 0 0 2px;
      color: var(--muted);
      font: 600 10px/1.2 Consolas, "Microsoft YaHei UI", monospace;
      letter-spacing: .11em;
      text-transform: uppercase;
    }

    .ca-title {
      margin: 0;
      font: 700 17px/1.25 "Microsoft YaHei UI", "PingFang SC", sans-serif;
      letter-spacing: -.02em;
    }

    .ca-collapse {
      align-self: center;
      margin-right: 10px;
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      color: var(--ink);
      background: var(--blue-soft);
      border: 1px solid #cbd8e6;
      border-radius: 7px;
      cursor: pointer;
    }

    .ca-collapse:hover { background: #dfeaf5; }
    .ca-collapse:focus-visible { outline: 3px solid rgba(192, 120, 19, .35); outline-offset: 2px; }

    .ca-banner {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px;
      align-items: center;
      padding: 8px 12px;
      color: #68420d;
      background: var(--amber-soft);
      border-bottom: 1px solid #ead3a6;
      font-size: 12px;
      line-height: 1.45;
    }

    .ca-badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      color: #fff;
      background: var(--amber);
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .04em;
      white-space: nowrap;
    }

    .ca-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      grid-auto-rows: max-content;
      align-content: start;
      gap: 8px;
      min-height: 0;
      max-height: calc(100vh - 178px);
      overflow: auto;
      padding: 8px;
      scrollbar-width: thin;
      scrollbar-color: #a7b5c5 transparent;
    }

    .ca-empty {
      margin: 0;
      padding: 22px 16px;
      color: var(--muted);
      background: var(--paper-strong);
      border: 1px dashed #b9c7d6;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.65;
    }

    .ca-warning {
      color: var(--amber);
      background: var(--amber-soft);
      border-color: #c28a3b;
      font-weight: 600;
    }

    .ca-item {
      position: relative;
      min-width: 0;
      min-height: 210px;
      margin: 0;
      padding: 8px 8px 8px 14px;
      overflow: visible;
      background: var(--paper-strong);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .ca-ruler {
      position: absolute;
      inset: 0 auto 0 0;
      width: 7px;
      border-radius: 7px 0 0 7px;
      background:
        repeating-linear-gradient(to bottom, rgba(255,255,255,.94) 0 1px, transparent 1px 8px),
        var(--muted);
    }

    .ca-item[data-tone="positive"] .ca-ruler { background-color: var(--green); }
    .ca-item[data-tone="negative"] .ca-ruler { background-color: var(--red); }
    .ca-item[data-tone="warning"] .ca-ruler { background-color: var(--amber); }

    .ca-item-top {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: start;
    }

    .ca-spec {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.45;
    }

    .ca-sku {
      margin-top: 2px;
      color: var(--muted);
      font: 10px/1.35 Consolas, "Microsoft YaHei UI", monospace;
      overflow-wrap: anywhere;
    }

    .ca-rate {
      font: 700 14px/1.2 Consolas, monospace;
      white-space: nowrap;
    }

    .ca-item[data-tone="positive"] .ca-rate { color: var(--green); }
    .ca-item[data-tone="negative"] .ca-rate { color: var(--red); }
    .ca-item[data-tone="warning"] .ca-rate { color: var(--amber); }

    .ca-values {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      margin-top: 6px;
      overflow: hidden;
      background: var(--line);
      border: 1px solid var(--line);
      border-radius: 6px;
    }

    .ca-value { min-width: 0; padding: 4px 5px; background: var(--paper); }
    .ca-value-label { display: block; color: var(--muted); font-size: 9px; line-height: 1.3; }
    .ca-value-number { display: block; margin-top: 2px; font: 600 11px/1.3 Consolas, monospace; }

    .ca-reason {
      margin: 6px 0 0;
      padding: 4px 7px;
      color: #5c4a31;
      background: #f7f1e8;
      border-radius: 5px;
      font-size: 11px;
      line-height: 1.5;
    }

    .ca-footer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 8px 12px;
      color: var(--muted);
      background: var(--paper-strong);
      border-top: 1px solid var(--line);
      font-size: 10px;
      line-height: 1.4;
    }

    .ca-service { font-weight: 600; }
    .ca-service[data-status="ok"] { color: var(--green); }
    .ca-service[data-status="limited"] { color: var(--amber); }
    .ca-service[data-status="unavailable"] { color: var(--red); }

    .ca-collector {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483000;
      width: min(330px, calc(100vw - 36px));
      padding: 10px 12px 10px 18px;
      color: var(--ink);
      background: var(--paper-strong);
      border: 1px solid #bac8d8;
      border-radius: 7px;
      box-shadow: 0 12px 34px rgba(20, 38, 61, .18);
      font: 12px/1.55 "Microsoft YaHei UI", sans-serif;
      pointer-events: none;
    }

    .ca-collector::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 7px;
      background: repeating-linear-gradient(to bottom, #fff 0 1px, transparent 1px 8px), var(--green);
    }

    .ca-collector strong { display: block; margin-bottom: 1px; }
    .ca-collector span { color: var(--muted); }

    @media (max-width: 1279px) {
      .ca-panel { width: min(640px, calc(100vw - 36px)); }
      .ca-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 720px) {
      .ca-panel { left: 10px; bottom: 10px; width: min(360px, calc(100vw - 20px)); max-height: calc(100vh - 20px); }
      .ca-list { grid-template-columns: minmax(0, 1fr); max-height: calc(100vh - 162px); }
    }

    @media (max-height: 520px) {
      .ca-panel { grid-template-rows: auto auto auto auto; overflow: auto; }
      .ca-list { max-height: none; overflow: visible; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
  `;

  function createElement(documentRef, tag, className, text) {
    const element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function statusPresentation(item) {
    const comparison = item.comparison;
    const comparedCost = item.trueCost ? "真实成本（估算）" : "成本";
    if (item.status === "above_cost") return { tone: "positive", rate: comparison.rate, reason: `高于${comparedCost}` };
    if (item.status === "below_cost") return { tone: "negative", rate: comparison.rate, reason: `低于${comparedCost}` };
    if (item.status === "at_cost") return { tone: "neutral", rate: comparison.rate, reason: `与${comparedCost}持平` };
    if (item.status === "true_cost_unconfigured") {
      const reasons = Array.isArray(item.unconfiguredReasons)
        ? item.unconfiguredReasons.filter(Boolean)
        : [];
      return {
        tone: "warning",
        rate: "—",
        reason: reasons.join("；") || "真实成本配置不完整"
      };
    }
    const messages = {
      service_unavailable: "本机成本服务未启动或数据库不可用。抖店页面不受影响。",
      record_limit_exceeded: "当前页面 SKU 数量超过 2000 条安全上限，请缩小侧栏范围后重试。",
      invalid_cost: "聚水潭成本为负数，无法计算。",
      platform_sku_missing: "页面未识别到平台 SKUID，已停止匹配。",
      mapping_missing: "尚未采集商家编码。请打开对应商品编辑页，让扩展只读记录 ERP 编码。",
      mapping_conflict: "同一 SKUID 观察到不同商家编码，已停止自动匹配。",
      cost_not_found: "当前成本库中未找到该商家编码。沙箱与正式账号数据通常不同。",
      lowest_missing: "最低到手价缺失；没有使用原价、校验价或普惠价替代。",
      cost_missing: "聚水潭成本价为空，无法计算。",
      zero_cost: "聚水潭成本为 0，无法计算较成本涨跌率。"
    };
    return { tone: "warning", rate: "—", reason: messages[item.status] ?? "当前 SKU 暂不可计算。" };
  }

  function signedMoney(value) {
    const text = String(value ?? "");
    return /^[+-]/.test(text) ? `${text[0]}¥${text.slice(1)}` : `¥${text}`;
  }

  function shippingLabel(estimate) {
    return estimate?.shipping_estimated_from_first_weight
      ? "估算运费（按首重估算）"
      : "估算运费";
  }

  function serviceStatusText(state) {
    if (state?.serviceStatus === "ok") {
      if (Number(state.failedBatchCount) > 0) {
        return `成本服务：已连接（${Number(state.failedBatchCount)} 个批次待重试）`;
      }
      if (Number(state.retriedBatchCount) > 0) {
        return "成本服务：已连接（批次重试成功）";
      }
      return "成本服务：已连接";
    }
    if (state?.serviceStatus === "limited") return "成本服务：页面记录过多";
    const timestamp = Date.parse(state?.lastSuccessfulConnectionAt ?? "");
    const recent = Number.isNaN(timestamp)
      ? null
      : new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
    return recent
      ? `成本服务：不可用（最近成功 ${recent}）`
      : "成本服务：不可用";
  }

  function incompleteCostRows(item) {
    const estimate = item?.trueCost ?? {};
    const money = (value) => value === null || value === undefined || value === ""
      ? "未找到"
      : `¥${value}`;
    return [
      [item?.priceSource ? "侧栏最低到手" : "最低到手", money(item?.lowestPrice)],
      ["聚水潭成本", money(estimate.product_cost)],
      [shippingLabel(estimate), money(estimate.shipping_fee)],
      ["基础服务费", money(estimate.basic_service_fee)],
      ["基础费率", estimate.basic_service_fee_rate ?? "未找到"]
    ];
  }

  function mountActivityPanel(documentRef) {
    const existing = documentRef.getElementById("__ca_cost_panel__");
    if (existing?.__costAccountingController) return existing.__costAccountingController;

    const host = documentRef.createElement("div");
    host.id = "__ca_cost_panel__";
    const shadow = host.attachShadow({ mode: "open" });
    const style = documentRef.createElement("style");
    style.textContent = CSS_TEXT;
    shadow.append(style);

    const panel = createElement(documentRef, "section", "ca-panel");
    panel.dataset.collapsed = "false";
    panel.setAttribute("aria-label", "抖店到手价成本夹板");

    const header = createElement(documentRef, "header", "ca-header");
    header.append(createElement(documentRef, "span", "ca-header-mark"));
    const heading = createElement(documentRef, "div", "ca-heading");
    heading.append(createElement(documentRef, "p", "ca-kicker", "COST LEDGER / READ ONLY"));
    heading.append(createElement(documentRef, "h2", "ca-title", "到手价 · 真实成本夹板"));
    header.append(heading);
    const collapse = createElement(documentRef, "button", "ca-collapse", "收");
    collapse.type = "button";
    collapse.setAttribute("aria-label", "折叠成本夹板");
    collapse.setAttribute("aria-expanded", "true");
    header.append(collapse);
    panel.append(header);

    const banner = createElement(documentRef, "div", "ca-banner");
    const badge = createElement(documentRef, "span", "ca-badge", "环境待识别");
    const bannerText = createElement(documentRef, "span", "", "正在读取本机成本服务状态");
    banner.append(badge, bannerText);
    panel.append(banner);

    const list = createElement(documentRef, "div", "ca-list");
    list.append(createElement(documentRef, "p", "ca-empty", "正在识别当前已加载的 SKU…"));
    panel.append(list);

    const footer = createElement(documentRef, "footer", "ca-footer");
    const service = createElement(documentRef, "span", "ca-service", "成本服务：检查中");
    service.dataset.status = "checking";
    const sync = createElement(documentRef, "span", "ca-sync", "同步：—");
    footer.append(service, sync);
    panel.append(footer);
    shadow.append(panel);
    (documentRef.body ?? documentRef.documentElement).append(host);

    function setCollapsed(collapsed) {
      panel.dataset.collapsed = String(collapsed);
      collapse.textContent = collapsed ? "展" : "收";
      collapse.setAttribute("aria-label", collapsed ? "展开成本夹板" : "折叠成本夹板");
      collapse.setAttribute("aria-expanded", String(!collapsed));
    }

    let drawerAutoCollapseApplied = false;
    collapse.addEventListener("click", () => {
      setCollapsed(panel.dataset.collapsed !== "true");
      drawerAutoCollapseApplied = true;
    });

    function update(state) {
      if (state?.activitySource === "all_sku_drawer" && !drawerAutoCollapseApplied) {
        setCollapsed(true);
        drawerAutoCollapseApplied = true;
      }
      const environment = state?.environment ?? "unknown";
      if (environment === "test") {
        badge.textContent = "沙箱演示";
        bannerText.textContent = "共享测试数据，仅验证流程，不用于报名或定价";
      } else if (environment === "production") {
        badge.textContent = "正式数据";
        bannerText.textContent = "仍需完成人工抽查后才能用于业务判断";
      } else {
        badge.textContent = "环境未声明";
        bannerText.textContent = "为避免误判，先确认本机服务启动参数";
      }

      service.dataset.status = state?.serviceStatus ?? "unavailable";
      service.textContent = serviceStatusText(state);
      const items = state?.items ?? [];
      sync.textContent = `侧栏 SKU：${items.length}｜同步：${state?.lastSuccessfulSync ?? "—"}`;
      list.replaceChildren();
      const warnings = Array.from(new Set(
        (state?.warnings ?? [])
          .map((warning) => typeof warning === "string" ? warning : warning?.message)
          .filter(Boolean)
      ));
      if (warnings.length > 0) {
        list.append(createElement(documentRef, "p", "ca-empty ca-warning", `解析提示：${warnings.slice(0, 3).join("；")}`));
      }
      if (items.length === 0) {
        const emptyText = warnings.length > 0
          ? null
          : state?.activitySource === "drawer_closed"
          ? "请由操作者展开商品的“查看全部SKU信息”侧边栏；扩展不会代替点击。"
          : "侧边栏当前区域未识别到可展示的 SKU；请滚动侧边栏后刷新。";
        if (emptyText) list.append(createElement(documentRef, "p", "ca-empty", emptyText));
        return;
      }

      for (const item of items) {
        const presentation = statusPresentation(item);
        const card = createElement(documentRef, "article", "ca-item");
        card.dataset.tone = presentation.tone;
        card.append(createElement(documentRef, "span", "ca-ruler"));
        const top = createElement(documentRef, "div", "ca-item-top");
        const identity = createElement(documentRef, "div");
        identity.append(createElement(documentRef, "p", "ca-spec", item.spec || "未识别规格"));
        identity.append(createElement(documentRef, "div", "ca-sku", `SKUID ${item.platformSkuId ?? "—"}`));
        if (item.mapping?.merchantSkuCode) {
          identity.append(createElement(documentRef, "div", "ca-sku", `ERP ${item.mapping.merchantSkuCode}`));
        }
        top.append(identity, createElement(documentRef, "div", "ca-rate", presentation.rate));
        card.append(top);

        if (item.trueCost && item.comparison && ["above_cost", "below_cost", "at_cost"].includes(item.status)) {
          const estimate = item.trueCost;
          const values = createElement(documentRef, "div", "ca-values");
          for (const [label, number] of [
            [item.priceSource ? "侧栏最低到手" : "最低到手", `¥${item.comparison.lowest}`],
            ["聚水潭成本", `¥${estimate.product_cost}`],
            [shippingLabel(estimate), `¥${estimate.shipping_fee}`],
            ["基础服务费", `¥${estimate.basic_service_fee}`],
            ["真实成本", `¥${item.comparison.cost}`],
            ["成本差额", signedMoney(item.comparison.delta)],
            ["基础费率", estimate.basic_service_fee_rate ?? "—"]
          ]) {
            const value = createElement(documentRef, "div", "ca-value");
            value.append(createElement(documentRef, "span", "ca-value-label", label));
            value.append(createElement(documentRef, "span", "ca-value-number", number));
            values.append(value);
          }
          card.append(values);
        } else if (item.trueCost) {
          const values = createElement(documentRef, "div", "ca-values");
          for (const [label, number] of incompleteCostRows(item)) {
            const value = createElement(documentRef, "div", "ca-value");
            value.append(createElement(documentRef, "span", "ca-value-label", label));
            value.append(createElement(documentRef, "span", "ca-value-number", number));
            values.append(value);
          }
          card.append(values);
        } else if (item.comparison && ["above_cost", "below_cost", "at_cost"].includes(item.status)) {
          const values = createElement(documentRef, "div", "ca-values");
          for (const [label, number] of [
            [item.priceSource ? "侧栏最低到手" : "最低到手", `¥${item.comparison.lowest}`],
            ["成本", `¥${item.comparison.cost}`],
            ["涨跌额", signedMoney(item.comparison.delta)]
          ]) {
            const value = createElement(documentRef, "div", "ca-value");
            value.append(createElement(documentRef, "span", "ca-value-label", label));
            value.append(createElement(documentRef, "span", "ca-value-number", number));
            values.append(value);
          }
          card.append(values);
        } else {
          const values = createElement(documentRef, "div", "ca-values");
          const price = createElement(documentRef, "div", "ca-value");
          price.append(createElement(documentRef, "span", "ca-value-label", item.priceSource ? "侧栏最低到手" : "最低到手"));
          price.append(createElement(documentRef, "span", "ca-value-number", item.lowestPrice ? `¥${item.lowestPrice}` : "—"));
          values.append(price);
          card.append(values);
        }
        card.append(createElement(documentRef, "p", "ca-reason", presentation.reason));
        list.append(card);
      }
    }

    const controller = {
      update,
      destroy() { host.remove(); }
    };
    host.__costAccountingController = controller;
    return controller;
  }

  function mountCollectorBadge(documentRef) {
    const existing = documentRef.getElementById("__ca_mapping_collector__");
    if (existing?.__costAccountingController) return existing.__costAccountingController;
    const host = documentRef.createElement("div");
    host.id = "__ca_mapping_collector__";
    const shadow = host.attachShadow({ mode: "open" });
    const style = documentRef.createElement("style");
    style.textContent = CSS_TEXT;
    const badge = createElement(documentRef, "div", "ca-collector");
    const title = createElement(documentRef, "strong", "", "ERP 编码只读采集");
    const detail = createElement(documentRef, "span", "", "正在识别当前挂载的 SKU 行…");
    badge.append(title, detail);
    shadow.append(style, badge);
    (documentRef.body ?? documentRef.documentElement).append(host);
    const controller = {
      update(result) {
        const stored = Number(result?.added ?? 0) + Number(result?.refreshed ?? 0);
        detail.textContent = `本次识别 ${result?.observed ?? 0} 行，已记录/复核 ${stored} 行，冲突 ${result?.conflicts ?? 0} 行；未修改页面。`;
      },
      error() {
        detail.textContent = "当前表格结构暂未识别；未保存或修改任何输入值。";
      },
      destroy() { host.remove(); }
    };
    host.__costAccountingController = controller;
    return controller;
  }

  const api = {
    CSS_TEXT,
    statusPresentation,
    signedMoney,
    shippingLabel,
    serviceStatusText,
    incompleteCostRows,
    mountActivityPanel,
    mountCollectorBadge
  };
  target.CostAccountingPanel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
