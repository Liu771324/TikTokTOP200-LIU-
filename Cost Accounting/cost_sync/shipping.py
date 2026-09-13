from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from pathlib import Path

from .database import connect_database
from .locks import management_locked
from .update_rollback import backup_database, record_system_update


@dataclass(frozen=True)
class ShippingFeeEstimate:
    template_id: int
    fee: str | None
    region: str | None
    rule_type: str | None
    unconfigured_reason: str | None
    estimated_from_first_weight: bool = False


@dataclass(frozen=True)
class SpecificationWeight:
    weight_kg: str | None
    source: str | None
    unconfigured_reason: str | None


@dataclass(frozen=True)
class DefaultShippingTemplateMatch:
    template_id: int | None
    unconfigured_reason: str | None


@dataclass(frozen=True)
class ProductShippingTemplateMatch:
    template_id: int | None
    unconfigured_reason: str | None


_WEIGHT_EXPRESSION = re.compile(
    r"(?i)(\d+(?:\.\d+)?)\s*(kg|千克|公斤|g|克|斤)"
    r"(?:\s*[x×*]\s*(\d+))?"
)


def parse_specification_weight(specification: object) -> SpecificationWeight:
    text = "" if specification is None else str(specification).strip()
    matches = list(_WEIGHT_EXPRESSION.finditer(text))
    if not matches:
        return SpecificationWeight(None, None, "重量无法从商品规格确定")
    if len(matches) > 1:
        substantive = [
            match for match in matches if _matched_weight(match) != Decimal("0.001")
        ]
        if substantive:
            matches = substantive
    if len(matches) > 1 and not all(
        "+" in text[left.end() : right.start()]
        or "＋" in text[left.end() : right.start()]
        for left, right in zip(matches, matches[1:])
    ):
        return SpecificationWeight(None, None, "重量无法从商品规格确定")
    total = sum((_matched_weight(match) for match in matches), Decimal("0"))
    if total <= 0:
        return SpecificationWeight(None, None, "重量无法从商品规格确定")
    source = "+".join(match.group(0) for match in matches)
    return SpecificationWeight(_decimal_text(total), source, None)


def save_shipping_template(
    database_path: str | Path,
    *,
    template_id: int | None = None,
    name: str,
    shop_name: str = "",
    first_weight: object,
    first_fee: object,
    additional_weight: object,
    additional_fee: object,
    default_region: str = "",
    enabled: bool = True,
    is_default: bool = False,
    region_rules: Iterable[Mapping[str, object]] = (),
    changed_at: str,
) -> int:
    normalized = normalize_shipping_template(
        {
            "template_id": template_id,
            "name": name,
            "shop_name": shop_name,
            "first_weight": first_weight,
            "first_fee": first_fee,
            "additional_weight": additional_weight,
            "additional_fee": additional_fee,
            "default_region": default_region,
            "enabled": enabled,
            "is_default": is_default,
            "region_rules": list(region_rules),
        }
    )
    timestamp = _timestamp(changed_at)
    with connect_database(database_path) as connection:
        return _save_normalized_shipping_template(connection, normalized, timestamp)


def normalize_shipping_template(payload: Mapping[str, object]) -> dict[str, object]:
    if not isinstance(payload, Mapping):
        raise ValueError("运费模板参数必须是对象")
    template_id = payload.get("template_id")
    if template_id is not None and (
        not isinstance(template_id, int) or isinstance(template_id, bool) or template_id <= 0
    ):
        raise ValueError("运费模板编号无效")
    enabled = payload.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ValueError("启用状态必须为布尔值")
    is_default = payload.get("is_default", False)
    if not isinstance(is_default, bool):
        raise ValueError("店铺默认状态必须为布尔值")
    rules = payload.get("region_rules", ())
    if not isinstance(rules, (list, tuple)):
        raise ValueError("地区规则必须是列表")
    return {
        "template_id": template_id,
        "name": _required_text(payload.get("name"), "模板名称"),
        "shop_name": str(payload.get("shop_name") or "").strip(),
        "first_weight": _positive_decimal(payload.get("first_weight"), "首重"),
        "first_fee": _nonnegative_decimal(payload.get("first_fee"), "首费"),
        "additional_weight": _positive_decimal(
            payload.get("additional_weight"), "续重"
        ),
        "additional_fee": _nonnegative_decimal(
            payload.get("additional_fee"), "续费"
        ),
        "default_region": str(payload.get("default_region") or "").strip(),
        "enabled": enabled,
        "is_default": is_default,
        "region_rules": list(_normalize_region_rules(rules)),
    }


