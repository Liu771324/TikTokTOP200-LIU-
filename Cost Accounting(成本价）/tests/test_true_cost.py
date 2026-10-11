import tempfile
import unittest
from pathlib import Path

from cost_sync.database import connect_database, upsert_products
from cost_sync.models import Product
from cost_sync.service_fee import save_basic_service_fee_rate
from cost_sync.shipping import save_shipping_product_binding, save_shipping_template
from cost_sync.true_cost import estimate_true_cost


CATEGORY = ("食品饮料", "休闲食品", "坚果炒货", "即食板栗")


class TrueCostEstimateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "cost.sqlite3"
        with connect_database(self.database) as connection:
            upsert_products(
                connection,
                [Product("SKU-001", 1, "板栗", "12", 1, None, None)],
                synced_at="2026-09-09T09:00:00+08:00",
            )
            batch_id = connection.execute(
                """
                INSERT INTO mapping_import_batches (
                    source_file, source_sha256, total_rows, verified_rows,
                    pending_rows, inserted_rows, existing_rows, shop_name,
                    status, imported_at
                ) VALUES ('douyin.xlsx', 'hash', 1, 1, 0, 1, 0, '铭香馆',
                          'applied', '2026-09-09T09:01:00+08:00')
                """
            ).lastrowid
            connection.execute(
                """
                INSERT INTO douyin_sku_mappings (
                    douyin_sku_id, douyin_product_id, merchant_sku_code,
                    jushuitan_sku_id, product_name, specification,
                    weight_kg, weight_source, category_level_1, category_level_2,
                    category_level_3, category_level_4, major_category, status, import_batch_id,
                    shop_name, created_at, updated_at
                ) VALUES (
                    'DY-001', 'P-001', 'SKU-001', 'SKU-001', '板栗', '800g*2罐',
                    '1.6', '800g*2', ?, ?, ?, ?, '食品饮料', 'verified', ?, '铭香馆',
                    '2026-09-09T09:01:00+08:00', '2026-09-09T09:01:00+08:00'
                )
                """,
                (*CATEGORY, batch_id),
            )
        save_basic_service_fee_rate(
            self.database,
            category_levels=CATEGORY,
            major_category="食品饮料",
            rate="0.05",
            special_channel_rate="0.50",
            effective_from="2026-09-01",
            changed_at="2026-09-09T09:02:00+08:00",
        )
        self.template_id = save_shipping_template(
            self.database,
            name="铭香馆重量模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            changed_at="2026-09-09T09:03:00+08:00",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_estimate_returns_complete_true_cost_breakdown(self) -> None:
        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-001",
            lowest_price="30",
            shipping_template_id=self.template_id,
            effective_on="2026-09-09",
        )

        self.assertTrue(result.available)
        self.assertEqual("12", result.product_cost)
        self.assertEqual("10", result.shipping_fee)
        self.assertEqual("0.05", result.basic_service_fee_rate)
        self.assertEqual("1.5", result.basic_service_fee)
        self.assertEqual("23.5", result.true_cost)
        self.assertEqual("6.5", result.cost_difference)
        self.assertEqual("+27.66", result.difference_rate_percent)
        self.assertEqual((), result.unconfigured_reasons)

    def test_missing_weight_and_service_rate_return_each_unconfigured_reason(self) -> None:
        with connect_database(self.database) as connection:
            connection.execute(
                "UPDATE douyin_sku_mappings SET weight_kg = NULL WHERE douyin_sku_id = 'DY-001'"
            )
            connection.execute("DELETE FROM basic_service_fee_rate_events")
            connection.execute("DELETE FROM basic_service_fee_rates")

        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-001",
            lowest_price="30",
            shipping_template_id=self.template_id,
            effective_on="2026-09-09",
        )

        self.assertFalse(result.available)
        self.assertEqual(("基础服务费率未配置",), result.unconfigured_reasons)
        self.assertEqual("6", result.shipping_fee)
        self.assertTrue(result.shipping_estimated_from_first_weight)
        self.assertIsNone(result.true_cost)

    def test_estimate_uses_the_product_shipping_template(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="铭香馆默认模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="5",
            additional_weight="0.5",
            additional_fee="1",
            default_region="河北省",
            changed_at="2026-09-09T09:04:00+08:00",
        )
        save_shipping_product_binding(
            self.database, shop_name="铭香馆", douyin_product_id="P-001",
            template_id=template_id, changed_at="2026-09-09T09:05:00+08:00",
        )

        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-001",
            lowest_price="30",
            effective_on="2026-09-09",
        )

        self.assertTrue(result.available)
        self.assertEqual("7", result.shipping_fee)
        self.assertEqual("20.5", result.true_cost)

    def test_missing_product_binding_returns_an_explicit_reason(self) -> None:
        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-001",
            lowest_price="30",
            effective_on="2026-09-09",
        )

        self.assertFalse(result.available)
        self.assertEqual(
            ("商品运费模板未配置",), result.unconfigured_reasons
        )
        self.assertEqual("12", result.product_cost)
        self.assertIsNone(result.shipping_fee)
        self.assertEqual("0.05", result.basic_service_fee_rate)
        self.assertEqual("1.5", result.basic_service_fee)
        self.assertIsNone(result.true_cost)

    def test_disabled_product_template_returns_an_explicit_reason(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="铭香馆停用默认模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="5",
            additional_weight="0.5",
            additional_fee="1",
            default_region="河北省",
            enabled=False,
            changed_at="2026-09-09T09:04:00+08:00",
        )
        save_shipping_product_binding(
            self.database, shop_name="铭香馆", douyin_product_id="P-001",
            template_id=template_id, changed_at="2026-09-09T09:05:00+08:00",
        )

        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-001",
            lowest_price="30",
            effective_on="2026-09-09",
        )

        self.assertFalse(result.available)
        self.assertEqual(
            ("商品运费模板已停用",), result.unconfigured_reasons
        )
        self.assertIsNone(result.true_cost)

    def test_missing_verified_mapping_is_an_unavailable_result(self) -> None:
        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-MISSING",
            lowest_price="30",
            effective_on="2026-09-09",
        )

        self.assertFalse(result.available)
        self.assertIsNone(result.jushuitan_sku_id)
        self.assertEqual(
            ("未找到已验证抖店 SKU 映射",), result.unconfigured_reasons
        )

    def test_missing_product_cost_preserves_shipping_and_service_fee_components(self) -> None:
        with connect_database(self.database) as connection:
            connection.execute(
                "UPDATE products SET cost_price = NULL WHERE sku_id = 'SKU-001'"
            )
        save_shipping_product_binding(
            self.database,
            shop_name="铭香馆",
            douyin_product_id="P-001",
            template_id=self.template_id,
            changed_at="2026-09-09T09:05:00+08:00",
        )

        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-001",
            lowest_price="30",
            effective_on="2026-09-09",
        )

        self.assertFalse(result.available)
        self.assertIsNone(result.product_cost)
        self.assertEqual("10", result.shipping_fee)
        self.assertEqual("1.5", result.basic_service_fee)
        self.assertIsNone(result.true_cost)
        self.assertEqual(("聚水潭成本价未找到",), result.unconfigured_reasons)

    def test_page_category_context_is_used_without_updating_the_mapping(self) -> None:
        with connect_database(self.database) as connection:
            connection.execute("DELETE FROM basic_service_fee_rate_events")
            connection.execute("DELETE FROM basic_service_fee_rates")
            connection.execute(
                """
                UPDATE douyin_sku_mappings
                SET major_category = '',
                    major_category_unconfigured_reason = '经营大类未配置',
                    category_level_1 = '休闲食品', category_level_2 = '糕点/点心',
                    category_level_3 = '蛋黄酥', category_level_4 = ''
                WHERE douyin_sku_id = 'DY-001'
                """
            )
        save_basic_service_fee_rate(
            self.database,
            major_category="食品饮料",
            category_levels=("休闲食品", "/", "/", "/"),
            rate="0.02",
            effective_from="2026-07-15",
            changed_at="2026-07-15T09:00:00+08:00",
        )
        save_shipping_product_binding(
            self.database,
            shop_name="铭香馆",
            douyin_product_id="P-001",
            template_id=self.template_id,
            changed_at="2026-09-09T09:05:00+08:00",
        )

        result = estimate_true_cost(
            self.database,
            douyin_sku_id="DY-001",
            lowest_price="30",
            page_category_levels=("休闲食品", "糕点", "点心", "蛋黄酥"),
            effective_on="2026-09-11",
        )

        self.assertTrue(result.available)
        self.assertEqual("食品饮料", result.major_category)
        self.assertEqual(("休闲食品", "糕点", "点心", "蛋黄酥"), result.category_levels)
        self.assertEqual("page", result.category_source)
        self.assertEqual("0.6", result.basic_service_fee)
        with connect_database(self.database) as connection:
            stored = connection.execute(
                "SELECT major_category, category_level_2, category_level_4 "
                "FROM douyin_sku_mappings WHERE douyin_sku_id = 'DY-001'"
            ).fetchone()
        self.assertEqual(("", "糕点/点心", ""), tuple(stored))


if __name__ == "__main__":
    unittest.main()
