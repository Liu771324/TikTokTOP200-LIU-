import tempfile
import unittest
import re
import zipfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook

from cost_sync.database import connect_database, upsert_products
from cost_sync.mapping_import import (
    MappingCandidate,
    MappingImportPreview,
    apply_mapping_import,
    apply_shop_mapping_import,
    main,
    preview_mapping_import,
    rollback_mapping_import,
)
from cost_sync.models import Product
from cost_sync.service_fee import (
    save_basic_service_fee_rate,
    set_basic_service_fee_rate_enabled,
)
from cost_sync.mapping_review import (
    capture_mapping_review_candidates,
    read_mapping_review_candidates,
    resolve_mapping_review_candidate,
)


HEADERS = (
    "商品ID",
    "商品名称",
    "一级类目",
    "二级类目",
    "三级类目",
    "四级类目",
    "商家SKU编码",
    "规格ID（SKUID）",
    "商品规格",
)
DEFAULT_CATEGORIES = ("休闲食品", "坚果炒货", "即食板栗", "")


class MappingImportPreviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.database = self.root / "cost.sqlite3"
        with connect_database(self.database) as connection:
            upsert_products(
                connection,
                [
                    Product("ERP-001", 1, "商品一", "10", 1, None, None),
                    Product("ABC", 2, "商品二", "20", 1, None, None),
                    Product("DISABLED", 3, "停用商品", "30", -1, None, None),
                ],
                synced_at="2026-09-01T09:00:00+08:00",
            )
            connection.commit()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_source(self, rows, *, headers=HEADERS) -> Path:
        path = self.root / "douyin.xlsx"
        workbook = Workbook()
        worksheet = workbook.active
        worksheet.append(headers)
        for row in rows:
            if headers == HEADERS and len(row) == 5:
                row = (row[0], row[1], *DEFAULT_CATEGORIES, *row[2:])
            worksheet.append(row)
        workbook.save(path)
        workbook.close()
        return path

    def break_declared_dimensions(self, path: Path) -> Path:
        broken = self.root / "douyin-broken-dimensions.xlsx"
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(broken, "w") as target:
            for item in source.infolist():
                payload = source.read(item.filename)
                if item.filename == "xl/worksheets/sheet1.xml":
                    payload, replacements = re.subn(
                        br'<dimension ref="[^"]+"',
                        b'<dimension ref="A1:A1"',
                        payload,
                        count=1,
                    )
                    self.assertEqual(1, replacements)
                target.writestr(item, payload)
        return broken

    def test_preview_uses_only_exact_enabled_code_matches(self) -> None:
        source = self.write_source(
            [
                ("P1", "商品一", "ERP-001", "000001", "规格一"),
                ("P2", "大小写不同", "abc", "000002", "规格二"),
                ("P3", "空格不同", " ABC ", "000003", "规格三"),
                ("P4", "停用目标", "DISABLED", "000004", "规格四"),
            ]
        )

        preview = preview_mapping_import(self.database, source)

        self.assertEqual(4, preview.total_rows)
        self.assertEqual(1, preview.verified_rows)
        self.assertEqual(3, preview.pending_rows)
        self.assertTrue(preview.ready_to_import)
        self.assertEqual("000001", preview.candidates[0].douyin_sku_id)
        self.assertEqual("ERP-001", preview.candidates[0].jushuitan_sku_id)
        self.assertEqual(" ABC ", preview.candidates[2].merchant_sku_code)

    def test_preview_and_shop_import_preserve_complete_category_hierarchy(self) -> None:
        source = self.write_source(
            [
                (
                    "P1",
                    "商品一",
                    "食品饮料",
                    "休闲食品",
                    "坚果炒货",
                    "即食板栗",
                    "ERP-001",
                    "D-001",
                    "规格一",
                )
            ]
        )

        preview = preview_mapping_import(self.database, source)
        candidate = preview.candidates[0]
        self.assertEqual(
            ("食品饮料", "休闲食品", "坚果炒货", "即食板栗"),
            (
                candidate.category_level_1,
                candidate.category_level_2,
                candidate.category_level_3,
                candidate.category_level_4,
            ),
        )

        apply_shop_mapping_import(
            self.database,
            preview,
            shop_name="店铺A",
            imported_at="2026-09-08T15:00:00+08:00",
        )

        with connect_database(self.database) as connection:
            category = connection.execute(
                "SELECT category_level_1, category_level_2, category_level_3, "
                "category_level_4 FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-001'"
            ).fetchone()
        self.assertEqual(
            ("食品饮料", "休闲食品", "坚果炒货", "即食板栗"), tuple(category)
        )

    def test_preview_reports_category_and_current_service_fee_coverage(self) -> None:
        matched = ("食品饮料", "休闲食品", "坚果炒货", "即食板栗")
        disabled = ("食品饮料", "休闲食品", "坚果炒货", "即食核桃")
        save_basic_service_fee_rate(
            self.database,
            category_levels=matched,
            rate="0.05",
            effective_from="2026-01-01",
            changed_at="2026-01-01T09:00:00+08:00",
        )
        disabled_id = save_basic_service_fee_rate(
            self.database,
            category_levels=disabled,
            rate="0.06",
            effective_from="2026-01-01",
            changed_at="2026-01-01T09:01:00+08:00",
        )
        set_basic_service_fee_rate_enabled(
            self.database,
            disabled_id,
            enabled=False,
            changed_at="2026-01-01T09:02:00+08:00",
        )
        source = self.write_source(
            [
                ("P1", "已匹配", *matched, "ERP-001", "D-1", "100g*1袋"),
                ("P2", "已停用", *disabled, "ERP-001", "D-2", "100g*1袋"),
                (
                    "P3", "未配置", "食品饮料", "休闲食品", "坚果炒货", "即食腰果",
                    "ERP-001", "D-3", "100g*1袋",
                ),
                (
                    "P4", "类目缺失", "食品饮料", "休闲食品", "坚果炒货", "",
                    "ERP-001", "D-4", "100g*1袋",
                ),
            ]
        )

        preview = preview_mapping_import(self.database, source)

        self.assertEqual(4, preview.verified_rows)
        self.assertEqual((3, 1), (
            preview.complete_category_rows, preview.incomplete_category_rows
        ))
        self.assertEqual((1, 1, 1), (
            preview.service_fee_matched_rows,
            preview.service_fee_unconfigured_rows,
            preview.service_fee_disabled_rows,
        ))

    def test_preview_counts_an_other_level_rule_as_a_fallback(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("粮油干货/方便速食", "其他二级类目", "/", "/"),
            rate="0.02",
            effective_from="2026-01-01",
            changed_at="2026-01-01T09:00:00+08:00",
        )
        source = self.write_source(
            [
                (
                    "P-OTHER",
                    "黑木耳",
                    "粮油干货/方便速食",
                    "干货",
                    "菌类干货",
                    "黑木耳",
                    "ERP-001",
                    "D-OTHER",
                    "100g*1袋",
                )
            ]
        )

        preview = preview_mapping_import(self.database, source)

        self.assertEqual(1, preview.service_fee_matched_rows)
        self.assertEqual(0, preview.service_fee_unconfigured_rows)

    def test_preview_infers_and_persists_major_category_from_official_rules(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "/", "/", "/"),
            rate="0.02",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )
        source = self.write_source(
            [
                (
                    "P-MAJOR",
                    "香蕉干",
                    "休闲食品",
                    "蜜饯果干",
                    "香蕉干/片",
                    "原味",
                    "ERP-001",
                    "D-MAJOR",
                    "100g*1袋",
                )
            ]
        )

        preview = preview_mapping_import(self.database, source)
        candidate = preview.candidates[0]

        self.assertEqual("食品饮料", candidate.major_category)
        self.assertEqual("", candidate.major_category_unconfigured_reason)
        self.assertEqual((1, 0), (
            preview.major_category_configured_rows,
            preview.major_category_unconfigured_rows,
        ))
        self.assertEqual(1, preview.service_fee_matched_rows)

        apply_shop_mapping_import(
            self.database,
            preview,
            shop_name="店铺A",
            imported_at="2026-09-10T12:00:00+08:00",
        )
        with connect_database(self.database) as connection:
            stored = connection.execute(
                "SELECT major_category, major_category_unconfigured_reason "
                "FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-MAJOR'"
            ).fetchone()
        self.assertEqual(("食品饮料", ""), tuple(stored))

    def test_preview_and_shop_import_store_weight_parsed_from_specification(self) -> None:
        source = self.write_source(
            [
                (
                    "P1",
                    "香蕉脆卷",
                    "食品饮料",
                    "休闲食品",
                    "膨化食品",
                    "香蕉脆卷",
                    "ERP-001",
                    "D-WEIGHT",
                    "{规格:香蕉脆卷100g*5袋}",
                )
            ]
        )

        preview = preview_mapping_import(self.database, source)
        candidate = preview.candidates[0]
        self.assertEqual("0.5", candidate.weight_kg)
        self.assertEqual("100g*5", candidate.weight_source)
        self.assertEqual("", candidate.weight_unconfigured_reason)

        apply_shop_mapping_import(
            self.database,
            preview,
            shop_name="店铺A",
            imported_at="2026-09-08T17:20:00+08:00",
        )
        with connect_database(self.database) as connection:
            stored = connection.execute(
                "SELECT weight_kg, weight_source, weight_unconfigured_reason "
                "FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-WEIGHT'"
            ).fetchone()
        self.assertEqual(("0.5", "100g*5", ""), tuple(stored))

    def test_category_change_is_treated_as_a_shop_mapping_update(self) -> None:
        first = self.write_source([("P1", "商品一", "ERP-001", "D-001", "规格一")])
        apply_shop_mapping_import(
            self.database,
            preview_mapping_import(self.database, first),
            shop_name="店铺A",
            imported_at="2026-09-08T15:00:00+08:00",
        )
        changed = self.write_source(
            [
                (
                    "P1", "商品一", "食品饮料", "休闲食品", "肉类零食", "牛肉干",
                    "ERP-001", "D-001", "规格一",
                )
            ]
        )

        result = apply_shop_mapping_import(
            self.database,
            preview_mapping_import(self.database, changed),
            shop_name="店铺A",
            imported_at="2026-09-08T15:01:00+08:00",
        )

        self.assertEqual(1, result.updated_rows)
        with connect_database(self.database) as connection:
            category = connection.execute(
                "SELECT category_level_3, category_level_4 FROM douyin_sku_mappings "
                "WHERE douyin_sku_id = 'D-001'"
            ).fetchone()
        self.assertEqual(("肉类零食", "牛肉干"), tuple(category))

    def test_manual_review_resolution_preserves_imported_categories(self) -> None:
        source = self.write_source(
            [
                (
                    "P1", "待核验商品", "食品饮料", "休闲食品", "坚果炒货", "",
                    "MISSING", "D-PENDING", "规格一",
                )
            ]
        )
        preview = preview_mapping_import(self.database, source)
        capture_mapping_review_candidates(
            self.database,
            preview,
            shop_name="店铺A",
            conflict_sku_ids=(),
            captured_at="2026-09-08T15:00:00+08:00",
        )
        review = read_mapping_review_candidates(self.database)["items"][0]
        self.assertEqual("坚果炒货", review["category_level_3"])

        resolve_mapping_review_candidate(
            self.database,
            review["id"],
            "ERP-001",
            resolved_at="2026-09-08T15:01:00+08:00",
        )

        with connect_database(self.database) as connection:
            category = connection.execute(
                "SELECT category_level_1, category_level_2, category_level_3, "
                "category_level_4 FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-PENDING'"
            ).fetchone()
        self.assertEqual(("食品饮料", "休闲食品", "坚果炒货", ""), tuple(category))

    def test_preview_rejects_workbook_over_row_limit(self) -> None:
        source = self.write_source(
            [
                ("P1", "商品一", "ERP-001", "000001", "规格一"),
                ("P2", "商品二", "ABC", "000002", "规格二"),
            ]
        )

        with patch("cost_sync.mapping_import.MAX_IMPORT_ROWS", 1):
            with self.assertRaisesRegex(ValueError, "数据行超过"):
                preview_mapping_import(self.database, source)

    def test_duplicate_douyin_sku_blocks_import(self) -> None:
        source = self.write_source(
            [
                ("P1", "商品一", "ERP-001", "SKU-1", "规格一"),
                ("P2", "商品二", "ABC", "SKU-1", "规格二"),
            ]
        )

        preview = preview_mapping_import(self.database, source)

        self.assertEqual(2, preview.total_rows)
        self.assertEqual(1, preview.unique_douyin_skus)
        self.assertEqual(1, preview.duplicate_rows)
        self.assertFalse(preview.ready_to_import)

    def test_numeric_identifier_is_invalid_instead_of_losing_leading_zeroes(self) -> None:
        source = self.write_source([("P1", "商品一", "ERP-001", 123, "规格一")])

        preview = preview_mapping_import(self.database, source)

        self.assertEqual(1, preview.invalid_rows)
        self.assertEqual(0, len(preview.candidates))
        self.assertFalse(preview.ready_to_import)

    def test_whitespace_only_identifiers_are_invalid(self) -> None:
        source = self.write_source(
            [
                ("   ", "商品一", "ERP-001", "SKU-1", "规格一"),
                ("P2", "商品二", "   ", "SKU-2", "规格二"),
                ("P3", "商品三", "ABC", "   ", "规格三"),
            ]
        )

        preview = preview_mapping_import(self.database, source)

        self.assertEqual(3, preview.invalid_rows)
        self.assertEqual(0, len(preview.candidates))
        self.assertFalse(preview.ready_to_import)

    def test_first_shop_import_supports_more_rows_than_sqlite_variable_limit(self) -> None:
        candidates = tuple(
            MappingCandidate(
                source_row=index + 2,
                douyin_sku_id=f"DY-{index:05d}",
                douyin_product_id=f"P-{index:05d}",
                merchant_sku_code="ERP-001",
                product_name="大店铺商品",
                specification="规格",
                category_level_1="休闲食品",
                category_level_2="坚果炒货",
                category_level_3="即食板栗",
                category_level_4="",
                status="verified",
                jushuitan_sku_id="ERP-001",
            )
            for index in range(33_000)
        )
        preview = MappingImportPreview(
            source_file="large-shop.xlsx",
            source_sha256="large-shop-hash",
            total_rows=len(candidates),
            unique_douyin_skus=len(candidates),
            verified_rows=len(candidates),
            pending_rows=0,
            duplicate_rows=0,
            invalid_rows=0,
            candidates=candidates,
        )

        result = apply_shop_mapping_import(
            self.database,
            preview,
            shop_name="大店铺",
            imported_at="2026-09-02T14:00:00+08:00",
        )

        self.assertEqual(33_000, result.inserted_rows)
        with connect_database(self.database) as connection:
            self.assertEqual(
                33_000,
                connection.execute(
                    "SELECT COUNT(*) FROM douyin_sku_mappings WHERE shop_name = '大店铺'"
                ).fetchone()[0],
            )

    def test_missing_required_header_is_rejected(self) -> None:
        source = self.write_source([], headers=("商品ID", "商品名称"))

        with self.assertRaisesRegex(ValueError, "缺少必填列"):
            preview_mapping_import(self.database, source)

    def test_incorrect_declared_dimension_is_ignored(self) -> None:
        source = self.write_source(
            [("P1", "商品一", "ERP-001", "000001", "规格一")]
        )
        source = self.break_declared_dimensions(source)

        preview = preview_mapping_import(self.database, source)

        self.assertEqual(1, preview.total_rows)
        self.assertEqual(1, preview.verified_rows)

    def test_import_writes_only_verified_rows_and_records_batch_counts(self) -> None:
        source = self.write_source(
            [
                ("P1", "商品一", "ERP-001", "D-001", "规格一"),
                ("P2", "未匹配商品", "MISSING", "D-002", "规格二"),
            ]
        )
        preview = preview_mapping_import(self.database, source)

        result = apply_mapping_import(
            self.database,
            preview,
            imported_at="2026-09-01T10:00:00+08:00",
        )

        self.assertEqual(1, result.inserted_rows)
        self.assertEqual(0, result.existing_rows)
        self.assertFalse(result.reused_batch)
        with connect_database(self.database) as connection:
            mapping = connection.execute(
                "SELECT douyin_sku_id, jushuitan_sku_id, status, import_batch_id "
                "FROM douyin_sku_mappings"
            ).fetchone()
            self.assertEqual(
                ("D-001", "ERP-001", "verified", result.batch_id), tuple(mapping)
            )
            batch = connection.execute(
                "SELECT total_rows, verified_rows, pending_rows, inserted_rows, "
                "existing_rows, status FROM mapping_import_batches WHERE id = ?",
                (result.batch_id,),
            ).fetchone()
            self.assertEqual((2, 1, 1, 1, 0, "applied"), tuple(batch))

    def test_importing_the_same_source_is_idempotent(self) -> None:
        source = self.write_source(
            [("P1", "商品一", "ERP-001", "D-001", "规格一")]
        )
        preview = preview_mapping_import(self.database, source)

        first = apply_mapping_import(
            self.database, preview, imported_at="2026-09-01T10:00:00+08:00"
        )
        second = apply_mapping_import(
            self.database, preview, imported_at="2026-09-01T10:01:00+08:00"
        )

        self.assertEqual(first.batch_id, second.batch_id)
        self.assertTrue(second.reused_batch)
        with connect_database(self.database) as connection:
            self.assertEqual(
                1,
                connection.execute("SELECT COUNT(*) FROM mapping_import_batches").fetchone()[0],
            )
            self.assertEqual(
                1,
                connection.execute("SELECT COUNT(*) FROM douyin_sku_mappings").fetchone()[0],
            )

    def test_same_source_adds_newly_verified_mappings_after_product_catalog_expands(self) -> None:
        source = self.write_source(
            [
                ("P1", "商品一", "ERP-001", "D-001", "规格一"),
                ("P2", "多罐商品", "PACK-2", "D-002", "两罐"),
            ]
        )
        first_preview = preview_mapping_import(self.database, source)
        self.assertEqual((1, 1), (first_preview.verified_rows, first_preview.pending_rows))
        first = apply_mapping_import(
            self.database,
            first_preview,
            imported_at="2026-09-01T10:00:00+08:00",
        )

        with connect_database(self.database) as connection:
            upsert_products(
                connection,
                [Product("PACK-2", 4, "多罐商品", "18", 1, None, None)],
                synced_at="2026-09-01T11:00:00+08:00",
            )
            connection.commit()
        second_preview = preview_mapping_import(self.database, source)
        self.assertEqual(first_preview.source_sha256, second_preview.source_sha256)
        self.assertEqual((2, 0), (second_preview.verified_rows, second_preview.pending_rows))

        second = apply_mapping_import(
            self.database,
            second_preview,
            imported_at="2026-09-01T11:01:00+08:00",
        )

        self.assertNotEqual(first.batch_id, second.batch_id)
        self.assertEqual((1, 1, False), (second.inserted_rows, second.existing_rows, second.reused_batch))
        with connect_database(self.database) as connection:
            mappings = connection.execute(
                "SELECT douyin_sku_id, jushuitan_sku_id FROM douyin_sku_mappings "
                "ORDER BY douyin_sku_id"
            ).fetchall()
            self.assertEqual(
                [("D-001", "ERP-001"), ("D-002", "PACK-2")],
                [tuple(row) for row in mappings],
            )
            self.assertEqual(
                2,
                connection.execute("SELECT COUNT(*) FROM mapping_import_batches").fetchone()[0],
            )

        repeated = apply_mapping_import(
            self.database,
            second_preview,
            imported_at="2026-09-01T11:02:00+08:00",
        )
        self.assertEqual(second.batch_id, repeated.batch_id)
        self.assertTrue(repeated.reused_batch)

    def test_conflicting_existing_mapping_rolls_back_the_whole_batch(self) -> None:
        first_source = self.write_source(
            [("P1", "商品一", "ERP-001", "D-001", "规格一")]
        )
        first_preview = preview_mapping_import(self.database, first_source)
        first = apply_mapping_import(
            self.database, first_preview, imported_at="2026-09-01T10:00:00+08:00"
        )
        second_source = self.write_source(
            [
                ("P1", "冲突商品", "ABC", "D-001", "规格二"),
                ("P2", "商品二", "ABC", "D-002", "规格二"),
            ]
        )
        second_preview = preview_mapping_import(self.database, second_source)

        with self.assertRaisesRegex(ValueError, "映射冲突"):
            apply_mapping_import(
                self.database,
                second_preview,
                imported_at="2026-09-01T10:01:00+08:00",
            )

        with connect_database(self.database) as connection:
            rows = connection.execute(
                "SELECT douyin_sku_id, jushuitan_sku_id FROM douyin_sku_mappings"
            ).fetchall()
            self.assertEqual([("D-001", "ERP-001")], [tuple(row) for row in rows])
            self.assertEqual(
                1,
                connection.execute("SELECT COUNT(*) FROM mapping_import_batches").fetchone()[0],
            )
            self.assertEqual(
                first.batch_id,
                connection.execute(
                    "SELECT import_batch_id FROM douyin_sku_mappings WHERE douyin_sku_id = 'D-001'"
                ).fetchone()[0],
            )

    def test_only_the_latest_applied_batch_can_be_rolled_back(self) -> None:
        first_source = self.write_source(
            [("P1", "商品一", "ERP-001", "D-001", "规格一")]
        )
        first = apply_mapping_import(
            self.database,
            preview_mapping_import(self.database, first_source),
            imported_at="2026-09-01T10:00:00+08:00",
        )
        second_source = self.write_source(
            [("P2", "商品二", "ABC", "D-002", "规格二")]
        )
        second = apply_mapping_import(
            self.database,
            preview_mapping_import(self.database, second_source),
            imported_at="2026-09-01T10:01:00+08:00",
        )

        with self.assertRaisesRegex(ValueError, "最近一个"):
            rollback_mapping_import(
                self.database,
                first.batch_id,
                rolled_back_at="2026-09-01T10:02:00+08:00",
            )

        self.assertEqual(
            1,
            rollback_mapping_import(
                self.database,
                second.batch_id,
                rolled_back_at="2026-09-01T10:03:00+08:00",
            ),
        )
        self.assertEqual(
            1,
            rollback_mapping_import(
                self.database,
                first.batch_id,
                rolled_back_at="2026-09-01T10:04:00+08:00",
            ),
        )
        with connect_database(self.database) as connection:
            self.assertEqual(
                0,
                connection.execute("SELECT COUNT(*) FROM douyin_sku_mappings").fetchone()[0],
            )
            statuses = connection.execute(
                "SELECT status FROM mapping_import_batches ORDER BY id"
            ).fetchall()
            self.assertEqual(["rolled_back", "rolled_back"], [row[0] for row in statuses])

    def test_import_command_requires_the_exact_preview_hash(self) -> None:
        source = self.write_source(
            [("P1", "商品一", "ERP-001", "D-001", "规格一")]
        )
        preview = preview_mapping_import(self.database, source)

        with redirect_stdout(StringIO()):
            rejected = main(
                [
                    "--database",
                    str(self.database),
                    "--source",
                    str(source),
                    "--confirmed-sha256",
                    "wrong",
                    "import",
                ]
            )
            accepted = main(
                [
                    "--database",
                    str(self.database),
                    "--source",
                    str(source),
                    "--confirmed-sha256",
                    preview.source_sha256,
                    "import",
                ]
            )

        self.assertEqual(1, rejected)
        self.assertEqual(0, accepted)


if __name__ == "__main__":
    unittest.main()