@management_locked
def apply_shipping_template_update(
    database_path: str | Path,
    payload: Mapping[str, object],
    *,
    changed_at: str,
) -> dict[str, object]:
    normalized = normalize_shipping_template(payload)
    timestamp = _timestamp(changed_at)
    database = Path(database_path).resolve()
    stamp = datetime.fromisoformat(timestamp).strftime("%Y%m%d-%H%M%S-%f")
    backup = database.with_name(
        f"{database.stem}.before-shipping-{stamp}{database.suffix}.bak"
    )
    backup_sha256 = backup_database(database, backup)
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        mode = "create" if normalized["template_id"] is None else "update"
        template_id = _save_normalized_shipping_template(
            connection, normalized, timestamp
        )
        update_key = f"shipping:{timestamp}:{template_id}"
        record_system_update(
            connection,
            update_key=update_key,
            kind="shipping",
            reference_id=str(template_id),
            completed_at=timestamp,
            backup_path=backup,
            backup_sha256=backup_sha256,
            details={
                "template_id": template_id,
                "name": normalized["name"],
                "shop_name": normalized["shop_name"],
                "mode": mode,
                "is_default": normalized["is_default"],
                "region_rule_count": len(normalized["region_rules"]),
            },
        )
    return {
        "status": "applied",
        "template_id": template_id,
        "mode": mode,
        "backup_file": backup.name,
        "update_id": update_key,
    }


def calculate_shipping_fee(
    database_path: str | Path,
    *,
    template_id: int,
    weight_kg: object,
    region: str = "",
) -> ShippingFeeEstimate:
    with connect_database(database_path) as connection:
        row = connection.execute(
            "SELECT * FROM shipping_templates WHERE id = ?", (template_id,)
        ).fetchone()
        selected_region = str(region).strip()
        rule = None if not selected_region else connection.execute(
            "SELECT * FROM shipping_region_rules WHERE template_id = ? AND region = ?",
            (template_id, selected_region),
        ).fetchone()
    if row is None:
        return ShippingFeeEstimate(
            template_id, None, None, None, "运费模板未配置"
        )
    selected_region = str(region).strip()
    if not int(row["enabled"]):
        return ShippingFeeEstimate(
            template_id, None, selected_region, None, "运费模板已停用"
        )
    first_weight = Decimal(str(row["first_weight"]))
    estimated_from_first_weight = weight_kg is None or not str(weight_kg).strip()
    weight = (
        first_weight
        if estimated_from_first_weight
        else Decimal(_positive_decimal(weight_kg, "商品重量"))
    )
    fee = Decimal(str(row["first_fee"] if rule is None else rule["first_fee"]))
    if weight > first_weight:
        additional_steps = (
            (weight - first_weight) / Decimal(str(row["additional_weight"]))
        ).to_integral_value(rounding=ROUND_CEILING)
        additional_fee = row["additional_fee"] if rule is None else rule["additional_fee"]
        fee += additional_steps * Decimal(str(additional_fee))
    return ShippingFeeEstimate(
        template_id,
        _decimal_text(fee),
        selected_region,
        "default" if rule is None else "region",
        None,
        estimated_from_first_weight,
    )


def save_shipping_product_binding(
    database_path: str | Path,
    *,
    shop_name: str,
    douyin_product_id: str,
    template_id: int,
    changed_at: str,
    enabled: bool = True,
) -> int:
    shop = _required_text(shop_name, "店铺名称")
    product_id = _required_text(douyin_product_id, "抖店商品ID")
    if not isinstance(template_id, int) or isinstance(template_id, bool) or template_id <= 0:
        raise ValueError("运费模板编号无效")
    if not isinstance(enabled, bool):
        raise ValueError("启用状态必须为布尔值")
    timestamp = _timestamp(changed_at)
    with connect_database(database_path) as connection:
        template = connection.execute(
            "SELECT 1 FROM shipping_templates WHERE id = ?", (template_id,)
        ).fetchone()
        if template is None:
            raise ValueError("运费模板不存在")
        connection.execute(
            """
            INSERT INTO shipping_product_bindings (
                shop_name, douyin_product_id, template_id, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(shop_name, douyin_product_id) DO UPDATE SET
                template_id = excluded.template_id,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            """,
            (shop, product_id, template_id, int(enabled), timestamp, timestamp),
        )
        row = connection.execute(
            "SELECT id FROM shipping_product_bindings WHERE shop_name = ? AND douyin_product_id = ?",
            (shop, product_id),
        ).fetchone()
    return int(row["id"])


