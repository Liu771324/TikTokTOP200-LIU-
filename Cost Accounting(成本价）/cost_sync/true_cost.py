from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

from .database import connect_database
from .service_fee import infer_major_category, match_basic_service_fee_rate
from .shipping import calculate_shipping_fee, match_product_shipping_template


@dataclass(frozen=True)
class TrueCostEstimate:
    douyin_sku_id: str
    available: bool
    jushuitan_sku_id: str | None
    product_cost: str | None
    weight_kg: str | None
    shipping_fee: str | None
    shipping_region: str | None
    major_category: str
    category_levels: tuple[str, str, str, str]
    category_source: str
    basic_service_fee_rate: str | None
    basic_service_fee: str | None
    lowest_price: str
    true_cost: str | None
    cost_difference: str | None
    difference_rate_percent: str | None
    unconfigured_reasons: tuple[str, ...]
    shipping_estimated_from_first_weight: bool = False
    estimated: bool = True


def estimate_true_cost(
    database_path: str | Path,
    *,
    douyin_sku_id: str,
    lowest_price: object,
    shipping_template_id: int | None = None,
    page_category_levels: tuple[str, str, str, str] | None = None,
    effective_on: str,
    region: str = "",
) -> TrueCostEstimate:
    price = _positive_decimal(lowest_price, "最低到手价")
    with connect_database(database_path) as connection:
        row = connection.execute(
            """
            SELECT mappings.jushuitan_sku_id, mappings.shop_name,
                   mappings.douyin_product_id, mappings.weight_kg,
                   mappings.major_category, mappings.major_category_unconfigured_reason,
                   mappings.category_level_1, mappings.category_level_2,
                   mappings.category_level_3, mappings.category_level_4,
                   products.cost_price
            FROM douyin_sku_mappings AS mappings
            JOIN products ON products.sku_id = mappings.jushuitan_sku_id
            WHERE mappings.douyin_sku_id = ? AND mappings.status = 'verified'
              AND products.enabled = 1
            """,
            (str(douyin_sku_id).strip(),),
        ).fetchone()
    if row is None:
        return TrueCostEstimate(
            douyin_sku_id=str(douyin_sku_id).strip(),
            available=False,
            jushuitan_sku_id=None,
            product_cost=None,
            weight_kg=None,
            shipping_fee=None,
            shipping_region=None,
            major_category="",
            category_levels=("", "", "", ""),
            category_source="none",
            basic_service_fee_rate=None,
            basic_service_fee=None,
            lowest_price=_decimal_text(price),
            true_cost=None,
            cost_difference=None,
            difference_rate_percent=None,
            unconfigured_reasons=("未找到已验证抖店 SKU 映射",),
            shipping_estimated_from_first_weight=False,
        )

    stored_categories = tuple(
        str(row[f"category_level_{index}"]) for index in range(1, 5)
    )
    categories = stored_categories
    category_source = "mapping"
    major_category = str(row["major_category"])
    major_category_reason = str(
        row["major_category_unconfigured_reason"] or ""
    ).strip()
    if page_category_levels is not None:
        categories = _page_categories(page_category_levels)
        category_source = "page"
        inferred_major = infer_major_category(database_path, categories[0])
        if inferred_major is not None:
            major_category = inferred_major
            major_category_reason = ""
        elif stored_categories[0] == categories[0] and major_category:
            major_category_reason = ""
        else:
            major_category = ""
            major_category_reason = "经营大类无法从页面类目唯一确定"
    fee_match = match_basic_service_fee_rate(
        database_path,
        major_category=major_category,
        category_levels=categories,  # type: ignore[arg-type]
        effective_on=effective_on,
    )
    product_match = None
    if shipping_template_id is None:
        product_match = match_product_shipping_template(
            database_path,
            shop_name=str(row["shop_name"]),
            douyin_product_id=str(row["douyin_product_id"]),
        )
        shipping_template_id = product_match.template_id
    product_template_reason = (
        None if product_match is None else product_match.unconfigured_reason
    )
    shipping = (
        None
        if shipping_template_id is None or product_template_reason is not None
        else calculate_shipping_fee(
            database_path,
            template_id=shipping_template_id,
            weight_kg=row["weight_kg"],
            region=region,
        )
    )
    product_cost, product_cost_reason = _product_cost_component(row["cost_price"])
    service_fee = (
        None
        if fee_match.rate is None
        else price * Decimal(str(fee_match.rate))
    )
    reasons = tuple(
        reason
        for reason in (
            product_cost_reason,
            product_template_reason,
            None if shipping is None else shipping.unconfigured_reason,
            major_category_reason or fee_match.unconfigured_reason,
        )
        if reason
    )
    if reasons:
        return TrueCostEstimate(
            douyin_sku_id=str(douyin_sku_id).strip(),
            available=False,
            jushuitan_sku_id=str(row["jushuitan_sku_id"]),
            product_cost=(
                None if product_cost is None else _decimal_text(product_cost)
            ),
            weight_kg=None if row["weight_kg"] is None else str(row["weight_kg"]),
            shipping_fee=None if shipping is None else shipping.fee,
            shipping_region=None if shipping is None else shipping.region,
            major_category=major_category,
            category_levels=categories,  # type: ignore[arg-type]
            category_source=category_source,
            basic_service_fee_rate=fee_match.rate,
            basic_service_fee=(
                None if service_fee is None else _decimal_text(service_fee)
            ),
            lowest_price=_decimal_text(price),
            true_cost=None,
            cost_difference=None,
            difference_rate_percent=None,
            unconfigured_reasons=reasons,
            shipping_estimated_from_first_weight=(
                False if shipping is None else shipping.estimated_from_first_weight
            ),
        )
    assert service_fee is not None
    assert product_cost is not None
    true_cost = product_cost + Decimal(str(shipping.fee)) + service_fee
    difference = price - true_cost
    difference_rate = (difference / true_cost * Decimal("100")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    return TrueCostEstimate(
        douyin_sku_id=str(douyin_sku_id).strip(),
        available=True,
        jushuitan_sku_id=str(row["jushuitan_sku_id"]),
        product_cost=_decimal_text(product_cost),
        weight_kg=str(row["weight_kg"]),
        shipping_fee=shipping.fee,
        shipping_region=shipping.region,
        major_category=major_category,
        category_levels=categories,  # type: ignore[arg-type]
        category_source=category_source,
        basic_service_fee_rate=fee_match.rate,
        basic_service_fee=_decimal_text(service_fee),
        lowest_price=_decimal_text(price),
        true_cost=_decimal_text(true_cost),
        cost_difference=_decimal_text(difference),
        difference_rate_percent=f"{difference_rate:+.2f}",
        unconfigured_reasons=(),
        shipping_estimated_from_first_weight=shipping.estimated_from_first_weight,
    )


def _positive_decimal(value: object, field: str) -> Decimal:
    if isinstance(value, bool):
        raise ValueError(f"{field}无效")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{field}无效") from exc
    if not number.is_finite() or number <= 0:
        raise ValueError(f"{field}必须大于 0")
    return number


def _product_cost_component(value: object) -> tuple[Decimal | None, str | None]:
    if value is None or not str(value).strip():
        return None, "聚水潭成本价未找到"
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None, "聚水潭成本价无效"
    if not number.is_finite() or number <= 0:
        return None, "聚水潭成本价无效"
    return number, None


def _page_categories(
    values: tuple[str, str, str, str],
) -> tuple[str, str, str, str]:
    if not isinstance(values, tuple) or len(values) != 4:
        raise ValueError("页面类目必须提供完整四级类目")
    categories = tuple(str(value).strip() for value in values)
    if any(not value or value == "/" for value in categories):
        raise ValueError("页面类目必须提供完整四级类目")
    return categories  # type: ignore[return-value]


def _decimal_text(number: Decimal) -> str:
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"
