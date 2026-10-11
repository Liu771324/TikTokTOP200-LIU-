import http.server
import http.client
import io
import logging
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest import mock

from openpyxl import Workbook

if sys.platform == "win32":
    import winreg

from cost_sync.database import connect_database, set_sync_state
from cost_sync.desktop_app import (
    AssistantService,
    ServicePaths,
    build_parser,
    desktop_window_instance,
    main as desktop_main,
    installed_data_directory,
    probe_health,
    read_log_tail,
)
from cost_sync.local_api import EXTENSION_ORIGIN, MANAGEMENT_ORIGIN, database_service_id
from cost_sync.service_fee import save_basic_service_fee_rate
from cost_sync.webview_app import (
    BRIDGE_ACTIONS,
    SERIAL_ACTIONS,
    DesktopBridge,
    DesktopWindowController,
    _normalized_page_url,
    run_webview_app,
    run_webview_smoke_test,
    webview_asset_directory,
    webview_entrypoint,
)


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
INSTALLER = ROOT / "windows" / "Install-CostAssistant.ps1"
INSTALLER_CMD = ROOT / "windows" / "Install-CostAssistant.cmd"
EDGE_SETUP_HELPER = ROOT / "windows" / "Show-EdgeExtensionSetup.ps1"
RELEASE_ASSET_BUILDER = ROOT / "windows" / "prepare_release_webview.py"


