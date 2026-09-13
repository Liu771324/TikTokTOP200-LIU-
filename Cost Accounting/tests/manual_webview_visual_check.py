"""Headless visual smoke test for the packaged WebView2 static UI."""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "cost_sync" / "webview_static" / "index.html"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--entrypoint", type=Path, default=ENTRYPOINT)
    parser.add_argument("--release-v2", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1180, "height": 780}, device_scale_factor=1)
        page.on("console", lambda message: errors.append(f"console:{message.type}:{message.text}") if message.type == "error" else None)
        page.on("pageerror", lambda error: errors.append(f"page:{error}"))
        page.goto(args.entrypoint.resolve().as_uri())
        page.wait_for_load_state("networkidle")
        page.evaluate(
            """
            () => {
              const health = {
                expected: true,
                health_present: true,
                owns_service: true,
                port: 8765,
                database_path: 'C:/data/cost_accounting.sqlite3',
                health: {
                  status: 'ok', environment: 'test', enabled_count: 36796,
                  verified_mapping_count: 92217, last_successful_sync: '2026-09-03T09:42:00+08:00',
                  mapping_shops: ['忆百草小店']
                },
                log: '2026-09-03 09:42:00 [INFO] 成本服务已就绪\\n2026-09-03 09:42:03 [INFO] 等待资料操作'
              };
              const files = {
                ordinary: {path: 'C:/data/ordinary.xlsx', name: '聚水潭普通商品9.3.xlsx'},
                combination: {path: 'C:/data/combination.xlsx', name: '聚水潭组合商品9.3.xlsx'},
                mapping: {path: 'C:/data/mapping.xlsx', name: '忆百草小店9.3.xlsx'}
              };
              window.__historyEntries = [
                {
                  update_id: 'mapping:4', kind: 'mapping', title: '店铺映射更新',
                  status: 'applied', completed_at: '2026-09-04T09:37:55+08:00',
                  is_latest: true, can_rollback: true, shop_name: '测试店铺',
                  verified_rows: 54144, inserted_rows: 310, updated_rows: 0,
                  removed_rows: 33, pending_rows: 1633
                },
                {
                  update_id: 'catalog:2026-09-04T09:37:02+08:00', kind: 'catalog',
                  title: '商品成本更新', status: 'applied',
                  completed_at: '2026-09-04T09:37:02+08:00', is_latest: false,
                  can_rollback: false, enabled_count: 36798,
                  ordinary_count: 18420, combination_count: 18378
                }
              ];
              window.__rollbackMode = 'success';
              window.__rollbackCalls = [];
              window.__stateCalls = [];
              window.__historyReads = 0;
              window.__shippingCalls = [];
              window.__serviceFeeCalls = [];
              window.__serviceFeeRates = [{
                id: 1,
                major_category: '食品饮料',
                category_levels: ['食品饮料', '休闲食品', '坚果炒货', '即食板栗'],
                rate: '0.05', effective_from: '2026-09-01', enabled: true,
                specificity: 4, product_coverage_count: 12,
                note: '抖店基础服务费表', created_at: '2026-09-01T09:00:00+08:00',
                updated_at: '2026-09-01T09:00:00+08:00'
              }];
              window.__shippingTemplates = [{
                id: 1, name: '忆百草默认重量模板', shop_name: '忆百草小店',
                first_weight: '1', first_fee: '6', additional_weight: '0.5',
                additional_fee: '2', default_region: '河北省', enabled: true, is_default: true,
                product_count: 16,
                region_rules: [{region: '北京市', first_fee: '3', additional_fee: '1', free_shipping: false}]
              }];
              window.__failNextState = false;
              window.pywebview = {api: {invoke: async (action, payload) => {
                if (action === 'get_state') {
                  window.__stateCalls.push(payload);
                  if (window.__failNextState) {
                    window.__failNextState = false;
                    throw new Error('simulated state refresh failure');
                  }
                  return {ok: true, result: health};
                }
                if (action === 'get_update_history') {
                  window.__historyReads += 1;
                  return {ok: true, result: window.__historyEntries};
                }
                if (action === 'get_shipping_templates') {
                  return {ok: true, result: window.__shippingTemplates};
                }
                if (action === 'get_shipping_product_bindings') {
                  return {ok: true, result: {unbound_count: 1, products: [
                    {shop_name: '忆百草小店', douyin_product_id: 'P-100', product_name: '桂花糕', sku_count: 2, template_id: null},
                    {shop_name: '忆百草小店', douyin_product_id: 'P-200', product_name: '茉莉花茶', sku_count: 1, template_id: 1}
                  ]}};
                }
                if (action === 'get_basic_service_fee_rates') {
                  return {ok: true, result: window.__serviceFeeRates};
                }
                if (action === 'get_basic_service_fee_coverage') {
                  await new Promise(resolve => setTimeout(resolve, 500));
                  return {ok: true, result: window.__serviceFeeRates.map(item => ({
                    rate_id: item.id,
                    product_coverage_count: item.product_coverage_count || 0
                  }))};
                }
                if (action === 'preview_basic_service_fee_change') {
                  window.__serviceFeeCalls.push({action, payload});
                  return {ok: true, result: {...payload, preview_id: 'service-fee-preview'}};
                }
                if (action === 'apply_basic_service_fee_change') {
                  window.__serviceFeeCalls.push({action, payload});
                  const change = window.__serviceFeeCalls.findLast(
                    call => call.action === 'preview_basic_service_fee_change'
                  ).payload;
                  if (change.operation === 'create_version') {
                    window.__serviceFeeRates = window.__serviceFeeRates.concat({
                      id: 2, major_category: change.major_category,
                      category_levels: change.category_levels, rate: change.rate,
                      special_channel_rate: change.special_channel_rate,
                      specificity: 4, product_coverage_count: 0,
                      effective_from: change.effective_from, note: change.note,
                      enabled: true, created_at: 'now', updated_at: 'now'
                    });
                  } else {
                    window.__serviceFeeRates = window.__serviceFeeRates.map(item =>
                      item.id === change.rate_id ? {...item, enabled: change.enabled} : item
                    );
                  }
                  return {ok: true, result: {
                    operation: change.operation, rate_id: change.rate_id || 2,
                    backup_file: 'cost.before-service-fee.sqlite3.bak',
                    update_id: 'service-fee-update'
                  }};
                }
                if (action === 'preview_shipping_template') {
                  window.__shippingCalls.push({action, payload});
                  return {ok: true, result: {
                    ...payload, preview_id: 'shipping-preview',
                    mode: payload.template_id ? 'update' : 'create'
                  }};
                }
                if (action === 'apply_shipping_template') {
                  window.__shippingCalls.push({action, payload});
                  const preview = window.__shippingCalls.findLast(call => call.action === 'preview_shipping_template').payload;
                  const saved = {...preview, id: preview.template_id || 2};
                  delete saved.template_id;
                  window.__shippingTemplates = window.__shippingTemplates.filter(item => item.id !== saved.id).concat(saved);
                  return {ok: true, result: {
                    template_id: saved.id, mode: preview.template_id ? 'update' : 'create',
                    backup_file: 'cost.before-shipping.sqlite3.bak'
                  }};
                }
                if (action === 'rollback_update') {
                  window.__rollbackCalls.push(payload);
                  await new Promise(resolve => setTimeout(resolve, 300));
                  if (window.__rollbackMode === 'failure') {
                    return {ok: false, error: '更新前备份 SHA-256 不匹配，禁止回滚'};
                  }
                  if (window.__rollbackMode === 'uncertain') {
                    throw new Error('simulated bridge disconnect');
                  }
                  window.__historyEntries[0] = {
                    ...window.__historyEntries[0], status: 'rolled_back',
                    is_latest: false, can_rollback: false,
                    rolled_back_at: '2026-09-04T10:00:00+08:00'
                  };
                  if (window.__rollbackMode === 'success_refresh_failure') {
                    window.__failNextState = true;
                  }
                  return {ok: true, result: {
                    update_id: payload.update_id,
                    recovery_backup_file: 'cost.before-update-rollback.sqlite3.bak',
                    rebuilt_excel: false
                  }};
                }
                if (action === 'get_mapping_reviews') return {ok: true, result: {
                  total_open: 2,
                  items: [
                    {
                      id: 1, shop_name: '忆百草小店', douyin_sku_id: 'D-CONFLICT-001',
                      douyin_product_id: 'P-001', merchant_sku_code: 'SKU-001',
                      product_name: '养生茶礼盒', specification: '20 袋 / 盒',
                      reason: 'conflict', source_file: '忆百草小店9.3.xlsx', source_row: 128,
                      current_shop_name: '测试二店', current_jushuitan_sku_id: 'SKU-OLD',
                      captured_at: '2026-09-05T09:00:00+08:00'
                    },
                    {
                      id: 2, shop_name: '忆百草小店', douyin_sku_id: 'D-PENDING-002',
                      douyin_product_id: 'P-002', merchant_sku_code: 'SKU-002-待确认',
                      product_name: '草本泡脚包', specification: '30 包',
                      reason: 'pending', source_file: '忆百草小店9.3.xlsx', source_row: 365,
                      current_shop_name: null, current_jushuitan_sku_id: null,
                      captured_at: '2026-09-05T09:00:00+08:00'
                    }
                  ]
                }};
                if (action === 'choose_file') return {ok: true, result: files[payload.kind]};
                if (action === 'preview_catalog') return {ok: true, result: {
                  preview_id: 'catalog-preview', ready_to_import: true,
                  ordinary_products: 18420, ordinary_rows: 18420,
                  combination_rows: 29754, combination_products: 18376,
                  merged_products: 36796, empty_cost_products: 64,
                  resolved_overlap_count: 8, added_products: 14, removed_products: 3,
                  cost_changed_products: 126, status_changed_products: 4,
                  conflicting_overlaps: []
                }};
                if (action === 'preview_mapping') return {ok: true, result: {
                  preview_id: 'mapping-preview', ready_to_import: true, shop_name: payload.shop_name,
                  unique_douyin_skus: 55503, matched_rows: 53867, new_rows: 18,
                  changed_rows: 6, removed_rows: 2, current_shop_rows: 53851,
                  pending_rows: 1636, duplicate_rows: 0, invalid_rows: 0,
                  complete_category_rows: 53120, incomplete_category_rows: 747,
                  service_fee_matched_rows: 50866, service_fee_unconfigured_rows: 2132,
                  service_fee_disabled_rows: 122,
                  conflict_count: 0, conflicting_sku_ids: [], shop_file_mismatch: false,
                  review_count: 1636, can_save_reviews: true
                }};
                return {ok: true, result: true};
              }}};
              window.__desktopAutoStart = false;
              window.__desktopBridgeReady = true;
              window.dispatchEvent(new Event('desktop-bridge-ready'));
            }
            """
        )
        expected_pages = 7 if args.release_v2 else 8
        if page.locator(".nav-item").count() != expected_pages:
            errors.append(f"navigation:expected-{expected_pages}-entries")
        if page.locator('section[id^="page-"]').count() != expected_pages:
            errors.append(f"navigation:expected-{expected_pages}-pages")
        if args.release_v2 and page.get_by_text("人工核验", exact=True).count() != 0:
            errors.append("release:manual-review-entry-present")
        page.locator("#service-status").filter(has_text="成本服务已就绪").wait_for()
        page.screenshot(path=args.output / "overview-1180x780.png", full_page=True)

        page.get_by_role("button", name="今日成本更新").click()
        page.locator('[data-file-kind="ordinary"]').click()
        page.locator('[data-file-kind="combination"]').click()
        page.locator("#preview-catalog").click()
        page.locator("#catalog-preview-title").filter(has_text="可以安全更新").wait_for()
        ordinary = page.locator("#catalog-ordinary")
        expected_ordinary = "18,420（18,420 行）"
        if ordinary.text_content() != expected_ordinary:
            errors.append("catalog:ordinary-metric-text-mismatch")
        metric_layout = ordinary.evaluate(
            """element => ({
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
              overflow: getComputedStyle(element).overflow,
              textOverflow: getComputedStyle(element).textOverflow,
              whiteSpace: getComputedStyle(element).whiteSpace,
              documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              withinPreview: (() => {
                const elementRect = element.getBoundingClientRect();
                const previewRect = element.closest('.preview-card').getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(element);
                const textRects = Array.from(range.getClientRects());
                return elementRect.left >= previewRect.left && elementRect.right <= previewRect.right &&
                  elementRect.top >= previewRect.top && elementRect.bottom <= previewRect.bottom &&
                  textRects.every(rect => rect.left >= elementRect.left && rect.right <= elementRect.right &&
                    rect.top >= elementRect.top && rect.bottom <= elementRect.bottom);
              })()
            })"""
        )
        if (
            metric_layout["scrollWidth"] > metric_layout["clientWidth"]
            or metric_layout["scrollHeight"] > metric_layout["clientHeight"]
            or metric_layout["overflow"] == "hidden"
            or metric_layout["textOverflow"] == "ellipsis"
            or metric_layout["whiteSpace"] == "nowrap"
            or metric_layout["documentOverflow"]
            or not metric_layout["withinPreview"]
        ):
            errors.append("layout:ordinary-metric-clipped-at-1180px")
        page.screenshot(path=args.output / "catalog-1180x780.png", full_page=True)

        page.get_by_role("button", name="抖店商品对应关系").click()
        page.locator("#shop-name").fill("忆百草小店")
        page.locator('[data-file-kind="mapping"]').click()
        page.locator("#preview-mapping").click()
        page.locator("#mapping-preview-title").filter(has_text="可以安全更新").wait_for()
        page.screenshot(path=args.output / "mapping-1180x780.png", full_page=True)

        page.get_by_role("button", name="更新历史").click()
        page.locator(".history-entry.latest").filter(has_text="当前最新").wait_for()
        page.wait_for_timeout(250)
        rollback_button = page.get_by_role("button", name="回滚这次更新")
        rollback_button.wait_for()
        if page.locator(".history-entry", has_text="可回滚").count() != 1:
            errors.append("history:exactly-one-rollbackable-entry-required")
        rollback_button.click()
        page.get_by_role("button", name="取消").click()
        if page.evaluate("window.__rollbackCalls.length") != 0:
            errors.append("history:cancel-must-not-submit")
        history_reads_before = page.evaluate("window.__historyReads")
        state_reads_before = page.evaluate("window.__stateCalls.length")
        rollback_button.click()
        page.get_by_role("button", name="确认回滚").click()
        page.locator("body.busy").wait_for()
        if not rollback_button.is_disabled():
            errors.append("history:rollback-button-must-disable-while-submitting")
        page.evaluate("document.querySelector('.history-rollback').click()")
        page.locator("#history-result").filter(has_text="回滚完成").wait_for()
        if page.evaluate("window.__rollbackCalls.length") != 1:
            errors.append("history:success-must-submit-once")
        payload_keys = page.evaluate("Object.keys(window.__rollbackCalls[0]).sort()")
        if payload_keys != ["update_id"]:
            errors.append("history:rollback-payload-must-only-contain-update-id")
        if page.evaluate("window.__historyReads") <= history_reads_before:
            errors.append("history:success-must-refresh-history")
        if page.evaluate("window.__stateCalls.length") <= state_reads_before:
            errors.append("history:success-must-refresh-state-and-logs")
        if page.locator(".history-entry", has_text="已回滚").count() != 1:
            errors.append("history:success-must-render-rolled-back-state")

        page.evaluate(
            """() => {
              window.__historyEntries[0] = {
                ...window.__historyEntries[0], status: 'applied',
                is_latest: true, can_rollback: true, rolled_back_at: null
              };
              window.__rollbackMode = 'failure';
            }"""
        )
        page.locator("#refresh-history").click()
        rollback_button = page.get_by_role("button", name="回滚这次更新")
        rollback_button.click()
        page.get_by_role("button", name="确认回滚").click()
        page.locator("#history-result").filter(has_text="回滚失败").wait_for()
        if not rollback_button.is_disabled():
            errors.append("history:failure-must-require-manual-refresh-before-retry")

        page.evaluate("window.__rollbackMode = 'uncertain'")
        page.locator("#refresh-history").click()
        rollback_button = page.get_by_role("button", name="回滚这次更新")
        rollback_button.click()
        page.get_by_role("button", name="确认回滚").click()
        page.locator("#history-result").filter(has_text="结果不明确").wait_for()
        if not rollback_button.is_disabled():
            errors.append("history:uncertain-must-require-manual-refresh-before-retry")

        page.evaluate(
            """() => {
              window.__historyEntries[0] = {
                ...window.__historyEntries[0], status: 'applied',
                is_latest: true, can_rollback: true, rolled_back_at: null
              };
              window.__rollbackMode = 'success_refresh_failure';
            }"""
        )
        page.locator("#refresh-history").click()
        rollback_button = page.get_by_role("button", name="回滚这次更新")
        rollback_button.click()
        page.get_by_role("button", name="确认回滚").click()
        page.locator("#history-result").filter(has_text="回滚完成").wait_for()
        refresh_failure_result = page.locator("#history-result").text_content()
        if "结果不明确" in refresh_failure_result or "刷新未完成" not in refresh_failure_result:
            errors.append("history:confirmed-success-must-not-become-uncertain-on-refresh-failure")
        page.screenshot(path=args.output / "history-1180x780.png", full_page=True)
        page.evaluate(
            """() => {
              window.__historyEntries[0] = {
                ...window.__historyEntries[0], status: 'applied',
                is_latest: true, can_rollback: true, rolled_back_at: null
              };
              window.__rollbackMode = 'success';
            }"""
        )
        page.locator("#refresh-history").click()

        if page.get_by_role("button", name="基础服务费").count() != 0:
            page.get_by_role("button", name="基础服务费").click()
            page.locator(".service-fee-version", has_text="即食板栗").wait_for()
            if page.get_by_role("button", name="新建空白版本").is_disabled():
                errors.append("service-fee:coverage-statistics-must-not-lock-directory")
            page.get_by_role("button", name="新建空白版本").click()
            for selector, value in (
                ("#service-fee-major-category", "食品饮料"),
                ("#service-fee-category-1", "食品饮料"),
                ("#service-fee-category-2", "休闲食品"),
                ("#service-fee-category-3", "坚果炒货"),
                ("#service-fee-category-4", "即食核桃"),
                ("#service-fee-rate", "0.045"),
                ("#service-fee-effective", "2026-10-01"),
                ("#service-fee-note", "新版费率表"),
            ):
                page.locator(selector).fill(value)
            page.get_by_role("button", name="预览新版本").click()
            page.get_by_role("button", name="确认新增版本").click()
            page.locator("#service-fee-result").filter(has_text="已新增").wait_for()
            if page.evaluate("window.__serviceFeeCalls[0].payload.rate") != "0.045":
                errors.append("service-fee:new-version-rate-not-submitted")
            page.locator(".service-fee-version", has_text="2026-10-01").click()
            page.get_by_role("button", name="停用所选版本").click()
            page.get_by_role("button", name="确认停用").click()
            page.locator("#service-fee-result").filter(has_text="已停用").wait_for()
            if page.evaluate("window.__serviceFeeCalls.map(call => call.action)") != [
                "preview_basic_service_fee_change", "apply_basic_service_fee_change",
                "preview_basic_service_fee_change", "apply_basic_service_fee_change"
            ]:
                errors.append("service-fee:preview-confirm-sequence-required")
            page.screenshot(path=args.output / "service-fee-1180x780.png", full_page=True)

            page.get_by_role("button", name="运费模板").click()
            page.locator(".shipping-template", has_text="忆百草默认重量模板").wait_for()
            if page.locator(".shipping-product").count() != 1 or page.get_by_text("桂花糕", exact=True).count() != 1:
                errors.append("shipping:unbound-filter-must-be-default")
            page.locator("#shipping-binding-status").select_option("all")
            page.locator("#shipping-binding-search").fill("P-200")
            if page.locator(".shipping-product").count() != 1 or page.get_by_text("茉莉花茶", exact=True).count() != 1:
                errors.append("shipping:name-or-id-search-must-filter-products")
            page.locator("#shipping-binding-search").fill("")
            page.locator("#shipping-binding-status").select_option("unbound")
            page.get_by_role("button", name="新建模板").click()
            page.locator("#shipping-name").fill("铭香馆重量模板")
            page.locator("#shipping-first-fee").fill("6")
            page.locator("#shipping-additional-fee").fill("2")
            page.get_by_role("button", name="添加地区").click()
            rule = page.locator(".shipping-rule")
            rule.locator(".shipping-rule-region").fill("北京市")
            rule.locator(".shipping-rule-first-fee").fill("3")
            rule.locator(".shipping-rule-additional-fee").fill("1")
            page.get_by_role("button", name="预览并确认").click()
            page.get_by_role("button", name="确认新建").click()
            page.locator("#shipping-result").filter(has_text="已新建").wait_for()
            if page.evaluate("window.__shippingCalls.map(call => call.action)") != [
                "preview_shipping_template", "apply_shipping_template"
            ]:
                errors.append("shipping:preview-and-confirm-sequence-required")
            if page.evaluate("window.__shippingCalls[0].payload.region_rules[0].region") != "北京市":
                errors.append("shipping:region-rule-not-submitted")
            if page.evaluate("window.__shippingCalls[0].payload.is_default") is not False:
                errors.append("shipping:reusable-template-must-not-be-shop-default")
            page.screenshot(path=args.output / "shipping-1180x780.png", full_page=True)

        page.get_by_role("button", name="运行日志").click()
        page.locator("#log-content").filter(has_text="成本服务已就绪").wait_for()
        page.wait_for_timeout(250)
        page.locator("#toast").wait_for(state="hidden", timeout=8000)
        page.screenshot(path=args.output / "logs-1180x780.png", full_page=True)

        if page.get_by_role("button", name="运费模板").count() != 0:
            page.get_by_role("button", name="运费模板").click()
            page.locator(".shipping-template", has_text="铭香馆重量模板").wait_for()
            page.wait_for_timeout(250)
            page.screenshot(path=args.output / "shipping-compact-700x760.png", full_page=True)
            shipping_overflow = page.evaluate(
                "document.documentElement.scrollWidth > document.documentElement.clientWidth"
            )
            if shipping_overflow:
                errors.append("shipping:horizontal-overflow-at-700px")
            if not args.release_v2:
                page.get_by_role("button", name="人工核验").click()
                page.locator(".review-card.conflict").filter(has_text="测试二店").wait_for()
                page.wait_for_timeout(250)
                page.screenshot(path=args.output / "reviews-1180x780.png", full_page=True)

        page.set_viewport_size({"width": 700, "height": 760})
        page.get_by_role("button", name="今日成本更新").click()
        page.wait_for_timeout(250)
        compact_metric_layout = ordinary.evaluate(
            """element => ({
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
              withinPreview: (() => {
                const elementRect = element.getBoundingClientRect();
                const previewRect = element.closest('.preview-card').getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(element);
                return elementRect.left >= previewRect.left && elementRect.right <= previewRect.right &&
                  Array.from(range.getClientRects()).every(rect =>
                    rect.left >= elementRect.left && rect.right <= elementRect.right &&
                    rect.top >= elementRect.top && rect.bottom <= elementRect.bottom);
              })()
            })"""
        )
        if (
            compact_metric_layout["scrollWidth"] > compact_metric_layout["clientWidth"]
            or compact_metric_layout["scrollHeight"] > compact_metric_layout["clientHeight"]
            or not compact_metric_layout["withinPreview"]
        ):
            errors.append("layout:ordinary-metric-clipped-at-700px")
        page.screenshot(path=args.output / "catalog-compact-700x760.png", full_page=True)
        overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
        if overflow:
            errors.append("layout:horizontal-overflow-at-700px")
        page.get_by_role("button", name="更新历史").click()
        page.locator(".history-entry.latest").wait_for()
        page.wait_for_timeout(250)
        page.screenshot(path=args.output / "history-compact-700x760.png", full_page=True)
        history_overflow = page.evaluate(
            "document.documentElement.scrollWidth > document.documentElement.clientWidth"
        )
        if history_overflow:
            errors.append("history:horizontal-overflow-at-700px")
        if page.get_by_role("button", name="基础服务费").count() != 0:
            page.get_by_role("button", name="基础服务费").click()
            page.locator(".service-fee-version").first.wait_for()
            page.wait_for_timeout(250)
            if page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
                errors.append("service-fee:horizontal-overflow-at-700px")
            page.get_by_role("button", name="运费模板").click()
            page.locator(".shipping-template").first.wait_for()
            page.wait_for_timeout(250)
            if page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"):
                errors.append("shipping:horizontal-overflow-at-700px")
            if not args.release_v2:
                page.get_by_role("button", name="人工核验").click()
                page.locator(".review-card.pending").wait_for()
                page.wait_for_timeout(250)
                page.screenshot(path=args.output / "reviews-compact-700x760.png", full_page=True)
                review_overflow = page.evaluate(
                    "document.documentElement.scrollWidth > document.documentElement.clientWidth"
                )
                if review_overflow:
                    errors.append("reviews:horizontal-overflow-at-700px")
        browser.close()

    if errors:
        raise RuntimeError("\n".join(errors))
    print(f"Visual smoke test passed: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
