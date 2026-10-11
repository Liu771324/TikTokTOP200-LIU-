import base64
import http.client
import json
import os
import hashlib
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlencode

from openpyxl import Workbook

from cost_sync.database import connect_database, set_sync_state, upsert_products
from cost_sync.local_api import EXTENSION_ORIGIN, MANAGEMENT_ORIGIN, create_server
from cost_sync.models import Product
from cost_sync.service_fee import save_basic_service_fee_rate
from cost_sync.shipping import save_shipping_product_binding, save_shipping_template
from cost_sync.update_history import read_update_history
from cost_sync.update_rollback import rollback_latest_update


class LocalApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "cost.sqlite3"
        self.output_excel = Path(self.temp_dir.name) / "enabled.xlsx"
        with connect_database(self.database) as connection:
            upsert_products(
                connection,
                [
                    Product("001", 1, "启用商品", "12.34", 1, None, None),
                    Product("002", 2, "禁用商品", "5", -1, None, None),
                ],
                synced_at="2026-08-30T10:00:00+08:00",
            )
            set_sync_state(
                connection,
                {
                    "last_successful_sync": "2026-08-30T10:00:00+08:00",
                    "last_mode": "full",
                    "last_fetched_count": "2",
                    "last_enabled_count": "1",
                },
            )
            batch_id = connection.execute(
                """
                INSERT INTO mapping_import_batches (
                    source_file, source_sha256, total_rows, verified_rows,
                    pending_rows, inserted_rows, existing_rows, status, imported_at
                ) VALUES ('douyin.xlsx', 'hash', 2, 2, 0, 2, 0, 'applied',
                          '2026-08-30T10:01:00+08:00')
                """
            ).lastrowid
            connection.executemany(
                """
                INSERT INTO douyin_sku_mappings (
                    douyin_sku_id, douyin_product_id, merchant_sku_code,
                    jushuitan_sku_id, product_name, specification, status,
                    import_batch_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, 'now', 'now')
                """,
                [
                    ("D-001", "P-001", "001", "001", "商品一", "规格一", batch_id),
                    ("D-002", "P-002", "002", "002", "商品二", "规格二", batch_id),
                ],
            )
            connection.commit()
        self.server = create_server(
            self.database,
            port=0,
            allowed_origins=(
                EXTENSION_ORIGIN,
                MANAGEMENT_ORIGIN,
                "https://read-only.example",
            ),
            environment="test",
            output_excel_path=self.output_excel,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_dir.cleanup()

    def request(self, path, *, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        result = response.status, dict(response.getheaders()), json.loads(body or b"{}")
        connection.close()
        return result

    def catalog_payload(self) -> dict[str, object]:
        ordinary = Path(self.temp_dir.name) / "ordinary.xlsx"
        combination = Path(self.temp_dir.name) / "combination.xlsx"
        self.write_book(
            ordinary,
            ("商品编码", "商品名称", "成本价", "商品状态", "创建时间", "修改时间"),
            [("NEW", "新单品", 5, "启用", "2026/09/01", "2026/09/01")],
        )
        self.write_book(
            combination,
            (
                "组合商品编码", "组合商品名称", "组合成本价", "商品状态",
                "创建时间", "修改时间", "商品编码", "数量", "子商品成本价",
            ),
            [("PACK", "两件组合", 12, "启用", "2026/09/01", "2026/09/01", "NEW", 2, 5)],
        )
        return {
            "ordinary": {
                "name": ordinary.name,
                "content_base64": base64.b64encode(ordinary.read_bytes()).decode("ascii"),
            },
            "combination": {
                "name": combination.name,
                "content_base64": base64.b64encode(combination.read_bytes()).decode("ascii"),
            },
        }

    def mapping_payload(self, rows=None, *, shop_name="店铺A") -> dict[str, object]:
        source = Path(self.temp_dir.name) / "douyin-shop.xlsx"
        rows = rows or [
            ("P-001", "已有商品", "001", "D-001", "规格一"),
            ("P-NEW", "新店商品", "001", "D-NEW", "规格二"),
            ("P-PENDING", "待核验商品", "MISSING", "D-PENDING", "规格三"),
        ]
        rows = [
            (row[0], row[1], "休闲食品", "坚果炒货", "即食板栗", "", *row[2:])
            if len(row) == 5
            else row
            for row in rows
        ]
        self.write_book(
            source,
            (
                "商品ID", "商品名称", "一级类目", "二级类目", "三级类目", "四级类目",
                "商家SKU编码", "规格ID（SKUID）", "商品规格",
            ),
            rows,
        )
        return {
            "shop_name": shop_name,
            "mapping": {
                "name": source.name,
                "content_base64": base64.b64encode(source.read_bytes()).decode("ascii"),
            }
        }

    def write_book(self, path: Path, headers, rows) -> None:
        workbook = Workbook()
        worksheet = workbook.active
        worksheet.append(headers)
        for row in rows:
            worksheet.append(row)
        workbook.save(path)
        workbook.close()

    def post_json(self, path: str, payload: object, *, origin=True):
        body = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = MANAGEMENT_ORIGIN
        return self.request(path, method="POST", headers=headers, body=body)

    def test_health_and_enabled_product_lookup(self) -> None:
        status, _, health = self.request("/health")
        self.assertEqual(200, status)
        self.assertEqual(2, health["total_count"])
        self.assertEqual(1, health["enabled_count"])
        self.assertEqual(2, health["verified_mapping_count"])
        self.assertEqual("test", health["environment"])
        self.assertIn("true_cost_breakdown_v1", health["capabilities"])

        status, _, product = self.request("/api/v1/products/001")
        self.assertEqual(200, status)
        self.assertEqual("12.34", product["cost_price"])

    def test_disabled_product_is_not_exposed(self) -> None:
        status, _, payload = self.request("/api/v1/products/002")
        self.assertEqual(404, status)
        self.assertEqual("未找到启用商品", payload["error"])

    def test_batch_lookup_preserves_requested_order_and_deduplicates(self) -> None:
        status, _, payload = self.request("/api/v1/products?sku_ids=001,002,001")
        self.assertEqual(200, status)
        self.assertEqual(["001"], [item["sku_id"] for item in payload["products"]])

    def test_repeated_batch_lookup_preserves_comma_in_sku_id(self) -> None:
        with connect_database(self.database) as connection:
            upsert_products(
                connection,
                [Product("SKU,01", 3, "带逗号", "6", 1, None, None)],
                synced_at="2026-08-30T10:00:00+08:00",
            )
            connection.commit()

        status, _, payload = self.request(
            "/api/v1/products?sku_id=SKU%2C01&sku_id=001"
        )
        self.assertEqual(200, status)
        self.assertEqual(["SKU,01", "001"], [item["sku_id"] for item in payload["products"]])

    def test_mapping_lookup_preserves_requested_order_and_deduplicates(self) -> None:
        status, _, payload = self.request(
            "/api/v1/mappings?douyin_sku_ids=D-002,D-001,D-002,MISSING"
        )
        self.assertEqual(200, status)
        self.assertEqual(
            [("D-002", "002"), ("D-001", "001")],
            [
                (item["douyin_sku_id"], item["jushuitan_sku_id"])
                for item in payload["mappings"]
            ],
        )

    def test_mapping_lookup_rejects_more_than_one_hundred_ids(self) -> None:
        ids = ",".join(f"D-{index}" for index in range(101))
        status, _, payload = self.request(f"/api/v1/mappings?douyin_sku_ids={ids}")
        self.assertEqual(400, status)
        self.assertIn("100", payload["error"])

    def test_true_cost_lookup_uses_aligned_page_category_context(self) -> None:
        with connect_database(self.database) as connection:
            connection.execute(
                """
                UPDATE douyin_sku_mappings
                SET shop_name = '店铺A', weight_kg = '1.6',
                    major_category = '',
                    major_category_unconfigured_reason = '经营大类未配置'
                WHERE douyin_sku_id = 'D-001'
                """
            )
        save_basic_service_fee_rate(
            self.database,
            category_levels=("休闲食品", "/", "/", "/"),
            major_category="食品饮料",
            rate="0.02",
            effective_from="2026-09-01",
            changed_at="2026-09-09T10:00:00+08:00",
        )
        template_id = save_shipping_template(
            self.database,
            name="店铺A默认模板",
            shop_name="店铺A",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            changed_at="2026-09-09T10:01:00+08:00",
        )
        save_shipping_product_binding(
            self.database, shop_name="店铺A", douyin_product_id="P-001",
            template_id=template_id, changed_at="2026-09-09T10:02:00+08:00",
        )

        query = urlencode(
            [
                ("douyin_sku_id", "D-001"),
                ("lowest_price", "30"),
                ("category_level_1", "休闲食品"),
                ("category_level_2", "糕点"),
                ("category_level_3", "点心"),
                ("category_level_4", "蛋黄酥"),
            ]
        )
        status, headers, payload = self.request(
            f"/api/v1/true-costs?{query}",
            headers={"Origin": EXTENSION_ORIGIN},
        )

        self.assertEqual(200, status)
        self.assertEqual(EXTENSION_ORIGIN, headers["Access-Control-Allow-Origin"])
        estimate = payload["true_costs"][0]
        self.assertTrue(estimate["available"])
        self.assertTrue(estimate["estimated"])
        self.assertEqual("12.34", estimate["product_cost"])
        self.assertEqual("10", estimate["shipping_fee"])
        self.assertEqual("食品饮料", estimate["major_category"])
        self.assertEqual(
            ["休闲食品", "糕点", "点心", "蛋黄酥"],
            estimate["category_levels"],
        )
        self.assertEqual("0.6", estimate["basic_service_fee"])
        self.assertEqual("22.94", estimate["true_cost"])
        self.assertEqual("7.06", estimate["cost_difference"])
        self.assertEqual("+30.78", estimate["difference_rate_percent"])

    def test_true_cost_lookup_requires_one_price_per_sku(self) -> None:
        status, _, payload = self.request(
            "/api/v1/true-costs?douyin_sku_id=D-001&douyin_sku_id=D-002"
            "&lowest_price=30"
        )

        self.assertEqual(400, status)
        self.assertIn("一一对应", payload["error"])

    def test_cors_only_allows_explicit_origin(self) -> None:
        allowed = EXTENSION_ORIGIN
        status, headers, _ = self.request("/health", headers={"Origin": allowed})
        self.assertEqual(200, status)
        self.assertEqual(allowed, headers["Access-Control-Allow-Origin"])

        status, headers, _ = self.request(
            "/health", headers={"Origin": "https://untrusted.example"}
        )
        self.assertEqual(403, status)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_post_is_rejected(self) -> None:
        status, _, payload = self.post_json("/api/v1/products/001", {})
        self.assertEqual(405, status)
        self.assertEqual("查询接口只允许读取", payload["error"])

    def test_catalog_preview_is_read_only_and_reports_pair_changes(self) -> None:
        before = self.database.read_bytes()

        status, _, payload = self.post_json(
            "/api/v1/admin/catalog/preview", self.catalog_payload()
        )

        self.assertEqual(200, status)
        self.assertTrue(payload["ready_to_import"])
        self.assertEqual((1, 1, 2), (
            payload["ordinary_products"],
            payload["combination_products"],
            payload["merged_products"],
        ))
        self.assertEqual((2, 2), (
            payload["added_products"], payload["removed_products"]
        ))
        self.assertEqual(before, self.database.read_bytes())
        self.assertFalse(self.output_excel.exists())

    def test_catalog_import_requires_preview_and_publishes_with_backup(self) -> None:
        status, _, preview = self.post_json(
            "/api/v1/admin/catalog/preview", self.catalog_payload()
        )
        self.assertEqual(200, status)

        status, _, result = self.post_json(
            "/api/v1/admin/catalog/import",
            {"preview_id": preview["preview_id"]},
        )

        self.assertEqual(200, status)
        self.assertEqual("applied", result["status"])
        self.assertEqual(2, result["total_count"])
        self.assertTrue(self.output_excel.is_file())
        self.assertTrue((self.database.parent / result["backup_file"]).is_file())
        with connect_database(self.database) as connection:
            self.assertEqual(
                [("NEW", "5"), ("PACK", "12")],
                [tuple(row) for row in connection.execute(
                    "SELECT sku_id, cost_price FROM products ORDER BY sku_id"
                )],
            )

        status, _, payload = self.post_json(
            "/api/v1/admin/catalog/import",
            {"preview_id": preview["preview_id"]},
        )
        self.assertEqual(400, status)
        self.assertIn("失效", payload["error"])

    def test_mapping_preview_is_read_only_and_reports_cross_store_additions(self) -> None:
        before = self.database.read_bytes()

        status, _, payload = self.post_json(
            "/api/v1/admin/mappings/preview", self.mapping_payload()
        )

        self.assertEqual(200, status)
        self.assertTrue(payload["ready_to_import"])
        self.assertFalse(payload["already_current"])
        self.assertEqual((3, 3), (payload["total_rows"], payload["unique_douyin_skus"]))
        self.assertEqual((2, 1), (payload["matched_rows"], payload["pending_rows"]))
        self.assertEqual((0, 2), (
            payload["complete_category_rows"], payload["incomplete_category_rows"]
        ))
        self.assertEqual((0, 0, 0), (
            payload["service_fee_matched_rows"],
            payload["service_fee_unconfigured_rows"],
            payload["service_fee_disabled_rows"],
        ))
        self.assertEqual((1, 0, 0), (
            payload["new_rows"], payload["existing_rows"], payload["conflict_count"]
        ))
        self.assertEqual((0, 0, 1), (
            payload["changed_rows"], payload["removed_rows"], payload["legacy_rows"]
        ))
        self.assertEqual(before, self.database.read_bytes())

    def test_mapping_import_requires_preview_and_appends_new_store_rows(self) -> None:
        status, _, preview = self.post_json(
            "/api/v1/admin/mappings/preview", self.mapping_payload()
        )
        self.assertEqual(200, status)

        status, _, result = self.post_json(
            "/api/v1/admin/mappings/import", {"preview_id": preview["preview_id"]}
        )

        self.assertEqual(200, status)
        self.assertEqual("applied", result["status"])
        self.assertEqual((1, 0, 1), (
            result["inserted_rows"], result["existing_rows"], result["legacy_rows"]
        ))
        self.assertTrue((self.database.parent / result["backup_file"]).is_file())
        with connect_database(self.database) as connection:
            row = connection.execute(
                "SELECT jushuitan_sku_id FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-NEW'"
            ).fetchone()
            self.assertEqual("001", row[0])
            self.assertEqual(
                "店铺A",
                connection.execute(
                    "SELECT shop_name FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-001'"
                ).fetchone()[0],
            )
            update = connection.execute(
                "SELECT update_key, backup_file, backup_sha256 FROM system_updates"
            ).fetchone()
            backup = self.database.parent / result["backup_file"]
            self.assertEqual(f"mapping:{result['batch_id']}", update["update_key"])
            self.assertEqual(result["backup_file"], update["backup_file"])
            self.assertEqual(
                hashlib.sha256(backup.read_bytes()).hexdigest(), update["backup_sha256"]
            )

        status, _, payload = self.post_json(
            "/api/v1/admin/mappings/import", {"preview_id": preview["preview_id"]}
        )
        self.assertEqual(400, status)
        self.assertIn("失效", payload["error"])

        rollback_latest_update(
            self.database,
            self.output_excel,
            f"mapping:{result['batch_id']}",
            rolled_back_at="2026-09-05T10:00:00+08:00",
        )
        with connect_database(self.database) as connection:
            self.assertIsNone(connection.execute(
                "SELECT 1 FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-NEW'"
            ).fetchone())
        rolled_back = next(
            entry for entry in read_update_history(self.database)
            if entry["update_id"] == f"mapping:{result['batch_id']}"
        )
        self.assertEqual("rolled_back", rolled_back["status"])

    def test_mapping_preview_blocks_cross_store_conflicts_and_detects_current_file(self) -> None:
        first_status, _, first = self.post_json(
            "/api/v1/admin/mappings/preview",
            self.mapping_payload([
                ("P-001", "已有商品", "001", "D-001", "规格一"),
            ]),
        )
        self.assertEqual(200, first_status)
        self.assertTrue(first["ready_to_import"])
        applied_status, _, _ = self.post_json(
            "/api/v1/admin/mappings/import", {"preview_id": first["preview_id"]}
        )
        self.assertEqual(200, applied_status)

        mismatch_status, _, mismatch = self.post_json(
            "/api/v1/admin/mappings/preview",
            self.mapping_payload([
                ("P-OTHER", "其它店商品", "001", "D-OTHER", "规格"),
            ]),
        )
        self.assertEqual(200, mismatch_status)
        self.assertFalse(mismatch["ready_to_import"])
        self.assertTrue(mismatch["shop_file_mismatch"])

        current_status, _, current = self.post_json(
            "/api/v1/admin/mappings/preview",
            self.mapping_payload([
                ("P-001", "已有商品", "001", "D-001", "规格一"),
            ]),
        )
        self.assertEqual(200, current_status)
        self.assertFalse(current["ready_to_import"])
        self.assertTrue(current["already_current"])

        with connect_database(self.database) as connection:
            upsert_products(
                connection,
                [Product("ALT", 3, "另一个启用商品", "8", 1, None, None)],
                synced_at="2026-09-02T10:00:00+08:00",
            )
            connection.commit()
        before = self.database.read_bytes()
        conflict_status, _, conflict = self.post_json(
            "/api/v1/admin/mappings/preview",
            self.mapping_payload([
                ("P-001", "冲突商品", "ALT", "D-001", "规格一"),
            ], shop_name="店铺B"),
        )
        self.assertEqual(200, conflict_status)
        self.assertFalse(conflict["ready_to_import"])
        self.assertEqual(1, conflict["conflict_count"])
        self.assertEqual(["D-001"], conflict["conflicting_sku_ids"])
        self.assertEqual(before, self.database.read_bytes())

    def test_same_shop_import_replaces_removed_and_changed_mappings(self) -> None:
        with connect_database(self.database) as connection:
            upsert_products(
                connection,
                [Product("ALT", 3, "另一个启用商品", "8", 1, None, None)],
                synced_at="2026-09-02T10:00:00+08:00",
            )
            connection.commit()
        first_status, _, first = self.post_json(
            "/api/v1/admin/mappings/preview", self.mapping_payload()
        )
        self.assertEqual(200, first_status)
        applied_status, _, _ = self.post_json(
            "/api/v1/admin/mappings/import", {"preview_id": first["preview_id"]}
        )
        self.assertEqual(200, applied_status)

        other_status, _, other = self.post_json(
            "/api/v1/admin/mappings/preview",
            self.mapping_payload([
                ("P-B", "其它店商品", "001", "B-001", "其它店规格"),
            ], shop_name="店铺B"),
        )
        self.assertEqual(200, other_status)
        other_applied_status, _, _ = self.post_json(
            "/api/v1/admin/mappings/import", {"preview_id": other["preview_id"]}
        )
        self.assertEqual(200, other_applied_status)
        with connect_database(self.database) as connection:
            other_before = tuple(connection.execute(
                "SELECT douyin_sku_id, jushuitan_sku_id, shop_name, import_batch_id "
                "FROM douyin_sku_mappings WHERE douyin_sku_id = 'B-001'"
            ).fetchone())

        replacement_status, _, replacement = self.post_json(
            "/api/v1/admin/mappings/preview",
            self.mapping_payload([
                ("P-001", "已更新商品", "ALT", "D-001", "新规格"),
            ]),
        )
        self.assertEqual(200, replacement_status)
        self.assertTrue(replacement["ready_to_import"])
        self.assertEqual((1, 1), (
            replacement["changed_rows"], replacement["removed_rows"]
        ))

        result_status, _, result = self.post_json(
            "/api/v1/admin/mappings/import",
            {"preview_id": replacement["preview_id"]},
        )
        self.assertEqual(200, result_status)
        self.assertEqual((1, 1), (result["updated_rows"], result["removed_rows"]))
        with connect_database(self.database) as connection:
            rows = [tuple(row) for row in connection.execute(
                "SELECT douyin_sku_id, jushuitan_sku_id, shop_name "
                "FROM douyin_sku_mappings WHERE shop_name = '店铺A' ORDER BY douyin_sku_id"
            )]
            other_after = tuple(connection.execute(
                "SELECT douyin_sku_id, jushuitan_sku_id, shop_name, import_batch_id "
                "FROM douyin_sku_mappings WHERE douyin_sku_id = 'B-001'"
            ).fetchone())
        self.assertEqual([("D-001", "ALT", "店铺A")], rows)
        self.assertEqual(other_before, other_after)

        backup = self.database.parent / result["backup_file"]
        with connect_database(backup) as connection:
            self.assertEqual("ok", connection.execute("PRAGMA integrity_check").fetchone()[0])
            self.assertIsNotNone(connection.execute(
                "SELECT 1 FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-NEW'"
            ).fetchone())
            self.assertEqual(other_before, tuple(connection.execute(
                "SELECT douyin_sku_id, jushuitan_sku_id, shop_name, import_batch_id "
                "FROM douyin_sku_mappings WHERE douyin_sku_id = 'B-001'"
            ).fetchone()))

        health_status, _, health = self.request("/health")
        self.assertEqual(200, health_status)
        self.assertIn("店铺A", health["mapping_shops"])

    def test_read_only_extension_origin_cannot_call_admin_endpoints(self) -> None:
        body = json.dumps(self.catalog_payload()).encode("utf-8")
        status, _, payload = self.request(
            "/api/v1/admin/catalog/preview",
            method="POST",
            headers={
                "Origin": EXTENSION_ORIGIN,
                "Content-Type": "application/json",
            },
            body=body,
        )
        self.assertEqual(403, status)
        self.assertIn("来源", payload["error"])

    def test_catalog_admin_rejects_requests_without_exact_management_origin(self) -> None:
        status, _, payload = self.post_json(
            "/api/v1/admin/catalog/preview", self.catalog_payload(), origin=False
        )
        self.assertEqual(403, status)
        self.assertIn("来源", payload["error"])

        body = json.dumps(self.catalog_payload()).encode("utf-8")
        status, _, payload = self.request(
            "/api/v1/admin/catalog/preview",
            method="POST",
            headers={
                "Origin": "https://read-only.example",
                "Content-Type": "application/json",
            },
            body=body,
        )
        self.assertEqual(403, status)
        self.assertIn("来源", payload["error"])

    def test_catalog_preview_rejects_header_only_pair_without_touching_database(self) -> None:
        ordinary = Path(self.temp_dir.name) / "empty-ordinary.xlsx"
        combination = Path(self.temp_dir.name) / "empty-combination.xlsx"
        self.write_book(
            ordinary,
            ("商品编码", "商品名称", "成本价", "商品状态", "创建时间", "修改时间"),
            [],
        )
        self.write_book(
            combination,
            (
                "组合商品编码", "组合商品名称", "组合成本价", "商品状态",
                "创建时间", "修改时间", "商品编码", "数量", "子商品成本价",
            ),
            [],
        )
        payload = {
            "ordinary": {
                "name": ordinary.name,
                "content_base64": base64.b64encode(ordinary.read_bytes()).decode("ascii"),
            },
            "combination": {
                "name": combination.name,
                "content_base64": base64.b64encode(combination.read_bytes()).decode("ascii"),
            },
        }
        before = self.database.read_bytes()

        status, _, result = self.post_json(
            "/api/v1/admin/catalog/preview", payload
        )

        self.assertEqual(400, status)
        self.assertIn("没有商品数据", result["error"])
        self.assertEqual(before, self.database.read_bytes())
        self.assertFalse(self.output_excel.exists())

    def test_catalog_preview_rejects_corrupt_xlsx_with_json_error(self) -> None:
        payload = self.catalog_payload()
        payload["ordinary"]["content_base64"] = base64.b64encode(
            b"not-an-xlsx"
        ).decode("ascii")
        before = self.database.read_bytes()

        status, _, result = self.post_json(
            "/api/v1/admin/catalog/preview", payload
        )

        self.assertEqual(400, status)
        self.assertIn("有效的 XLSX", result["error"])
        self.assertEqual(before, self.database.read_bytes())

    def test_preflight_allows_post_only_for_the_management_origin(self) -> None:
        status, headers, _ = self.request(
            "/api/v1/admin/catalog/preview",
            method="OPTIONS",
            headers={"Origin": MANAGEMENT_ORIGIN},
        )
        self.assertEqual(204, status)
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])

    def test_wildcard_cors_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "通配符"):
            create_server(self.database, port=0, allowed_origins=("*",))

    def test_invalid_environment_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "environment"):
            create_server(self.database, port=0, environment="sandbox")

    def test_service_reads_atomically_replaced_database_without_restart(self) -> None:
        replacement = Path(self.temp_dir.name) / "replacement.sqlite3"
        with connect_database(replacement) as connection:
            upsert_products(
                connection,
                [Product("001", 1, "更新商品", "99", 1, None, None)],
                synced_at="2026-08-30T11:00:00+08:00",
            )
            set_sync_state(
                connection,
                {
                    "last_successful_sync": "2026-08-30T11:00:00+08:00",
                    "last_mode": "incremental",
                    "last_fetched_count": "1",
                    "last_enabled_count": "1",
                },
            )
            connection.commit()

        os.replace(replacement, self.database)
        status, _, product = self.request("/api/v1/products/001")
        self.assertEqual(200, status)
        self.assertEqual("99", product["cost_price"])


if __name__ == "__main__":
    unittest.main()