def delete_registry_tree(root, subkey: str) -> None:
    try:
        with winreg.OpenKey(root, subkey, 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
            children = []
            index = 0
            while True:
                try:
                    children.append(winreg.EnumKey(key, index))
                    index += 1
                except OSError:
                    break
        for child in children:
            delete_registry_tree(root, f"{subkey}\\{child}")
        winreg.DeleteKey(root, subkey)
    except FileNotFoundError:
        return


def unused_local_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class DesktopAssistantServiceTests(unittest.TestCase):
    @staticmethod
    def write_book(path: Path, headers: tuple[str, ...], rows: list[tuple]) -> None:
        workbook = Workbook()
        worksheet = workbook.active
        worksheet.append(headers)
        for row in rows:
            worksheet.append(row)
        workbook.save(path)
        workbook.close()

    def test_development_launch_defaults_to_project_data_auto_start_and_webview_only(self) -> None:
        args = build_parser().parse_args([])

        self.assertEqual((ROOT / "storage" / "test").resolve(), Path(args.data_dir).resolve())
        self.assertEqual(installed_data_directory().resolve(), Path(args.data_dir).resolve())
        self.assertTrue(args.auto_start)
        self.assertFalse(hasattr(args, "use_tkinter"))
        with mock.patch("sys.stderr", new=io.StringIO()):
            with self.assertRaises(SystemExit):
                build_parser().parse_args(["--tkinter"])
        self.assertTrue(build_parser().parse_args(["--webview-smoke-test"]).webview_smoke_test)

    def test_log_tail_skips_unchanged_file_and_limits_rendered_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            log_path = Path(temp_dir) / "cost-assistant.log"
            log_path.write_text("\n".join(f"line-{index}" for index in range(20)), encoding="utf-8")

            content, signature = read_log_tail(log_path, max_lines=3)
            unchanged, unchanged_signature = read_log_tail(
                log_path, known_signature=signature, max_lines=3
            )

            self.assertEqual(content, "line-17\nline-18\nline-19")
            self.assertIsNone(unchanged)
            self.assertEqual(signature, unchanged_signature)

    def test_health_probe_treats_malformed_http_response_as_unavailable(self) -> None:
        with mock.patch(
            "cost_sync.desktop_app.urllib.request.urlopen",
            side_effect=http.client.BadStatusLine("not-http"),
        ):
            self.assertIsNone(probe_health(8765))

    def test_embedded_service_starts_answers_health_and_stops(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = ServicePaths.from_data_directory(Path(temp_dir) / "data")
            paths.database.parent.mkdir(parents=True)
            with connect_database(paths.database) as connection:
                connection.commit()
            port = unused_local_port()
            service = AssistantService(paths, port=port)

            self.assertEqual("started", service.start())
            self.assertTrue(service.owns_running_service)
            health = probe_health(port)
            self.assertEqual("ok", health["status"])
            self.assertEqual("test", health["environment"])
            self.assertEqual(16, len(health["service_id"]))
            self.assertTrue(service.stop())
            self.assertFalse(service.owns_running_service)
            self.assertIsNone(probe_health(port, timeout=0.1))

    def test_embedded_service_allows_extension_reads_but_no_http_management(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = ServicePaths.from_data_directory(Path(temp_dir) / "data")
            paths.database.parent.mkdir(parents=True)
            with connect_database(paths.database) as connection:
                connection.commit()
            port = unused_local_port()
            service = AssistantService(paths, port=port)
            self.assertEqual("started", service.start())
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                connection.request("GET", "/health", headers={"Origin": EXTENSION_ORIGIN})
                response = connection.getresponse()
                response.read()
                self.assertEqual(200, response.status)
                self.assertEqual(EXTENSION_ORIGIN, response.getheader("Access-Control-Allow-Origin"))
                connection.close()

                for origin in (EXTENSION_ORIGIN, MANAGEMENT_ORIGIN):
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                    connection.request(
                        "POST",
                        "/api/v1/admin/catalog/preview",
                        body=b"{}",
                        headers={"Content-Type": "application/json", "Origin": origin},
                    )
                    response = connection.getresponse()
                    response.read()
                    self.assertEqual(403, response.status)
                    connection.close()
            finally:
                service.stop()

    def test_desktop_bridge_reuses_preview_confirm_and_backup_managers(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            paths = ServicePaths.from_data_directory(root / "data")
            paths.database.parent.mkdir(parents=True)
            with connect_database(paths.database) as connection:
                connection.commit()
            ordinary = root / "ordinary.xlsx"
            combination = root / "combination.xlsx"
            mapping = root / "mapping.xlsx"
            self.write_book(
                ordinary,
                ("商品编码", "商品名称", "成本价", "商品状态", "创建时间", "修改时间"),
                [("SKU-1", "普通商品", "10", "启用", "", "")],
            )
            self.write_book(
                combination,
                ("组合商品编码", "组合商品名称", "组合成本价", "商品状态", "创建时间", "修改时间", "商品编码", "数量", "子商品成本价"),
                [("SKU-2", "组合商品", "20", "启用", "", "", "SKU-1", "2", "10")],
            )
            self.write_book(
                mapping,
                (
                    "商品ID", "商品名称", "一级类目", "二级类目", "三级类目", "四级类目",
                    "商家SKU编码", "规格ID（SKUID）", "商品规格",
                ),
                [
                    (
                        "P-1", "普通商品", "食品饮料", "休闲食品", "坚果炒货", "",
                        "SKU-1", "D-1", "默认",
                    ),
                    (
                        "P-2", "待核验商品", "食品饮料", "休闲食品", "坚果炒货", "",
                        "SKU-TYPO", "D-2", "默认",
                    ),
                ],
            )
            service = AssistantService(paths, port=unused_local_port())

            catalog_preview = service.admin.preview_catalog(ordinary, combination)
            self.assertTrue(catalog_preview["ready_to_import"])
            self.assertEqual(2, catalog_preview["merged_products"])
            catalog_result = service.admin.apply_catalog(catalog_preview["preview_id"])
            self.assertEqual(2, catalog_result["enabled_count"])
            self.assertTrue((paths.database.parent / catalog_result["backup_file"]).is_file())
            self.assertTrue(paths.output_excel.is_file())

            mapping_preview = service.admin.preview_mapping("店铺A", mapping)
            self.assertTrue(mapping_preview["ready_to_import"])
            self.assertEqual(1, mapping_preview["matched_rows"])
            self.assertEqual(1, mapping_preview["review_count"])
            mapping_result = service.admin.apply_mapping(mapping_preview["preview_id"])
            self.assertEqual(1, mapping_result["inserted_rows"])
            self.assertTrue((paths.database.parent / mapping_result["backup_file"]).is_file())
            reviews = service.admin.get_mapping_reviews()
            self.assertEqual(1, reviews["total_open"])
            self.assertEqual("D-2", reviews["items"][0]["douyin_sku_id"])

    def test_preview_from_second_window_invalidates_stale_first_window_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            paths = ServicePaths.from_data_directory(root / "data")
            paths.database.parent.mkdir(parents=True)
            with connect_database(paths.database) as connection:
                connection.commit()
            ordinary = root / "ordinary.xlsx"
            combination = root / "combination.xlsx"
            self.write_book(
                ordinary,
                ("商品编码", "商品名称", "成本价", "商品状态", "创建时间", "修改时间"),
                [("SKU-1", "普通商品", "10", "启用", "", "")],
            )
            self.write_book(
                combination,
                ("组合商品编码", "组合商品名称", "组合成本价", "商品状态", "创建时间", "修改时间", "商品编码", "数量", "子商品成本价"),
                [("SKU-2", "组合商品", "20", "启用", "", "", "SKU-1", "2", "10")],
            )
            first = AssistantService(paths, port=unused_local_port())
            second = AssistantService(paths, port=unused_local_port())

            first_preview = first.admin.preview_catalog(ordinary, combination)
            second_preview = second.admin.preview_catalog(ordinary, combination)
            second.admin.apply_catalog(second_preview["preview_id"])

            with self.assertRaisesRegex(ValueError, "其他窗口"):
                first.admin.apply_catalog(first_preview["preview_id"])

    def test_existing_expected_service_is_not_owned_or_stopped(self) -> None:
        class HealthHandler(http.server.BaseHTTPRequestHandler):
            service_id = ""

            def do_GET(self):
                body = json.dumps({
                    "status": "ok",
                    "environment": "test",
                    "service_id": self.service_id,
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                return

        with tempfile.TemporaryDirectory() as temp_dir:
            paths = ServicePaths.from_data_directory(Path(temp_dir) / "data")
            HealthHandler.service_id = database_service_id(paths.database)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                service = AssistantService(
                    paths,
                    port=server.server_port,
                )
                self.assertEqual("already_running", service.start())
                self.assertFalse(service.owns_running_service)
                self.assertFalse(service.stop())
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_legacy_health_without_database_identity_is_not_attached(self) -> None:
        service = AssistantService(
            ServicePaths.from_data_directory(Path(tempfile.gettempdir()) / "identity-test")
        )

        self.assertFalse(service.matches_running_service({"status": "ok", "environment": "test"}))


class WebViewDesktopTests(unittest.TestCase):
    class StubWindow:
        def __init__(self, url: str) -> None:
            self.url = url

        def get_current_url(self) -> str:
            return self.url

    def make_bridge(self, root: Path) -> tuple[DesktopBridge, AssistantService, "WebViewDesktopTests.StubWindow"]:
        paths = ServicePaths.from_data_directory(root / "data")
        paths.database.parent.mkdir(parents=True, exist_ok=True)
        with connect_database(paths.database) as connection:
            connection.commit()
        service = AssistantService(paths, port=unused_local_port())
        bridge = DesktopBridge(service, logging.getLogger("test-webview-bridge"))
        window = self.StubWindow("http://127.0.0.1:43123/index.html")
        bridge._attach_window(window)
        bridge._trust_current_page()
        return bridge, service, window

    def test_local_assets_are_packaged_as_three_self_contained_resources(self) -> None:
        asset_root = webview_asset_directory()
        self.assertEqual(asset_root / "index.html", webview_entrypoint())
        for name in ("index.html", "styles.css", "refresh_model.js", "shipping_filters.js", "app.js"):
            self.assertTrue((asset_root / name).is_file(), name)
        html = (asset_root / "index.html").read_text(encoding="utf-8")
        self.assertIn("connect-src 'none'", html)
        self.assertIn('href="styles.css"', html)
        self.assertIn('src="refresh_model.js"', html)
        self.assertIn('src="app.js"', html)
        self.assertNotIn("boundary-card", html)
        self.assertNotIn("READ ONLY", html)
        for page in (
            "page-overview", "page-catalog", "page-mapping", "page-history", "page-logs",
            "page-reviews", "page-shipping", "page-service-fee",
        ):
            self.assertIn(f'id="{page}"', html)
        for element_id in (
            "shipping-template-list", "shipping-form", "shipping-rule-list",
            "shipping-binding-form", "shipping-product-list", "preview-shipping", "shipping-result",
            "shipping-binding-status", "shipping-binding-search",
            "service-fee-list", "service-fee-form", "preview-service-fee",
            "service-fee-major-category", "import-official-service-fee",
            "archive-legacy-service-fee", "toggle-service-fee-archive",
        ):
            self.assertIn(f'id="{element_id}"', html)

    def test_bridge_returns_read_only_update_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            with connect_database(service.paths.database) as connection:
                set_sync_state(
                    connection,
                    {
                        "last_successful_sync": "2026-09-04T09:37:02+08:00",
                        "last_mode": "excel_pair_import",
                        "last_enabled_count": "36798",
                    },
                )
                connection.execute(
                    """
                    INSERT INTO mapping_import_batches (
                        source_file, source_sha256, total_rows, verified_rows,
                        pending_rows, inserted_rows, existing_rows, shop_name,
                        import_mode, status, imported_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'replace', 'applied', ?)
                    """,
                    (
                        "shop.xlsx", "a" * 64, 110, 95, 15, 5, 90,
                        "测试店铺", "2026-09-04T09:37:55+08:00",
                    ),
                )
                connection.commit()

            response = bridge.invoke("get_update_history")
            reviews = bridge.invoke("get_mapping_reviews")

        self.assertTrue(response["ok"])
        self.assertEqual(
            ["mapping:1", "catalog:2026-09-04T09:37:02+08:00"],
            [entry["update_id"] for entry in response["result"]],
        )
        self.assertTrue(response["result"][0]["is_latest"])
        self.assertFalse(any(entry["can_rollback"] for entry in response["result"]))
        self.assertTrue(reviews["ok"])
        self.assertEqual(0, reviews["result"]["total_open"])

    def test_bridge_previews_confirms_and_lists_shipping_template(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            payload = {
                "name": "铭香馆重量模板",
                "shop_name": "铭香馆",
                "first_weight": "1",
                "first_fee": "6",
                "additional_weight": "0.5",
                "additional_fee": "2",
                "default_region": "河北省",
                "enabled": True,
                "is_default": True,
                "region_rules": [
                    {
                        "region": "北京市",
                        "first_fee": "3",
                        "additional_fee": "1",
                        "free_shipping": False,
                    }
                ],
            }

            preview = bridge.invoke("preview_shipping_template", payload)
            self.assertTrue(preview["ok"])
            self.assertEqual([], bridge.invoke("get_shipping_templates")["result"])

            applied = bridge.invoke(
                "apply_shipping_template",
                {"preview_id": preview["result"]["preview_id"]},
            )
            templates = bridge.invoke("get_shipping_templates")
            history = bridge.invoke("get_update_history")
            self.assertTrue(
                (
                    service.paths.database.parent
                    / applied["result"]["backup_file"]
                ).is_file()
            )
            rolled_back = bridge.invoke(
                "rollback_update",
                {"update_id": history["result"][0]["update_id"]},
            )
            templates_after_rollback = bridge.invoke("get_shipping_templates")

        self.assertTrue(applied["ok"])
        self.assertEqual("铭香馆重量模板", templates["result"][0]["name"])
        self.assertTrue(templates["result"][0]["is_default"])
        self.assertEqual("北京市", templates["result"][0]["region_rules"][0]["region"])
        self.assertEqual("shipping", history["result"][0]["kind"])
        self.assertTrue(history["result"][0]["can_rollback"])
        self.assertTrue(rolled_back["ok"])
        self.assertEqual([], templates_after_rollback["result"])

    def test_bridge_binds_a_reusable_shipping_template_to_products(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            with connect_database(service.paths.database) as connection:
                batch_id = connection.execute(
                    """
                    INSERT INTO mapping_import_batches (
                        source_file, source_sha256, total_rows, verified_rows,
                        pending_rows, inserted_rows, existing_rows, shop_name,
                        status, imported_at
                    ) VALUES ('shop.xlsx', 'hash', 1, 1, 0, 1, 0, '铭香馆',
                              'applied', '2026-09-10T10:00:00+08:00')
                    """
                ).lastrowid
                connection.execute(
                    """
                    INSERT INTO douyin_sku_mappings (
                        douyin_sku_id, douyin_product_id, merchant_sku_code,
                        jushuitan_sku_id, product_name, specification, status,
                        import_batch_id, shop_name, created_at, updated_at
                    ) VALUES ('DY-1', 'P-1', 'SKU-1', 'SKU-1', '测试商品', '',
                              'verified', ?, '铭香馆',
                              '2026-09-10T10:00:00+08:00', '2026-09-10T10:00:00+08:00')
                    """,
                    (batch_id,),
                )
            template_preview = bridge.invoke("preview_shipping_template", {
                "name": "全国通用模板", "shop_name": "", "first_weight": "1",
                "first_fee": "3", "additional_weight": "1", "additional_fee": "1",
                "enabled": True, "is_default": False, "region_rules": [],
            })
            template = bridge.invoke("apply_shipping_template", {
                "preview_id": template_preview["result"]["preview_id"]
            })
            binding_preview = bridge.invoke("preview_shipping_product_bindings", {
                "shop_name": "铭香馆", "template_id": template["result"]["template_id"],
                "douyin_product_ids": ["P-1"],
            })
            bound = bridge.invoke("apply_shipping_product_bindings", {
                "preview_id": binding_preview["result"]["preview_id"]
            })
            workspace = bridge.invoke("get_shipping_product_bindings")

        self.assertTrue(bound["ok"])
        self.assertEqual(1, bound["result"]["product_count"])
        self.assertEqual(0, workspace["result"]["unbound_count"])
        self.assertEqual(template["result"]["template_id"], workspace["result"]["products"][0]["template_id"])

    def test_bridge_imports_bundled_official_service_fee_catalog_idempotently(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, _service, _window = self.make_bridge(Path(temp_dir))
            preview = bridge.invoke("preview_official_service_fee_catalog")
            applied = bridge.invoke("apply_official_service_fee_catalog", {
                "preview_id": preview["result"]["preview_id"]
            })
            second_preview = bridge.invoke("preview_official_service_fee_catalog")
            unchanged = bridge.invoke("apply_official_service_fee_catalog", {
                "preview_id": second_preview["result"]["preview_id"]
            })

        self.assertEqual(270, preview["result"]["rule_count"])
        self.assertEqual("applied", applied["result"]["status"])
        self.assertEqual("unchanged", unchanged["result"]["status"])
        self.assertEqual(270, unchanged["result"]["count"])

    def test_bridge_creates_and_toggles_versioned_basic_service_fee(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            preview = bridge.invoke(
                "preview_basic_service_fee_change",
                {
                    "operation": "create_version",
                    "major_category": "食品饮料",
                    "category_levels": ["食品饮料", "休闲食品", "坚果炒货", "即食板栗"],
                    "rate": "0.05",
                    "effective_from": "2026-09-09",
                    "note": "抖店基础服务费表",
                },
            )
            self.assertTrue(preview["ok"])
            self.assertEqual([], bridge.invoke("get_basic_service_fee_rates")["result"])
            created = bridge.invoke(
                "apply_basic_service_fee_change",
                {"preview_id": preview["result"]["preview_id"]},
            )
            rates = bridge.invoke("get_basic_service_fee_rates")
            coverage = bridge.invoke("get_basic_service_fee_coverage")

            toggle_preview = bridge.invoke(
                "preview_basic_service_fee_change",
                {
                    "operation": "set_enabled",
                    "rate_id": created["result"]["rate_id"],
                    "enabled": False,
                },
            )
            toggled = bridge.invoke(
                "apply_basic_service_fee_change",
                {"preview_id": toggle_preview["result"]["preview_id"]},
            )
            disabled_rates = bridge.invoke("get_basic_service_fee_rates")
            history = bridge.invoke("get_update_history")
            rolled_back = bridge.invoke(
                "rollback_update", {"update_id": toggled["result"]["update_id"]}
            )
            restored_rates = bridge.invoke("get_basic_service_fee_rates")

        self.assertTrue(created["ok"])
        self.assertEqual("0.05", rates["result"][0]["rate"])
        self.assertEqual(
            [{"rate_id": created["result"]["rate_id"], "product_coverage_count": 0}],
            coverage["result"],
        )
        self.assertFalse(disabled_rates["result"][0]["enabled"])
        self.assertEqual("service_fee", history["result"][0]["kind"])
        self.assertTrue(rolled_back["ok"])
        self.assertTrue(restored_rates["result"][0]["enabled"])

    def test_bridge_previews_and_archives_legacy_service_fee_rates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            save_basic_service_fee_rate(
                service.paths.database,
                category_levels=("食品饮料", "休闲食品", "坚果炒货", "即食板栗"),
                rate="0.05",
                effective_from="2026-07-15",
                changed_at="2026-07-15T09:00:00+08:00",
            )
            preview = bridge.invoke("preview_legacy_service_fee_archive")
            applied = bridge.invoke(
                "apply_legacy_service_fee_archive",
                {"preview_id": preview["result"]["preview_id"]},
            )
            active = bridge.invoke("get_basic_service_fee_rates")
            archived = bridge.invoke("get_basic_service_fee_rates", {"archived": True})

        self.assertEqual(1, preview["result"]["archive_count"])
        self.assertEqual(0, preview["result"]["referenced_product_count"])
        self.assertEqual("applied", applied["result"]["status"])
        self.assertEqual([], active["result"])
        self.assertEqual(1, len(archived["result"]))
        self.assertTrue(archived["result"][0]["archived"])

    def test_webview_smoke_uses_a_real_non_focused_window(self) -> None:
        class StubWindow:
            def __init__(self) -> None:
                self.destroyed = False
                self.events = mock.Mock()
                self.events.loaded.wait.return_value = True

            def get_current_url(self) -> str:
                return "http://127.0.0.1:43123/index.html"

            def evaluate_js(self, _script: str, *, callback) -> None:
                callback({"ok": True})

            def destroy(self) -> None:
                self.destroyed = True

        with tempfile.TemporaryDirectory() as temp_dir:
            paths = ServicePaths.from_data_directory(Path(temp_dir) / "data")
            window = StubWindow()
            create_options = {}
            fake_webview = mock.Mock()

            def create_window(*_args, **kwargs):
                create_options.update(kwargs)
                return window

            fake_webview.create_window.side_effect = create_window
            fake_webview.start.side_effect = lambda callback, **_kwargs: callback()
            service = AssistantService(paths, port=unused_local_port())

            with mock.patch.dict(sys.modules, {"webview": fake_webview}):
                result = run_webview_smoke_test(
                    service,
                    logging.getLogger("test-webview-smoke"),
                )

        self.assertEqual(0, result)
        self.assertFalse(create_options["hidden"])
        self.assertFalse(create_options["focus"])
        self.assertTrue(window.destroyed)

    def test_webview_start_waits_for_loaded_event_before_trusting_page(self) -> None:
        class StubEvent:
            def __iadd__(self, _handler):
                return self

        class LoadedEvent:
            def __init__(self) -> None:
                self.ready = False

            def wait(self, _timeout: float) -> bool:
                self.ready = True
                return True

        class StubWindow:
            def __init__(self) -> None:
                self.loaded = LoadedEvent()
                self.events = mock.Mock(
                    closing=StubEvent(), closed=StubEvent(), loaded=self.loaded
                )
                self.url_checks = 0
                self.scripts = []

            def get_current_url(self) -> str:
                self.url_checks += 1
                if not self.loaded.ready:
                    raise RuntimeError("Main window failed to start")
                return "http://127.0.0.1:43123/index.html"

            def run_js(self, script: str) -> None:
                self.scripts.append(script)

        with tempfile.TemporaryDirectory() as temp_dir:
            paths = ServicePaths.from_data_directory(Path(temp_dir) / "data")
            window = StubWindow()
            fake_webview = mock.Mock()
            fake_webview.create_window.return_value = window
            fake_webview.start.side_effect = lambda callback, **_kwargs: callback()
            service = AssistantService(paths, port=unused_local_port())

            with (
                mock.patch.dict(sys.modules, {"webview": fake_webview}),
                mock.patch("cost_sync.webview_app.installed_webview2_version", return_value="1"),
            ):
                result = run_webview_app(
                    service,
                    logging.getLogger("test-webview-start-race"),
                )

        self.assertEqual(0, result)
        self.assertEqual(1, window.url_checks)
        self.assertTrue(any("__desktopBridgeReady" in script for script in window.scripts))

    def test_duplicate_desktop_launch_activates_existing_window_without_starting_webview(self) -> None:
        duplicate_guard = mock.MagicMock()
        duplicate_guard.__enter__.return_value = False
        duplicate_guard.__exit__.return_value = False

        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                mock.patch(
                    "cost_sync.desktop_app.configure_logging",
                    return_value=logging.getLogger("test-duplicate-desktop-launch"),
                ),
                mock.patch(
                    "cost_sync.desktop_app.desktop_window_instance",
                    return_value=duplicate_guard,
                    create=True,
                ),
                mock.patch(
                    "cost_sync.desktop_app.activate_existing_desktop_window",
                    return_value=True,
                    create=True,
                ) as activate_existing,
                mock.patch("cost_sync.webview_app.run_webview_app", return_value=0) as run_webview,
            ):
                result = desktop_main(
                    [
                        "--data-dir",
                        str(Path(temp_dir) / "data"),
                        "--environment",
                        "test",
                        "--port",
                        str(unused_local_port()),
                    ]
                )

        self.assertEqual(0, result)
        activate_existing.assert_called_once_with()
        run_webview.assert_not_called()

    def test_bridge_exposes_only_single_allowlisted_entrypoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, _service, _window = self.make_bridge(Path(temp_dir))
            public_callables = sorted(
                name
                for name in dir(bridge)
                if not name.startswith("_") and callable(getattr(bridge, name))
            )
            self.assertEqual(["invoke"], public_callables)
            self.assertEqual(
                {
                    "get_state", "get_update_history", "start_service", "stop_service", "choose_file",
                    "preview_catalog", "apply_catalog", "preview_mapping",
                    "apply_mapping", "get_mapping_reviews", "save_mapping_reviews",
                    "resolve_mapping_review", "rollback_update", "open_logs",
                    "get_shipping_templates", "preview_shipping_template",
                    "apply_shipping_template", "get_basic_service_fee_rates",
                    "get_basic_service_fee_coverage",
                    "preview_basic_service_fee_change", "apply_basic_service_fee_change",
                    "get_shipping_product_bindings", "preview_shipping_product_bindings",
                    "apply_shipping_product_bindings",
                    "preview_official_service_fee_catalog",
                    "apply_official_service_fee_catalog",
                    "preview_legacy_service_fee_archive",
                    "apply_legacy_service_fee_archive",
                },
                set(BRIDGE_ACTIONS),
            )
            self.assertIn("rollback_update", SERIAL_ACTIONS)
            self.assertIn("apply_legacy_service_fee_archive", SERIAL_ACTIONS)
            response = bridge.invoke("delete_database")
            self.assertFalse(response["ok"])
            self.assertIn("不支持", response["error"])

    def test_bridge_rolls_back_only_the_history_supplied_update_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            entry = {
                "update_id": "mapping:7",
                "status": "applied",
                "can_rollback": True,
            }
            rollback_result = mock.Mock(
                update_key="mapping:7",
                recovery_backup_path=service.paths.database.with_name("recovery.sqlite3.bak"),
                rebuilt_excel=False,
            )
            with (
                mock.patch(
                    "cost_sync.webview_app.read_update_history", return_value=[entry]
                ),
                mock.patch(
                    "cost_sync.webview_app.rollback_latest_update",
                    return_value=rollback_result,
                ) as rollback,
            ):
                rejected = bridge.invoke(
                    "rollback_update",
                    {"update_id": "mapping:7", "backup_file": "operator-choice.bak"},
                )
                response = bridge.invoke("rollback_update", {"update_id": "mapping:7"})

        self.assertFalse(rejected["ok"])
        self.assertIn("参数", rejected["error"])
        self.assertEqual(
            {
                "ok": True,
                "result": {
                    "update_id": "mapping:7",
                    "recovery_backup_file": "recovery.sqlite3.bak",
                    "rebuilt_excel": False,
                },
            },
            response,
        )
        rollback.assert_called_once()
        self.assertEqual(service.paths.database, rollback.call_args.args[0])
        self.assertEqual(service.paths.output_excel, rollback.call_args.args[1])
        self.assertEqual("mapping:7", rollback.call_args.args[2])

    def test_bridge_rejects_update_that_history_does_not_mark_rollbackable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, _service, _window = self.make_bridge(Path(temp_dir))
            with mock.patch(
                "cost_sync.webview_app.read_update_history",
                return_value=[{"update_id": "catalog:older", "can_rollback": False}],
            ):
                response = bridge.invoke(
                    "rollback_update", {"update_id": "catalog:older"}
                )

        self.assertFalse(response["ok"])
        self.assertIn("全局最新", response["error"])

    def test_bridge_rejects_management_calls_after_navigation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, window = self.make_bridge(Path(temp_dir))
            window.url = "https://example.com/index.html"

            response = bridge.invoke("start_service")

            self.assertFalse(response["ok"])
            self.assertIn("无权", response["error"])
            self.assertFalse(service.owns_running_service)

    def test_bridge_routes_manual_mapping_resolution_through_guarded_admin(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            expected = {
                "candidate_id": 7,
                "batch_id": 8,
                "shop_name": "店铺A",
                "douyin_sku_id": "D-7",
                "jushuitan_sku_id": "SKU-7",
                "previous_shop_name": None,
                "backup_file": "before.sqlite3.bak",
            }
            with (
                mock.patch.object(bridge, "_ensure_service"),
                mock.patch.object(
                    service.admin, "resolve_mapping_review", return_value=expected
                ) as resolve,
            ):
                response = bridge.invoke(
                    "resolve_mapping_review",
                    {"candidate_id": 7, "jushuitan_sku_id": "SKU-7"},
                )

        self.assertEqual({"ok": True, "result": expected}, response)
        resolve.assert_called_once_with(7, "SKU-7")

    def test_bridge_rejects_duplicate_serial_operation_without_waiting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            bridge._operation_lock.acquire()
            try:
                response = bridge.invoke("start_service")
            finally:
                bridge._operation_lock.release()

            self.assertFalse(response["ok"])
            self.assertIn("仍在进行", response["error"])
            self.assertFalse(service.owns_running_service)

    def test_healthy_attached_service_is_running_without_window_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            health = {
                "status": "ok",
                "environment": "test",
                "service_id": database_service_id(service.paths.database),
                "enabled_count": 12,
                "verified_mapping_count": 34,
            }
            with mock.patch("cost_sync.webview_app.probe_health", return_value=health):
                response = bridge.invoke("get_state")

            self.assertTrue(response["ok"])
            self.assertTrue(response["result"]["expected"])
            self.assertFalse(response["result"]["owns_service"])
            self.assertEqual(
                str(service.paths.database.resolve()),
                response["result"]["database_path"],
            )

    def test_only_exact_loopback_index_page_can_be_trusted(self) -> None:
        self.assertEqual(
            "http://127.0.0.1:43210/index.html",
            _normalized_page_url("http://127.0.0.1:43210/index.html#overview"),
        )
        for value in (
            "https://example.com/index.html",
            "file:///index.html",
            "http://127.0.0.1:43210/options.html",
            "javascript:alert(1)",
        ):
            self.assertIsNone(_normalized_page_url(value), value)

    def test_close_is_cancelled_while_an_operation_is_in_progress(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bridge, service, _window = self.make_bridge(Path(temp_dir))
            notices = []
            controller = DesktopWindowController(
                bridge,
                service,
                logging.getLogger("test-webview-close"),
                confirm_close=lambda _message: True,
                notify=notices.append,
            )
            bridge._operation_lock.acquire()
            try:
                result = controller.on_closing()
            finally:
                bridge._operation_lock.release()

            self.assertFalse(result)
            self.assertEqual(1, len(notices))
            self.assertIn("等待操作完成", notices[0])

    def test_build_and_installer_include_webview2_requirements(self) -> None:
        build_source = (ROOT / "windows" / "Build-CostAssistant.ps1").read_text(encoding="utf-8")
        installer_source = INSTALLER.read_text(encoding="utf-8")
        self.assertIn("cost_sync\\webview_static", build_source)
        self.assertIn("--hidden-import webview.platforms.edgechromium", build_source)
        self.assertIn("--exclude-module tkinter", build_source)
        self.assertIn("Get-WebView2RuntimeVersion", installer_source)
        self.assertIn("MicrosoftEdgeWebView2RuntimeInstallerX64.exe", installer_source)

    @unittest.skipUnless(sys.platform == "win32", "Windows named service mutex")
    def test_parallel_windows_starts_leave_only_one_service_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = ServicePaths.from_data_directory(Path(temp_dir) / "data")
            paths.database.parent.mkdir(parents=True)
            with connect_database(paths.database) as connection:
                connection.commit()
            port = unused_local_port()
            services = [AssistantService(paths, port=port), AssistantService(paths, port=port)]
            barrier = threading.Barrier(2)
            results = []

            def start(service: AssistantService) -> None:
                barrier.wait()
                results.append(service.start())

            threads = [threading.Thread(target=start, args=(service,)) for service in services]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(5)
            try:
                self.assertCountEqual(["started", "already_running"], results)
                self.assertEqual(1, sum(service.owns_running_service for service in services))
                self.assertEqual("ok", probe_health(port)["status"])
            finally:
                for service in services:
                    service.stop()


class ReleasePackageTests(unittest.TestCase):
    def test_release_asset_builder_outputs_seven_page_v2_without_reviews(self) -> None:
        source = ROOT / "cost_sync" / "webview_static"
        development_html = (source / "index.html").read_text(encoding="utf-8")
        self.assertEqual(8, development_html.count('class="nav-item'))
        self.assertEqual(8, development_html.count('<section id="page-'))
        self.assertIn('data-page="reviews"', development_html)
        self.assertIn('id="page-reviews"', development_html)
        self.assertIn('data-page="shipping"', development_html)
        self.assertIn('id="page-shipping"', development_html)
        self.assertIn('data-page="service-fee"', development_html)
        self.assertIn('id="page-service-fee"', development_html)

        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "release-assets"
            completed = subprocess.run(
                [sys.executable, str(RELEASE_ASSET_BUILDER), str(source), str(target)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )

            self.assertEqual(0, completed.returncode, completed.stderr)
            release_html = (target / "index.html").read_text(encoding="utf-8")
            release_js = (target / "app.js").read_text(encoding="utf-8")
            release_css = (target / "styles.css").read_text(encoding="utf-8")
            self.assertEqual(7, release_html.count('class="nav-item'))
            self.assertEqual(7, release_html.count('<section id="page-'))
            for expected in (
                'id="mapping-category-complete"',
                'id="mapping-category-incomplete"',
                'id="mapping-fee-matched"',
                'id="mapping-fee-unconfigured"',
                'id="mapping-fee-disabled"',
                "运费模板",
                'data-page="shipping"',
                'id="page-shipping"',
                "基础服务费",
                'data-page="service-fee"',
                'id="page-service-fee"',
            ):
                self.assertIn(expected, release_html)
            for forbidden in (
                "人工核验",
                'data-page="reviews"',
                'id="page-reviews"',
                "refresh-reviews",
            ):
                self.assertNotIn(forbidden, release_html)
            for forbidden in (
                "get_mapping_reviews",
                "resolve_mapping_review",
                "refreshMappingReviews",
                "reviewText",
                "refreshReviews",
            ):
                self.assertNotIn(forbidden, release_js)
            for expected in (
                "get_shipping_templates",
                "preview_shipping_template",
                "apply_shipping_template",
                "get_basic_service_fee_rates",
                "preview_basic_service_fee_change",
                "apply_basic_service_fee_change",
            ):
                self.assertIn(expected, release_js)
            self.assertNotIn(".review-", release_css)
            self.assertIn(".shipping-", release_css)
            self.assertIn(".service-fee-", release_css)
            self.assertNotIn("RELEASE_EXCLUDE", release_html + release_js + release_css)
            for copied_file in ("refresh_model.js", "shipping_filters.js"):
                self.assertEqual(
                    (source / copied_file).read_bytes(),
                    (target / copied_file).read_bytes(),
                )

    def test_build_script_packages_generated_release_assets(self) -> None:
        build_source = (ROOT / "windows" / "Build-CostAssistant.ps1").read_text(encoding="utf-8")

        self.assertIn("prepare_release_webview.py", build_source)
        self.assertIn("release-webview-static", build_source)
        self.assertIn("$releaseAssets", build_source)
        self.assertNotIn(
            '--add-data "$(Join-Path $projectPath \'cost_sync\\webview_static\');cost_sync\\webview_static"',
            build_source,
        )
        for legacy_file in ("admin_core.js", "options.css", "options.html", "options.js"):
            self.assertNotIn(f'"{legacy_file}"', build_source)

    def test_native_messaging_runtime_entry_is_removed(self) -> None:
        desktop_source = (ROOT / "cost_sync" / "desktop_app.py").read_text(encoding="utf-8")

        self.assertNotIn('startswith("chrome-extension://")', desktop_source)
        self.assertNotIn("run_native_messaging_host", desktop_source)
        self.assertNotIn("NATIVE_HOST_NAME", desktop_source)

    @unittest.skipUnless(sys.platform == "win32", "Windows named mutex")
    def test_desktop_window_instance_rejects_second_owner(self) -> None:
        with desktop_window_instance() as first_is_primary:
            with desktop_window_instance() as second_is_primary:
                self.assertTrue(first_is_primary)
                self.assertFalse(second_is_primary)


class InstallerBatchWrapperTests(unittest.TestCase):
    def test_installer_uses_edge_setup_helper_without_enterprise_policy(self) -> None:
        installer_source = INSTALLER.read_text(encoding="utf-8")
        build_source = (ROOT / "windows" / "Build-CostAssistant.ps1").read_text(
            encoding="utf-8"
        )

        self.assertTrue(EDGE_SETUP_HELPER.is_file())
        helper_source = EDGE_SETUP_HELPER.read_text(encoding="utf-8")
        self.assertIn("Show-EdgeExtensionSetup.ps1", installer_source)
        self.assertIn("Show-EdgeExtensionSetup.ps1", build_source)
        self.assertIn("edge://extensions/", helper_source)
        self.assertIn("Set-Clipboard", helper_source)
        combined = installer_source + helper_source
        self.assertNotIn("SOFTWARE\\Policies\\Microsoft\\Edge", combined)
        self.assertNotIn("ExtensionInstallForcelist", combined)

    def test_installer_verifies_all_five_extension_files_after_copy(self) -> None:
        installer_source = INSTALLER.read_text(encoding="utf-8")

        self.assertIn("SHA256]::Create", installer_source)
        self.assertIn("Browser extension integrity check failed", installer_source)
        for filename in (
            "manifest.json",
            "background.js",
            "content.js",
            "core.js",
            "panel.js",
        ):
            self.assertIn(f'"{filename}"', installer_source)

    def test_package_root_argument_does_not_end_with_a_quoted_backslash(self) -> None:
        source = INSTALLER_CMD.read_text(encoding="utf-8")

        self.assertIn('-PackageRoot "%~dp0."', source)
        self.assertNotIn('-PackageRoot "%~dp0"', source)

    def test_development_launcher_stays_inside_project_and_skips_registration(self) -> None:
        source = (ROOT / "Start-CostAssistant-Dev.cmd").read_text(encoding="utf-8")

        self.assertIn("python -m cost_sync.desktop_app", source)
        self.assertIn("storage\\test", source)
        self.assertNotIn("reg ", source.lower())
        self.assertNotIn("shortcut", source.lower())


@unittest.skipUnless(sys.platform == "win32", "Windows-only Edge setup helper")
class EdgeExtensionSetupHelperTests(unittest.TestCase):
    def run_helper(self, *arguments: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                str(POWERSHELL),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(EDGE_SETUP_HELPER),
                *arguments,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )

    def test_helper_reports_first_load_reload_and_ready_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_edge = Path(temp_dir) / "msedge.exe"
            fake_edge.write_bytes(b"test seam")
            completed = self.run_helper(
                "-ExtensionDirectory",
                str(ROOT / "browser_extension"),
                "-EdgeExecutable",
                str(fake_edge),
                "-SkipEdgeLaunch",
                "-SkipClipboard",
            )

        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("edge://extensions/", completed.stdout)
        self.assertIn("kbdiohjlofljeafaddehaeciappaefka", completed.stdout)
        self.assertIn("Expected extension version: 0.1.0", completed.stdout)
        self.assertIn("EXTENSION_NOT_LOADED", completed.stdout)
        self.assertIn("EXTENSION_VERSION_MISMATCH", completed.stdout)
        self.assertIn("EXTENSION_READY", completed.stdout)

    def test_helper_distinguishes_missing_directory_version_and_edge(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_edge = root / "msedge.exe"
            fake_edge.write_bytes(b"test seam")
            missing_directory = self.run_helper(
                "-ExtensionDirectory",
                str(root / "missing-extension"),
                "-EdgeExecutable",
                str(fake_edge),
                "-SkipEdgeLaunch",
                "-SkipClipboard",
            )
            mismatch = self.run_helper(
                "-ExtensionDirectory",
                str(ROOT / "browser_extension"),
                "-ExpectedVersion",
                "9.9.9",
                "-EdgeExecutable",
                str(fake_edge),
                "-SkipEdgeLaunch",
                "-SkipClipboard",
            )
            missing_edge = self.run_helper(
                "-ExtensionDirectory",
                str(ROOT / "browser_extension"),
                "-EdgeExecutable",
                str(root / "missing-edge.exe"),
                "-SkipEdgeLaunch",
                "-SkipClipboard",
            )

        self.assertNotEqual(0, missing_directory.returncode)
        self.assertIn("Browser extension directory is missing", missing_directory.stderr)
        self.assertNotEqual(0, mismatch.returncode)
        self.assertIn("Browser extension version mismatch", mismatch.stderr)
        self.assertNotEqual(0, missing_edge.returncode)
        self.assertIn("Microsoft Edge browser is missing", missing_edge.stderr)


@unittest.skipUnless(sys.platform == "win32", "Windows-only installer integration")
class WindowsInstallerTests(unittest.TestCase):
    def run_installer(self, *arguments: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                str(POWERSHELL),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(INSTALLER),
                *arguments,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )

    @staticmethod
    def make_package(root: Path) -> tuple[Path, Path]:
        package = root / "package"
        (package / "app").mkdir(parents=True)
        extension = package / "browser_extension"
        extension.mkdir()
        (package / "seed_data").mkdir()
        (package / "app" / "CostAssistant.exe").write_bytes(b"exe")
        for filename in (
            "manifest.json",
            "background.js",
            "content.js",
            "core.js",
            "panel.js",
        ):
            shutil.copy2(ROOT / "browser_extension" / filename, extension / filename)
        shutil.copy2(EDGE_SETUP_HELPER, package / EDGE_SETUP_HELPER.name)
        (package / "seed_data" / "cost_accounting.sqlite3").write_bytes(b"seed")
        (package / "seed_data" / "enabled_product_costs.xlsx").write_bytes(b"excel")
        fake_edge = root / "msedge.exe"
        fake_edge.write_bytes(b"test seam")
        return package, fake_edge

    def test_installer_preserves_existing_data_and_creates_only_desktop_shortcut(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package, fake_edge = self.make_package(root)
            install = root / "installed"
            desktop = root / "desktop"
            (install / "data").mkdir(parents=True)
            (install / "data" / "cost_accounting.sqlite3").write_bytes(b"existing")
            (install / "data" / "enabled_product_costs.xlsx").write_bytes(b"existing-excel")
            (install / "data" / "cost_accounting.before-test.sqlite3.bak").write_bytes(b"backup")
            (install / "logs").mkdir()
            (install / "logs" / "cost-assistant.log").write_text("existing log", encoding="utf-8")
            arguments = (
                "-PackageRoot",
                str(package),
                "-InstallRoot",
                str(install),
                "-DesktopDirectory",
                str(desktop),
                "-EdgeExecutable",
                str(fake_edge),
                "-SkipEdgeLaunch",
                "-SkipClipboard",
            )
            first = self.run_installer(*arguments)
            second = self.run_installer(*arguments)

            self.assertEqual(0, first.returncode, first.stderr)
            self.assertEqual(0, second.returncode, second.stderr)
            self.assertEqual(b"existing", (install / "data" / "cost_accounting.sqlite3").read_bytes())
            self.assertEqual(b"existing-excel", (install / "data" / "enabled_product_costs.xlsx").read_bytes())
            self.assertEqual(b"backup", (install / "data" / "cost_accounting.before-test.sqlite3.bak").read_bytes())
            self.assertEqual("existing log", (install / "logs" / "cost-assistant.log").read_text(encoding="utf-8"))
            self.assertTrue((desktop / "Cost Assistant.lnk").is_file())
            self.assertIn("EXTENSION_NOT_LOADED", second.stdout)
            self.assertFalse((install / "native-messaging-host.json").exists())
            for filename in (
                "manifest.json",
                "background.js",
                "content.js",
                "core.js",
                "panel.js",
            ):
                self.assertEqual(
                    (package / "browser_extension" / filename).read_bytes(),
                    (install / "browser_extension" / filename).read_bytes(),
                )
            removed = self.run_installer(*arguments, "-Uninstall")
            self.assertEqual(0, removed.returncode, removed.stderr)
            self.assertFalse((desktop / "Cost Assistant.lnk").exists())
            self.assertFalse((install / "native-messaging-host.json").exists())
            self.assertTrue((install / "data" / "cost_accounting.sqlite3").is_file())
            self.assertTrue((install / "data" / "enabled_product_costs.xlsx").is_file())
            self.assertTrue((install / "data" / "cost_accounting.before-test.sqlite3.bak").is_file())
            self.assertTrue((install / "logs" / "cost-assistant.log").is_file())

    @unittest.skipUnless(
        os.environ.get("COST_ASSISTANT_REGISTRY_TEST") == "1",
        "set COST_ASSISTANT_REGISTRY_TEST=1 to exercise isolated HKCU registration",
    )
    def test_upgrade_removes_owned_legacy_native_registration_and_preserves_foreign_registration(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package, fake_edge = self.make_package(root)
            install = root / "installed"
            desktop = root / "desktop"
            (install / "app").mkdir(parents=True)
            legacy_manifest = install / "native-messaging-host.json"
            legacy_manifest.write_text("{}", encoding="utf-8")
            registry_subkey = f"Software\\CostAssistantInstallerTests\\{uuid.uuid4().hex}"
            native_registry_root = f"HKCU:\\{registry_subkey}"
            arguments = (
                "-PackageRoot",
                str(package),
                "-InstallRoot",
                str(install),
                "-DesktopDirectory",
                str(desktop),
                "-NativeRegistryRoot",
                native_registry_root,
                "-EdgeExecutable",
                str(fake_edge),
                "-SkipEdgeLaunch",
                "-SkipClipboard",
            )
            browser_keys = (
                "Google\\Chrome\\NativeMessagingHosts\\com.costassistant.launcher",
                "Microsoft\\Edge\\NativeMessagingHosts\\com.costassistant.launcher",
            )
            try:
                for browser_key in browser_keys:
                    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"{registry_subkey}\\{browser_key}") as key:
                        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(legacy_manifest))
                installed = self.run_installer(*arguments)
                self.assertEqual(0, installed.returncode, installed.stderr)
                self.assertFalse(legacy_manifest.exists())
                for browser_key in browser_keys:
                    with self.assertRaises(FileNotFoundError):
                        winreg.OpenKey(winreg.HKEY_CURRENT_USER, f"{registry_subkey}\\{browser_key}")

                foreign_key = f"{registry_subkey}\\{browser_keys[0]}"
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, foreign_key) as key:
                    winreg.SetValueEx(key, "", 0, winreg.REG_SZ, r"C:\foreign-native-host.json")
                upgraded = self.run_installer(*arguments)
                self.assertEqual(0, upgraded.returncode, upgraded.stderr)
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, foreign_key) as key:
                    self.assertEqual(r"C:\foreign-native-host.json", winreg.QueryValue(key, None))
            finally:
                delete_registry_tree(winreg.HKEY_CURRENT_USER, registry_subkey)

    def test_installer_blocks_upgrade_while_cost_assistant_is_running(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package, fake_edge = self.make_package(root)
            desktop = root / "desktop"
            fake_running = root / "CostAssistant.exe"
            shutil.copy2(Path(os.environ["WINDIR"]) / "System32" / "ping.exe", fake_running)
            process = subprocess.Popen(
                [str(fake_running), "-t", "127.0.0.1"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                blocked = self.run_installer(
                    "-PackageRoot",
                    str(package),
                    "-InstallRoot",
                    str(root / "installed"),
                    "-DesktopDirectory",
                    str(desktop),
                    "-EdgeExecutable",
                    str(fake_edge),
                    "-SkipEdgeLaunch",
                    "-SkipClipboard",
                )
            finally:
                process.terminate()
                process.wait(timeout=5)

        self.assertNotEqual(0, blocked.returncode)
        self.assertIn("Close Cost Assistant before installing or upgrading", blocked.stderr)

    def test_installer_rejects_missing_edge_before_creating_install_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package, _fake_edge = self.make_package(root)
            install = root / "installed"
            rejected = self.run_installer(
                "-PackageRoot",
                str(package),
                "-InstallRoot",
                str(install),
                "-DesktopDirectory",
                str(root / "desktop"),
                "-EdgeExecutable",
                str(root / "missing-edge.exe"),
                "-SkipEdgeLaunch",
                "-SkipClipboard",
            )
            self.assertNotEqual(0, rejected.returncode)
            self.assertIn("Microsoft Edge browser is missing", rejected.stderr)
            self.assertFalse(install.exists())


if __name__ == "__main__":
    unittest.main()
