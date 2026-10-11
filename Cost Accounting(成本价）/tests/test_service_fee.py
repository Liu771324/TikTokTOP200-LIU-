import tempfile
import unittest
from pathlib import Path

from cost_sync.database import connect_database, copy_mapping_state
from cost_sync.official_service_fee import load_bundled_service_fee_catalog
from cost_sync.service_fee import (
    archive_legacy_service_fee_rates,
    apply_basic_service_fee_batch,
    apply_basic_service_fee_update,
    import_official_service_fee_catalog,
    infer_major_category,
    list_basic_service_fee_rates,
    list_basic_service_fee_coverage,
    list_basic_service_fee_rate_history,
    match_basic_service_fee_rate,
    preview_legacy_service_fee_archive,
    save_basic_service_fee_rate,
    set_basic_service_fee_rate_enabled,
)
from cost_sync.update_history import read_update_history
from cost_sync.update_rollback import rollback_latest_update


CATEGORY = ("食品饮料", "休闲食品", "坚果炒货", "即食板栗")


class BasicServiceFeeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "cost.sqlite3"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_saved_rate_matches_exact_category_on_effective_date(self) -> None:
        rate_id = save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.0500",
            effective_from="2026-09-08",
            note="抖店基础服务费查询表",
            changed_at="2026-09-08T16:00:00+08:00",
        )

        result = match_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            effective_on="2026-09-08",
        )

        self.assertEqual(rate_id, result.rate_id)
        self.assertEqual("0.05", result.rate)
        self.assertEqual("2026-09-08", result.effective_from)
        self.assertIsNone(result.unconfigured_reason)

    def test_major_category_wildcard_parent_and_specific_rule_priority(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "/", "/", "/"),
            rate="0.02",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )
        specific_id = save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "蜜饯果干", "香蕉干/片", "原味"),
            rate="0.04",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:01:00+08:00",
        )

        specific = match_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "蜜饯果干", "香蕉干/片", "原味"),
            effective_on="2026-09-10",
        )
        inherited = match_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "肉类零食", "牛肉干", "原味"),
            effective_on="2026-09-10",
        )
        wrong_major = match_basic_service_fee_rate(
            self.database,
            major_category="滋补保健",
            category_levels=("休闲食品", "肉类零食", "牛肉干", "原味"),
            effective_on="2026-09-10",
        )

        self.assertEqual((specific_id, "0.04"), (specific.rate_id, specific.rate))
        self.assertEqual("0.02", inherited.rate)
        self.assertEqual("基础服务费率未配置", wrong_major.unconfigured_reason)

    def test_parent_rule_covers_contiguous_missing_trailing_category_levels(self) -> None:
        parent_id = save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "/", "/", "/"),
            rate="0.02",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )

        result = match_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "糕点/点心", "蛋黄酥", ""),
            effective_on="2026-09-11",
        )

        self.assertEqual(parent_id, result.rate_id)
        self.assertEqual("0.02", result.rate)
        self.assertIsNone(result.unconfigured_reason)

    def test_other_level_rule_is_a_fallback_but_exact_rule_wins(self) -> None:
        fallback_id = save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("粮油干货/方便速食", "其他二级类目", "/", "/"),
            rate="0.02",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )
        exact_id = save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("粮油干货/方便速食", "食用油", "/", "/"),
            rate="0.01",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:01:00+08:00",
        )

        fallback = match_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("粮油干货/方便速食", "干货", "菌类干货", "黑木耳"),
            effective_on="2026-09-11",
        )
        exact = match_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("粮油干货/方便速食", "食用油", "花生油", ""),
            effective_on="2026-09-11",
        )

        self.assertEqual((fallback_id, "0.02"), (fallback.rate_id, fallback.rate))
        self.assertEqual((exact_id, "0.01"), (exact.rate_id, exact.rate))

        missing = match_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("粮油干货/方便速食", "", "", ""),
            effective_on="2026-09-11",
        )
        self.assertEqual("基础服务费率未配置", missing.unconfigured_reason)

    def test_official_catalog_import_is_idempotent_and_keeps_source_metadata(self) -> None:
        with connect_database(self.database):
            pass
        rules = [
            {
                "major_category": "食品饮料",
                "category_levels": ["休闲食品", "/", "/", "/"],
                "rate": "0.02",
                "special_channel_rate": "0.026",
            },
            {
                "major_category": "滋补保健",
                "category_levels": ["传统滋补", "/", "/", "/"],
                "rate": "0.03",
                "special_channel_rate": "0.039",
            },
        ]

        first = import_official_service_fee_catalog(
            self.database,
            rules,
            source_article_id="ahijyoja6hvb",
            source_updated_at="2026-07-15T00:00:14+08:00",
            effective_from="2026-07-15",
            imported_at="2026-09-10T11:00:00+08:00",
        )
        second = import_official_service_fee_catalog(
            self.database,
            rules,
            source_article_id="ahijyoja6hvb",
            source_updated_at="2026-07-15T00:00:14+08:00",
            effective_from="2026-07-15",
            imported_at="2026-09-10T11:01:00+08:00",
        )

        self.assertEqual((2, False), (first["count"], first["reused_import"]))
        self.assertEqual((2, True), (second["count"], second["reused_import"]))
        listed = list_basic_service_fee_rates(self.database)
        self.assertEqual(2, len(listed))
        self.assertEqual("ahijyoja6hvb", listed[0]["source_article_id"])
        self.assertEqual("2026-07-15T00:00:14+08:00", listed[0]["source_updated_at"])
        self.assertTrue(listed[0]["source_checksum"])
        self.assertEqual("食品饮料", infer_major_category(self.database, "休闲食品"))
        self.assertEqual("滋补保健", infer_major_category(self.database, "传统滋补"))

    def test_bundled_official_catalog_contains_all_current_rules(self) -> None:
        catalog = load_bundled_service_fee_catalog()

        self.assertEqual("ahijyoja6hvb", catalog["source_article_id"])
        self.assertEqual(270, len(catalog["rules"]))
        rates = {
            (rule["major_category"], rule["category_levels"][0]): rule["rate"]
            for rule in catalog["rules"]
            if rule["category_levels"][1:] == ["/", "/", "/"]
        }
        self.assertEqual("0.02", rates[("食品饮料", "休闲食品")])
        self.assertEqual("0.02", rates[("食品饮料", "水饮冲调")])
        self.assertEqual("0.03", rates[("滋补保健", "传统滋补")])
        self.assertEqual("0.03", rates[("滋补保健", "营养保健/特医食品")])

    def test_trailing_missing_category_without_parent_rule_reports_rate_missing(self) -> None:
        result = match_basic_service_fee_rate(
            self.database,
            category_levels=("食品饮料", "休闲食品", "坚果炒货", ""),
            effective_on="2026-09-08",
        )

        self.assertIsNone(result.rate)
        self.assertEqual("基础服务费率未配置", result.unconfigured_reason)

    def test_category_with_a_missing_middle_level_is_not_matched(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "/", "/", "/"),
            rate="0.02",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )

        result = match_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "", "蛋黄酥", ""),
            effective_on="2026-09-11",
        )

        self.assertIsNone(result.rate)
        self.assertEqual("商品类目未配置完整", result.unconfigured_reason)

    def test_disabled_current_rate_does_not_fall_back_to_older_version(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=CATEGORY,
            rate="0.03",
            effective_from="2026-01-01",
            changed_at="2026-01-01T09:00:00+08:00",
        )
        current_id = save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.05",
            effective_from="2026-09-01",
            changed_at="2026-09-01T09:00:00+08:00",
        )

        set_basic_service_fee_rate_enabled(
            self.database,
            current_id,
            enabled=False,
            changed_at="2026-09-08T16:10:00+08:00",
        )
        result = match_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            effective_on="2026-09-08",
        )

        self.assertEqual(current_id, result.rate_id)
        self.assertIsNone(result.rate)
        self.assertEqual("基础服务费率已停用", result.unconfigured_reason)

    def test_history_keeps_effective_versions_and_enabled_changes(self) -> None:
        first_id = save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.03",
            effective_from="2026-01-01",
            note="旧版",
            changed_at="2026-01-01T09:00:00+08:00",
        )
        second_id = save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.05",
            effective_from="2026-09-01",
            note="新版",
            changed_at="2026-09-01T09:00:00+08:00",
        )
        set_basic_service_fee_rate_enabled(
            self.database,
            second_id,
            enabled=False,
            changed_at="2026-09-08T16:10:00+08:00",
        )

        history = list_basic_service_fee_rate_history(
            self.database, category_levels=CATEGORY
        )

        self.assertEqual(
            [
                (first_id, "created", "0.03", "2026-01-01", True),
                (second_id, "created", "0.05", "2026-09-01", True),
                (second_id, "disabled", "0.05", "2026-09-01", False),
            ],
            [
                (
                    item.rate_id,
                    item.action,
                    item.rate,
                    item.effective_from,
                    item.enabled,
                )
                for item in history
            ],
        )

    def test_query_date_selects_the_latest_effective_version(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.03",
            effective_from="2026-01-01",
            changed_at="2026-01-01T09:00:00+08:00",
        )
        save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.05",
            effective_from="2026-09-01",
            changed_at="2026-09-01T09:00:00+08:00",
        )

        august = match_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            effective_on="2026-08-31",
        )
        september = match_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            effective_on="2026-09-01",
        )

        self.assertEqual("0.03", august.rate)
        self.assertEqual("0.05", september.rate)

    def test_cost_snapshot_rebuild_preserves_rates_and_history(self) -> None:
        rate_id = save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.05",
            effective_from="2026-09-01",
            changed_at="2026-09-01T09:00:00+08:00",
        )
        set_basic_service_fee_rate_enabled(
            self.database,
            rate_id,
            enabled=False,
            changed_at="2026-09-08T16:10:00+08:00",
        )
        rebuilt = Path(self.temp_dir.name) / "rebuilt.sqlite3"

        with connect_database(rebuilt) as target:
            copy_mapping_state(self.database, target)

        history = list_basic_service_fee_rate_history(
            rebuilt, category_levels=CATEGORY
        )
        self.assertEqual(["created", "disabled"], [item.action for item in history])
        result = match_basic_service_fee_rate(
            rebuilt,
            category_levels=CATEGORY,
            effective_on="2026-09-08",
        )
        self.assertEqual("基础服务费率已停用", result.unconfigured_reason)

    def test_new_effective_version_is_recoverable_without_overwriting_history(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=CATEGORY,
            rate="0.03",
            effective_from="2026-01-01",
            note="旧版",
            changed_at="2026-01-01T09:00:00+08:00",
        )

        applied = apply_basic_service_fee_update(
            self.database,
            {
                "operation": "create_version",
                "major_category": "食品饮料",
                "category_levels": list(CATEGORY),
                "rate": "0.05",
                "effective_from": "2026-09-01",
                "note": "新版",
            },
            changed_at="2026-09-09T11:00:00+08:00",
        )

        rates = list_basic_service_fee_rates(self.database)
        self.assertEqual(["0.05", "0.03"], [item["rate"] for item in rates])
        self.assertEqual(["新版", "旧版"], [item["note"] for item in rates])
        update = read_update_history(self.database)[0]
        self.assertEqual("service_fee", update["kind"])
        self.assertEqual(applied["update_id"], update["update_id"])

        rollback_latest_update(
            self.database,
            Path(self.temp_dir.name) / "enabled.xlsx",
            applied["update_id"],
            rolled_back_at="2026-09-09T11:01:00+08:00",
        )

        self.assertEqual(["0.03"], [
            item["rate"] for item in list_basic_service_fee_rates(self.database)
        ])

    def test_duplicate_version_reports_the_full_business_key(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=CATEGORY,
            rate="0.03",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )

        with self.assertRaisesRegex(
            ValueError, "相同经营大类、四级类目和生效日期已存在"
        ):
            apply_basic_service_fee_update(
                self.database,
                {
                    "operation": "create_version",
                    "major_category": "食品饮料",
                    "category_levels": list(CATEGORY),
                    "rate": "0.05",
                    "effective_from": "2026-07-15",
                },
                changed_at="2026-09-11T09:00:00+08:00",
            )

    def test_enable_change_is_recorded_as_a_recoverable_configuration_update(self) -> None:
        rate_id = save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.05",
            effective_from="2026-09-01",
            changed_at="2026-09-01T09:00:00+08:00",
        )

        result = apply_basic_service_fee_update(
            self.database,
            {"operation": "set_enabled", "rate_id": rate_id, "enabled": False},
            changed_at="2026-09-09T11:00:00+08:00",
        )

        self.assertEqual("set_enabled", result["operation"])
        self.assertFalse(list_basic_service_fee_rates(self.database)[0]["enabled"])
        history = list_basic_service_fee_rate_history(
            self.database, category_levels=CATEGORY
        )
        self.assertEqual(["created", "disabled"], [item.action for item in history])

    def test_batch_versions_use_one_backup_and_one_recoverable_update(self) -> None:
        second_category = ("食品饮料", "水饮冲调", "茶", "花草茶")
        with connect_database(self.database):
            pass

        applied = apply_basic_service_fee_batch(
            self.database,
            [
                {
                    "major_category": "食品饮料",
                    "category_levels": list(CATEGORY),
                    "rate": "0.02",
                    "effective_from": "2026-09-09",
                    "note": "2026 官方费率表",
                },
                {
                    "major_category": "食品饮料",
                    "category_levels": list(second_category),
                    "rate": "0.02",
                    "effective_from": "2026-09-09",
                    "note": "2026 官方费率表",
                },
            ],
            changed_at="2026-09-09T15:30:00+08:00",
        )

        self.assertEqual(2, applied["count"])
        self.assertEqual(2, len(list_basic_service_fee_rates(self.database)))
        self.assertEqual(1, len(list(Path(self.temp_dir.name).glob("*.bak"))))
        history = read_update_history(self.database)
        self.assertEqual(1, len(history))
        self.assertEqual("create_versions", history[0]["operation"])
        self.assertEqual(2, history[0]["count"])

        rollback_latest_update(
            self.database,
            Path(self.temp_dir.name) / "enabled.xlsx",
            applied["update_id"],
            rolled_back_at="2026-09-09T15:31:00+08:00",
        )
        self.assertEqual([], list_basic_service_fee_rates(self.database))

    def test_batch_rejects_duplicate_category_dates_before_writing(self) -> None:
        version = {
            "major_category": "食品饮料",
            "category_levels": list(CATEGORY),
            "rate": "0.02",
            "effective_from": "2026-09-09",
        }

        with self.assertRaisesRegex(ValueError, "重复"):
            apply_basic_service_fee_batch(
                self.database,
                [version, version],
                changed_at="2026-09-09T15:30:00+08:00",
            )

        self.assertEqual([], list_basic_service_fee_rates(self.database))
        self.assertEqual([], list(Path(self.temp_dir.name).glob("*.bak")))

    def test_legacy_rates_can_be_archived_and_restored_without_losing_history(self) -> None:
        rate_id = save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.05",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )

        preview = preview_legacy_service_fee_archive(self.database)
        self.assertEqual(1, preview["archive_count"])
        self.assertEqual(0, preview["referenced_product_count"])

        applied = archive_legacy_service_fee_rates(
            self.database,
            changed_at="2026-09-11T11:00:00+08:00",
        )

        self.assertEqual([rate_id], applied["rate_ids"])
        self.assertEqual([], list_basic_service_fee_rates(self.database))
        archived = list_basic_service_fee_rates(self.database, archived=True)
        self.assertEqual([rate_id], [item["id"] for item in archived])
        self.assertTrue(archived[0]["archived"])
        self.assertEqual(
            ["created"],
            [item.action for item in list_basic_service_fee_rate_history(
                self.database, category_levels=CATEGORY
            )],
        )
        self.assertEqual(
            "基础服务费率未配置",
            match_basic_service_fee_rate(
                self.database,
                category_levels=CATEGORY,
                effective_on="2026-09-11",
            ).unconfigured_reason,
        )
        self.assertTrue((self.database.parent / applied["backup_file"]).is_file())
        update = read_update_history(self.database)[0]
        self.assertEqual("旧基础服务费归档", update["title"])
        self.assertEqual("archive_legacy_rates", update["operation"])

        rollback_latest_update(
            self.database,
            Path(self.temp_dir.name) / "enabled.xlsx",
            applied["update_id"],
            rolled_back_at="2026-09-11T11:01:00+08:00",
        )
        self.assertEqual([rate_id], [item["id"] for item in list_basic_service_fee_rates(self.database)])

    def test_legacy_archive_is_blocked_when_a_verified_product_still_matches(self) -> None:
        save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            rate="0.05",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )
        with connect_database(self.database) as connection:
            batch_id = connection.execute(
                """
                INSERT INTO mapping_import_batches (
                    source_file, source_sha256, total_rows, verified_rows,
                    pending_rows, inserted_rows, existing_rows, status, imported_at
                ) VALUES ('fixture.xlsx', 'sha', 1, 1, 0, 1, 0, 'applied', ?)
                """,
                ("2026-09-11T10:00:00+08:00",),
            ).lastrowid
            connection.execute(
                """
                INSERT INTO douyin_sku_mappings (
                    douyin_sku_id, douyin_product_id, merchant_sku_code,
                    jushuitan_sku_id, product_name, specification,
                    category_level_1, category_level_2, category_level_3,
                    category_level_4, status, import_batch_id, created_at, updated_at
                ) VALUES ('sku', 'product', 'merchant', 'erp', '商品', '规格',
                          ?, ?, ?, ?, 'verified', ?, ?, ?)
                """,
                (*CATEGORY, batch_id, "2026-09-11T10:00:00+08:00", "2026-09-11T10:00:00+08:00"),
            )

        preview = preview_legacy_service_fee_archive(self.database)
        self.assertEqual(1, preview["referenced_product_count"])
        with self.assertRaisesRegex(ValueError, "仍被 1 个商品匹配"):
            archive_legacy_service_fee_rates(
                self.database,
                changed_at="2026-09-11T11:00:00+08:00",
            )
        self.assertEqual(1, len(list_basic_service_fee_rates(self.database)))
        self.assertEqual([], list(Path(self.temp_dir.name).glob("*.bak")))

    def test_directory_load_is_separate_from_deduplicated_product_coverage(self) -> None:
        parent_id = save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("食品饮料", "/", "/", "/"),
            rate="0.02",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )
        specific_id = save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=CATEGORY,
            rate="0.03",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:01:00+08:00",
        )
        with connect_database(self.database) as connection:
            batch_id = connection.execute(
                """
                INSERT INTO mapping_import_batches (
                    source_file, source_sha256, total_rows, verified_rows,
                    pending_rows, inserted_rows, existing_rows, status, imported_at
                ) VALUES ('fixture.xlsx', 'coverage', 3, 3, 0, 3, 0, 'applied', ?)
                """,
                ("2026-09-11T10:00:00+08:00",),
            ).lastrowid
            for sku_id, product_id, categories in (
                ("sku-1", "product-1", CATEGORY),
                ("sku-2", "product-1", CATEGORY),
                ("sku-3", "product-2", ("食品饮料", "糖果", "软糖", "水果软糖")),
            ):
                connection.execute(
                    """
                    INSERT INTO douyin_sku_mappings (
                        douyin_sku_id, douyin_product_id, merchant_sku_code,
                        jushuitan_sku_id, product_name, specification,
                        major_category, category_level_1, category_level_2,
                        category_level_3, category_level_4, status,
                        import_batch_id, created_at, updated_at, shop_name
                    ) VALUES (?, ?, ?, ?, '商品', '规格', '食品饮料', ?, ?, ?, ?,
                              'verified', ?, ?, ?, '铭香馆')
                    """,
                    (sku_id, product_id, sku_id, sku_id, *categories, batch_id,
                     "2026-09-11T10:00:00+08:00", "2026-09-11T10:00:00+08:00"),
                )

        self.assertTrue(all(
            item["product_coverage_count"] is None
            for item in list_basic_service_fee_rates(self.database)
        ))
        self.assertEqual(
            {parent_id: 2, specific_id: 1},
            list_basic_service_fee_coverage(self.database),
        )


if __name__ == "__main__":
    unittest.main()