def match_product_shipping_template(
    database_path: str | Path, *, shop_name: str, douyin_product_id: str
) -> ProductShippingTemplateMatch:
    with connect_database(database_path) as connection:
        row = connection.execute(
            """
            SELECT binding.template_id, binding.enabled AS binding_enabled,
                   template.enabled AS template_enabled
            FROM shipping_product_bindings AS binding
            JOIN shipping_templates AS template ON template.id = binding.template_id
            WHERE binding.shop_name = ? AND binding.douyin_product_id = ?
            """,
            (str(shop_name).strip(), str(douyin_product_id).strip()),
        ).fetchone()
    if row is None:
        return ProductShippingTemplateMatch(None, "商品运费模板未配置")
    template_id = int(row["template_id"])
    if not int(row["binding_enabled"]):
        return ProductShippingTemplateMatch(template_id, "商品运费模板绑定已停用")
    if not int(row["template_enabled"]):
        return ProductShippingTemplateMatch(template_id, "商品运费模板已停用")
    return ProductShippingTemplateMatch(template_id, None)


def normalize_shipping_product_bindings(
    payload: Mapping[str, object],
) -> dict[str, object]:
    if not isinstance(payload, Mapping):
        raise ValueError("商品绑定参数必须是对象")
    template_id = payload.get("template_id")
    if not isinstance(template_id, int) or isinstance(template_id, bool) or template_id <= 0:
        raise ValueError("运费模板编号无效")
    raw_ids = payload.get("douyin_product_ids")
    if not isinstance(raw_ids, (list, tuple)) or not raw_ids:
        raise ValueError("请至少选择一个抖店商品")
    product_ids = tuple(dict.fromkeys(
        _required_text(value, "抖店商品ID") for value in raw_ids
    ))
    return {
        "shop_name": _required_text(payload.get("shop_name"), "店铺名称"),
        "template_id": template_id,
        "douyin_product_ids": product_ids,
    }


@management_locked
def apply_shipping_product_bindings(
    database_path: str | Path,
    payload: Mapping[str, object],
    *,
    changed_at: str,
) -> dict[str, object]:
    normalized = normalize_shipping_product_bindings(payload)
    timestamp = _timestamp(changed_at)
    database = Path(database_path).resolve()
    with connect_database(database) as connection:
        template = connection.execute(
            "SELECT 1 FROM shipping_templates WHERE id = ?",
            (normalized["template_id"],),
        ).fetchone()
        if template is None:
            raise ValueError("运费模板不存在")
        known = {
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT douyin_product_id FROM douyin_sku_mappings "
                "WHERE shop_name = ?",
                (normalized["shop_name"],),
            )
        }
    missing = [value for value in normalized["douyin_product_ids"] if value not in known]
    if missing:
        raise ValueError(f"店铺中不存在抖店商品ID：{missing[0]}")
    stamp = datetime.fromisoformat(timestamp).strftime("%Y%m%d-%H%M%S-%f")
    backup = database.with_name(
        f"{database.stem}.before-shipping-binding-{stamp}{database.suffix}.bak"
    )
    backup_sha256 = backup_database(database, backup)
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.executemany(
            """
            INSERT INTO shipping_product_bindings (
                shop_name, douyin_product_id, template_id, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(shop_name, douyin_product_id) DO UPDATE SET
                template_id = excluded.template_id, enabled = 1,
                updated_at = excluded.updated_at
            """,
            (
                (normalized["shop_name"], product_id, normalized["template_id"],
                 timestamp, timestamp)
                for product_id in normalized["douyin_product_ids"]
            ),
        )
        update_key = f"shipping:{timestamp}:bindings:{normalized['template_id']}"
        record_system_update(
            connection,
            update_key=update_key,
            kind="shipping",
            reference_id=str(normalized["template_id"]),
            completed_at=timestamp,
            backup_path=backup,
            backup_sha256=backup_sha256,
            details={
                "mode": "bind_products",
                "shop_name": normalized["shop_name"],
                "template_id": normalized["template_id"],
                "product_count": len(normalized["douyin_product_ids"]),
            },
        )
    return {
        "status": "applied",
        "template_id": normalized["template_id"],
        "shop_name": normalized["shop_name"],
        "product_count": len(normalized["douyin_product_ids"]),
        "backup_file": backup.name,
        "update_id": update_key,
    }


