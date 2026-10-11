from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation


@dataclass(frozen=True)
class Product:
    sku_id: str
    autoid: int | None
    name: str
    cost_price: str | None
    enabled: int
    created: str | None
    modified: str | None

    @classmethod
    def from_api(cls, item: dict) -> "Product":
        sku_id = str(item.get("sku_id") or "").strip()
        if not sku_id:
            raise ValueError("商品缺少有效 sku_id")

        enabled = item.get("enabled")
        if isinstance(enabled, bool):
            raise ValueError(f"商品 {sku_id} 的 enabled 无效")
        try:
            enabled = int(enabled)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"商品 {sku_id} 的 enabled 无效") from exc
        if enabled not in (-1, 0, 1):
            raise ValueError(f"商品 {sku_id} 的 enabled 无效: {enabled}")

        autoid_value = item.get("autoid")
        try:
            autoid = None if autoid_value in (None, "") else int(autoid_value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"商品 {sku_id} 的 autoid 无效") from exc

        return cls(
            sku_id=sku_id,
            autoid=autoid,
            name=str(item.get("name") or ""),
            cost_price=normalize_decimal(item.get("cost_price"), sku_id=sku_id),
            enabled=enabled,
            created=_optional_text(item.get("created")),
            modified=_optional_text(item.get("modified")),
        )


def normalize_decimal(value: object, *, sku_id: str = "") -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise ValueError(f"商品 {sku_id} 的 cost_price 无效")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"商品 {sku_id} 的 cost_price 无效") from exc
    if not number.is_finite():
        raise ValueError(f"商品 {sku_id} 的 cost_price 无效")
    if number < 0:
        raise ValueError(f"商品 {sku_id} 的 cost_price 不能为负数")
    normalized = format(number, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"


def _optional_text(value: object) -> str | None:
    if value in (None, ""):
        return None
    return str(value)
