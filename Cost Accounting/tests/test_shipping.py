import tempfile
import unittest
from pathlib import Path

from cost_sync.database import connect_database, copy_mapping_state
from cost_sync.shipping import (
    calculate_shipping_fee,
    list_shipping_templates,
    match_default_shipping_template,
    match_product_shipping_template,
    normalize_shipping_template,
    parse_specification_weight,
    save_shipping_template,
    save_shipping_product_binding,
)


class ShippingTemplateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "cost.sqlite3"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_specification_weight_multiplies_each_unit_by_package_count(self) -> None:
        examples = {
            "{规格:香蕉脆卷100g*5袋}": "0.5",
            "{口味分类:优质款，规格:500g*2罐}": "1",
            "{规格:燕麦片250克×3袋}": "0.75",
        }

        for specification, expected in examples.items():
            with self.subTest(specification=specification):
                result = parse_specification_weight(specification)
                self.assertEqual(expected, result.weight_kg)
                self.assertIsNone(result.unconfigured_reason)

    def test_explicit_plus_bundle_sums_each_weight_expression(self) -> None:
        result = parse_specification_weight(
            "{规格:丹参100g*1罐+山楂80g*1罐+橘皮80g*1罐}"
        )

        self.assertEqual("0.26", result.weight_kg)
        self.assertIsNone(result.unconfigured_reason)

    def test_one_gram_placeholder_is_ignored_when_another_field_has_weight(self) -> None:
        result = parse_specification_weight("{净重:1g*1罐，口味:250g*3罐}")

        self.assertEqual("0.75", result.weight_kg)
        self.assertEqual("250g*3", result.source)

    def test_base_rule_charges_first_weight_plus_rounded_up_additional_weight(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="铭香馆重量模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            changed_at="2026-09-08T17:00:00+08:00",
        )

        result = calculate_shipping_fee(
            self.database,
            template_id=template_id,
            weight_kg="1.6",
            region="北京市",
        )

        self.assertEqual("10", result.fee)
        self.assertEqual("北京市", result.region)
        self.assertEqual("default", result.rule_type)
        self.assertIsNone(result.unconfigured_reason)

    def test_missing_product_weight_uses_the_template_first_weight_and_fee(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="铭香馆重量模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            changed_at="2026-09-08T17:00:00+08:00",
        )

        result = calculate_shipping_fee(
            self.database,
            template_id=template_id,
            weight_kg=None,
            region="河北省",
        )

        self.assertEqual("6", result.fee)
        self.assertTrue(result.estimated_from_first_weight)
        self.assertIsNone(result.unconfigured_reason)

    def test_template_name_cannot_be_missing(self) -> None:
        with self.assertRaisesRegex(ValueError, "模板名称不能为空"):
            normalize_shipping_template(
                {
                    "name": None,
                    "shop_name": "铭香馆",
                    "first_weight": "1",
                    "first_fee": "6",
                    "additional_weight": "0.5",
                    "additional_fee": "2",
                }
            )

    def test_region_rule_overrides_prices_and_free_shipping_does_not_zero_internal_cost(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="铭香馆地区模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            region_rules=(
                {
                    "region": "北京市",
                    "first_fee": "3",
                    "additional_fee": "1",
                    "free_shipping": False,
                },
                {
                    "region": "河北省",
                    "first_fee": "7",
                    "additional_fee": "2",
                    "free_shipping": True,
                },
            ),
            changed_at="2026-09-08T17:30:00+08:00",
        )

        beijing = calculate_shipping_fee(
            self.database, template_id=template_id, weight_kg="1.6", region="北京市"
        )
        free = calculate_shipping_fee(
            self.database, template_id=template_id, weight_kg="9", region="河北省"
        )
        missing_weight = calculate_shipping_fee(
            self.database, template_id=template_id, weight_kg=None, region="北京市"
        )

        self.assertEqual(("5", "region"), (beijing.fee, beijing.rule_type))
        self.assertEqual(("39", "region"), (free.fee, free.rule_type))
        self.assertEqual(("3", True), (
            missing_weight.fee, missing_weight.estimated_from_first_weight
        ))

    def test_generic_template_uses_ceiling_for_each_started_additional_kilogram(self) -> None:
        template_id = save_shipping_template(
            self.database, name="通用模板", shop_name="", first_weight="1",
            first_fee="3", additional_weight="1", additional_fee="1",
            changed_at="2026-09-10T10:00:00+08:00",
        )

        actual = [
            calculate_shipping_fee(
                self.database, template_id=template_id, weight_kg=weight
            ).fee
            for weight in ("0.5", "1", "1.1", "2", "2.1")
        ]

        self.assertEqual(["3", "3", "4", "4", "5"], actual)

    def test_product_binding_is_scoped_by_shop_and_product(self) -> None:
        template_id = save_shipping_template(
            self.database, name="通用模板", shop_name="", first_weight="1",
            first_fee="3", additional_weight="1", additional_fee="1",
            changed_at="2026-09-10T10:00:00+08:00",
        )
        save_shipping_product_binding(
            self.database, shop_name="铭香馆", douyin_product_id="P-100",
            template_id=template_id, changed_at="2026-09-10T10:01:00+08:00",
        )

        matched = match_product_shipping_template(
            self.database, shop_name="铭香馆", douyin_product_id="P-100"
        )
        missing = match_product_shipping_template(
            self.database, shop_name="铭香馆", douyin_product_id="P-101"
        )

        self.assertEqual(template_id, matched.template_id)
        self.assertIsNone(matched.unconfigured_reason)
        self.assertEqual("商品运费模板未配置", missing.unconfigured_reason)

    def test_template_list_returns_editable_values_and_region_rules(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="铭香馆模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            region_rules=(
                {
                    "region": "北京市",
                    "first_fee": "3",
                    "additional_fee": "1",
                    "free_shipping": False,
                },
            ),
            changed_at="2026-09-08T17:30:00+08:00",
        )

        templates = list_shipping_templates(self.database)

        self.assertEqual(1, len(templates))
        self.assertEqual(template_id, templates[0]["id"])
        self.assertEqual("0.5", templates[0]["additional_weight"])
        self.assertEqual("北京市", templates[0]["region_rules"][0]["region"])
        self.assertEqual(0, templates[0]["product_count"])

    def test_new_shop_default_replaces_the_previous_default(self) -> None:
        first_id = save_shipping_template(
            self.database,
            name="铭香馆旧默认模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            is_default=True,
            changed_at="2026-09-08T17:30:00+08:00",
        )
        second_id = save_shipping_template(
            self.database,
            name="铭香馆新默认模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="5",
            additional_weight="0.5",
            additional_fee="1",
            default_region="河北省",
            is_default=True,
            changed_at="2026-09-08T17:40:00+08:00",
        )

        templates = list_shipping_templates(self.database)

        self.assertEqual(second_id, match_default_shipping_template(
            self.database, shop_name="铭香馆"
        ).template_id)
        self.assertEqual(
            [second_id],
            [template["id"] for template in templates if template["is_default"]],
        )
        self.assertNotEqual(first_id, second_id)

    def test_saving_existing_template_replaces_values_and_region_rules(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="旧模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="1",
            additional_fee="2",
            default_region="河北省",
            changed_at="2026-09-08T17:30:00+08:00",
        )

        saved_id = save_shipping_template(
            self.database,
            template_id=template_id,
            name="现用模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="5",
            additional_weight="0.5",
            additional_fee="1.5",
            default_region="北京市",
            enabled=False,
            region_rules=(
                {
                    "region": "上海市",
                    "first_fee": "4",
                    "additional_fee": "1",
                    "free_shipping": False,
                },
            ),
            changed_at="2026-09-08T17:40:00+08:00",
        )

        template = list_shipping_templates(self.database)[0]
        self.assertEqual(template_id, saved_id)
        self.assertEqual("现用模板", template["name"])
        self.assertFalse(template["enabled"])
        self.assertEqual(["上海市"], [rule["region"] for rule in template["region_rules"]])

    def test_cost_snapshot_rebuild_preserves_shipping_templates(self) -> None:
        template_id = save_shipping_template(
            self.database,
            name="铭香馆模板",
            shop_name="铭香馆",
            first_weight="1",
            first_fee="6",
            additional_weight="0.5",
            additional_fee="2",
            default_region="河北省",
            is_default=True,
            changed_at="2026-09-08T17:30:00+08:00",
        )
        rebuilt = Path(self.temp_dir.name) / "rebuilt.sqlite3"

        with connect_database(rebuilt) as target:
            copy_mapping_state(self.database, target)

        result = calculate_shipping_fee(
            rebuilt, template_id=template_id, weight_kg="1.6", region="北京市"
        )
        self.assertEqual("10", result.fee)
        self.assertEqual(
            template_id,
            match_default_shipping_template(
                rebuilt, shop_name="铭香馆"
            ).template_id,
        )

    def test_cost_snapshot_rebuild_preserves_product_bindings(self) -> None:
        template_id = save_shipping_template(
            self.database, name="通用模板", shop_name="", first_weight="1",
            first_fee="3", additional_weight="1", additional_fee="1",
            changed_at="2026-09-10T10:00:00+08:00",
        )
        save_shipping_product_binding(
            self.database, shop_name="铭香馆", douyin_product_id="P-100",
            template_id=template_id, changed_at="2026-09-10T10:01:00+08:00",
        )
        rebuilt = Path(self.temp_dir.name) / "rebuilt-bindings.sqlite3"

        with connect_database(rebuilt) as target:
            copy_mapping_state(self.database, target)

        match = match_product_shipping_template(
            rebuilt, shop_name="铭香馆", douyin_product_id="P-100"
        )
        self.assertEqual(template_id, match.template_id)


if __name__ == "__main__":
    unittest.main()