def list_shipping_product_bindings(
    database_path: str | Path,
) -> dict[str, object]:
    with connect_database(database_path) as connection:
        rows = connection.execute(
            """
            SELECT binding.id, binding.shop_name, binding.douyin_product_id,
                   binding.template_id, template.name AS template_name,
                   binding.enabled, binding.updated_at
            FROM shipping_product_bindings AS binding
            JOIN shipping_templates AS template ON template.id = binding.template_id
            ORDER BY binding.shop_name, binding.douyin_product_id
            """
        ).fetchall()
        products = connection.execute(
            """
            SELECT mapping.shop_name, mapping.douyin_product_id,
                   MIN(mapping.product_name) AS product_name,
                   COUNT(*) AS sku_count, binding.template_id
            FROM douyin_sku_mappings AS mapping
            LEFT JOIN shipping_product_bindings AS binding
              ON binding.shop_name = mapping.shop_name
             AND binding.douyin_product_id = mapping.douyin_product_id
             AND binding.enabled = 1
            WHERE mapping.status = 'verified'
            GROUP BY mapping.shop_name, mapping.douyin_product_id, binding.template_id
            ORDER BY mapping.shop_name, mapping.douyin_product_id
            """
        ).fetchall()
    return {
        "bindings": [dict(row) for row in rows],
        "products": [dict(row) for row in products],
        "unbound_count": sum(row["template_id"] is None for row in products),
    }


def match_default_shipping_template(
    database_path: str | Path, *, shop_name: str
) -> DefaultShippingTemplateMatch:
    with connect_database(database_path) as connection:
        row = connection.execute(
            """
            SELECT id, enabled
            FROM shipping_templates
            WHERE shop_name = ? AND is_default = 1
            """,
            (str(shop_name).strip(),),
        ).fetchone()
    if row is None:
        return DefaultShippingTemplateMatch(None, "店铺默认运费模板未配置")
    if not int(row["enabled"]):
        return DefaultShippingTemplateMatch(
            int(row["id"]), "店铺默认运费模板已停用"
        )
    return DefaultShippingTemplateMatch(int(row["id"]), None)


def list_shipping_templates(
    database_path: str | Path,
) -> list[dict[str, object]]:
    with connect_database(database_path) as connection:
        templates = connection.execute(
            "SELECT * FROM shipping_templates ORDER BY shop_name, name, id"
        ).fetchall()
        result: list[dict[str, object]] = []
        for template in templates:
            product_count = int(connection.execute(
                "SELECT COUNT(*) FROM shipping_product_bindings "
                "WHERE template_id = ? AND enabled = 1",
                (template["id"],),
            ).fetchone()[0])
            rules = connection.execute(
                """
                SELECT region, first_fee, additional_fee, free_shipping
                FROM shipping_region_rules
                WHERE template_id = ?
                ORDER BY region
                """,
                (template["id"],),
            ).fetchall()
            result.append(
                {
                    "id": int(template["id"]),
                    "name": str(template["name"]),
                    "shop_name": str(template["shop_name"]),
                    "first_weight": str(template["first_weight"]),
                    "first_fee": str(template["first_fee"]),
                    "additional_weight": str(template["additional_weight"]),
                    "additional_fee": str(template["additional_fee"]),
                    "default_region": str(template["default_region"]),
                    "enabled": bool(template["enabled"]),
                    "is_default": bool(template["is_default"]),
                    "created_at": str(template["created_at"]),
                    "updated_at": str(template["updated_at"]),
                    "product_count": product_count,
                    "region_rules": [
                        {
                            "region": str(rule["region"]),
                            "first_fee": str(rule["first_fee"]),
                            "additional_fee": str(rule["additional_fee"]),
                            "free_shipping": bool(rule["free_shipping"]),
                        }
                        for rule in rules
                    ],
                }
            )
    return result


def _save_normalized_shipping_template(
    connection,
    normalized: Mapping[str, object],
    timestamp: str,
) -> int:
    values = (
        normalized["name"],
        normalized["shop_name"],
        normalized["first_weight"],
        normalized["first_fee"],
        normalized["additional_weight"],
        normalized["additional_fee"],
        normalized["default_region"],
        int(bool(normalized["enabled"])),
        int(bool(normalized["is_default"])),
    )
    template_id = normalized["template_id"]
    if normalized["is_default"] and template_id is None:
        connection.execute(
            "UPDATE shipping_templates SET is_default = 0 WHERE shop_name = ?",
            (normalized["shop_name"],),
        )
    if template_id is None:
        cursor = connection.execute(
            """
            INSERT INTO shipping_templates (
                name, shop_name, first_weight, first_fee,
                additional_weight, additional_fee, default_region, enabled,
                is_default, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (*values, timestamp, timestamp),
        )
        saved_id = int(cursor.lastrowid)
    else:
        if normalized["is_default"]:
            connection.execute(
                "UPDATE shipping_templates SET is_default = 0 "
                "WHERE shop_name = ? AND id <> ?",
                (normalized["shop_name"], template_id),
            )
        updated = connection.execute(
            """
            UPDATE shipping_templates
            SET name = ?, shop_name = ?, first_weight = ?, first_fee = ?,
                additional_weight = ?, additional_fee = ?, default_region = ?,
                enabled = ?, is_default = ?, updated_at = ?
            WHERE id = ?
            """,
            (*values, timestamp, template_id),
        ).rowcount
        if updated != 1:
            raise ValueError("运费模板不存在")
        connection.execute(
            "DELETE FROM shipping_region_rules WHERE template_id = ?",
            (template_id,),
        )
        saved_id = int(template_id)
    connection.executemany(
        """
        INSERT INTO shipping_region_rules (
            template_id, region, first_fee, additional_fee, free_shipping
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            (
                saved_id,
                rule["region"],
                rule["first_fee"],
                rule["additional_fee"],
                int(bool(rule["free_shipping"])),
            )
            for rule in normalized["region_rules"]
        ),
    )
    return saved_id


def _required_text(value: object, field: str) -> str:
    if value is None:
        raise ValueError(f"{field}不能为空")
    text = str(value).strip()
    if not text:
        raise ValueError(f"{field}不能为空")
    return text


def _decimal(value: object, field: str) -> Decimal:
    if isinstance(value, bool):
        raise ValueError(f"{field}无效")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"{field}无效") from exc
    if not number.is_finite():
        raise ValueError(f"{field}无效")
    return number


def _positive_decimal(value: object, field: str) -> str:
    number = _decimal(value, field)
    if number <= 0:
        raise ValueError(f"{field}必须大于 0")
    return _decimal_text(number)


def _nonnegative_decimal(value: object, field: str) -> str:
    number = _decimal(value, field)
    if number < 0:
        raise ValueError(f"{field}不能为负数")
    return _decimal_text(number)


def _decimal_text(number: Decimal) -> str:
    normalized = format(number, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"


def _timestamp(value: str) -> str:
    try:
        return datetime.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as exc:
        raise ValueError("修改时间必须为 ISO 8601 时间") from exc


def _unit_in_kg(unit: str) -> Decimal:
    normalized = unit.lower()
    if normalized in {"kg", "千克", "公斤"}:
        return Decimal("1")
    if normalized in {"g", "克"}:
        return Decimal("0.001")
    return Decimal("0.5")


def _matched_weight(match: re.Match[str]) -> Decimal:
    unit_weight = Decimal(match.group(1)) * _unit_in_kg(match.group(2))
    return unit_weight * int(match.group(3) or "1")


def _normalize_region_rules(
    rules: Iterable[Mapping[str, object]],
) -> tuple[dict[str, object], ...]:
    normalized: list[dict[str, object]] = []
    seen: set[str] = set()
    for rule in rules:
        region = _required_text(rule.get("region"), "地区")
        if region in seen:
            raise ValueError(f"地区规则重复：{region}")
        seen.add(region)
        free_shipping = rule.get("free_shipping", False)
        if not isinstance(free_shipping, bool):
            raise ValueError("包邮状态必须为布尔值")
        normalized.append(
            {
                "region": region,
                "first_fee": _nonnegative_decimal(rule.get("first_fee", 0), "地区首费"),
                "additional_fee": _nonnegative_decimal(
                    rule.get("additional_fee", 0), "地区续费"
                ),
                "free_shipping": free_shipping,
            }
        )
    return tuple(normalized)
