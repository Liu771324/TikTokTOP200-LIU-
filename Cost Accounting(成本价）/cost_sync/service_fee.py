from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from collections.abc import Mapping, Sequence
from pathlib import Path

from .database import connect_database
from .locks import management_locked
from .update_rollback import backup_database, record_system_update


OTHER_CATEGORY_RULES = (
    "其他一级类目",
    "其他二级类目",
    "其他三级类目",
    "其他四级类目",
)


@dataclass(frozen=True)
class BasicServiceFeeMatch:
    rate_id: int | None
    rate: str | None
    effective_from: str | None
    unconfigured_reason: str | None
    major_category: str | None = None


@dataclass(frozen=True)
class BasicServiceFeeHistoryEntry:
    event_id: int
    rate_id: int
    action: str
    rate: str
    effective_from: str
    enabled: bool
    note: str
    changed_at: str


def list_basic_service_fee_rates(
    database_path: str | Path,
    *,
    archived: bool = False,
) -> list[dict[str, object]]:
    with connect_database(database_path) as connection:
        rows = connection.execute(
            """
            SELECT rates.id, rates.major_category, rates.category_level_1,
                   rates.category_level_2, rates.category_level_3,
                   rates.category_level_4, rates.rate,
                   special_channel_rate, effective_from, enabled, note,
                   source_article_id, source_updated_at, imported_at,
                   source_checksum, created_at, updated_at,
                   archived, archived_at,
                   (CASE WHEN rates.category_level_1 <> '/' THEN 1 ELSE 0 END +
                    CASE WHEN rates.category_level_2 <> '/' THEN 1 ELSE 0 END +
                    CASE WHEN rates.category_level_3 <> '/' THEN 1 ELSE 0 END +
                    CASE WHEN rates.category_level_4 <> '/' THEN 1 ELSE 0 END) AS specificity
            FROM basic_service_fee_rates AS rates
            WHERE rates.archived = ?
            ORDER BY major_category, category_level_1, category_level_2,
                     category_level_3, category_level_4,
                     effective_from DESC, id DESC
            """,
            (int(archived),),
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "major_category": str(row["major_category"]),
            "category_levels": [
                str(row[f"category_level_{index}"]) for index in range(1, 5)
            ],
            "rate": str(row["rate"]),
            "special_channel_rate": (
                None
                if row["special_channel_rate"] is None
                else str(row["special_channel_rate"])
            ),
            "effective_from": str(row["effective_from"]),
            "enabled": bool(row["enabled"]),
            "archived": bool(row["archived"]),
            "archived_at": None if row["archived_at"] is None else str(row["archived_at"]),
            "note": str(row["note"]),
            "source_article_id": str(row["source_article_id"]),
            "source_updated_at": (
                None if row["source_updated_at"] is None else str(row["source_updated_at"])
            ),
            "imported_at": None if row["imported_at"] is None else str(row["imported_at"]),
            "source_checksum": str(row["source_checksum"]),
            "specificity": int(row["specificity"]),
            "product_coverage_count": None,
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }
        for row in rows
    ]


def list_basic_service_fee_coverage(
    database_path: str | Path,
    *,
    archived: bool = False,
) -> dict[int, int]:
    with connect_database(database_path) as connection:
        rule_rows = connection.execute(
            """
            SELECT id, major_category, category_level_1, category_level_2,
                   category_level_3, category_level_4
            FROM basic_service_fee_rates
            WHERE archived = ?
            ORDER BY id
            """,
            (int(archived),),
        ).fetchall()
        mapping_rows = connection.execute(
            """
            SELECT DISTINCT shop_name, douyin_product_id, major_category,
                            category_level_1, category_level_2,
                            category_level_3, category_level_4
            FROM douyin_sku_mappings
            WHERE status = 'verified'
            """
        ).fetchall()

    rules_by_major: dict[str, list[tuple[int, tuple[str, str, str, str]]]] = {}
    coverage: dict[int, set[tuple[str, str]]] = {}
    for row in rule_rows:
        rate_id = int(row["id"])
        categories = tuple(
            str(row[f"category_level_{index}"]) for index in range(1, 5)
        )
        rules_by_major.setdefault(str(row["major_category"]), []).append(
            (rate_id, categories)  # type: ignore[arg-type]
        )
        coverage[rate_id] = set()
    for row in mapping_rows:
        categories = tuple(
            str(row[f"category_level_{index}"]) for index in range(1, 5)
        )
        product_key = (str(row["shop_name"]), str(row["douyin_product_id"]))
        for rate_id, rule_categories in rules_by_major.get(
            str(row["major_category"]), []
        ):
            if score_service_fee_category_rule(rule_categories, categories) is not None:
                coverage[rate_id].add(product_key)
    return {rate_id: len(products) for rate_id, products in coverage.items()}


def infer_major_category(
    database_path: str | Path, category_level_1: object
) -> str | None:
    category = str(category_level_1 or "").strip()
    if not category:
        return None
    with connect_database(database_path) as connection:
        rows = connection.execute(
            """
            SELECT DISTINCT major_category
            FROM basic_service_fee_rates
            WHERE archived = 0 AND category_level_1 = ? AND major_category <> ''
            ORDER BY major_category
            """,
            (category,),
        ).fetchall()
    values = [str(row["major_category"]) for row in rows]
    return values[0] if len(values) == 1 else None


@management_locked
def import_official_service_fee_catalog(
    database_path: str | Path,
    rules: Sequence[Mapping[str, object]],
    *,
    source_article_id: str,
    source_updated_at: str,
    effective_from: str,
    imported_at: str,
) -> dict[str, object]:
    if not isinstance(rules, (list, tuple)) or not rules:
        raise ValueError("官方基础服务费目录不能为空")
    article_id = str(source_article_id).strip()
    if not article_id:
        raise ValueError("官方来源文章 ID 不能为空")
    updated_at = _normalize_timestamp(source_updated_at)
    timestamp = _normalize_timestamp(imported_at)
    effective_date = _normalize_date(effective_from, field="生效日期")
    normalized_rules: list[dict[str, object]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for raw_rule in rules:
        normalized = normalize_basic_service_fee_change(
            {
                "operation": "create_version",
                **dict(raw_rule),
                "effective_from": effective_date,
            }
        )
        major_category = str(normalized["major_category"])
        if not major_category:
            raise ValueError("官方基础服务费规则缺少大类")
        key = (major_category, *normalized["category_levels"])
        if key in seen:
            raise ValueError("官方基础服务费目录中存在重复规则")
        seen.add(key)
        normalized_rules.append(normalized)
    canonical = [
        {
            "major_category": rule["major_category"],
            "category_levels": list(rule["category_levels"]),
            "rate": rule["rate"],
            "special_channel_rate": rule["special_channel_rate"],
        }
        for rule in normalized_rules
    ]
    checksum = hashlib.sha256(
        json.dumps(
            canonical,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    database = Path(database_path).resolve()
    with connect_database(database) as connection:
        existing = connection.execute(
            """
            SELECT id, rule_count
            FROM service_fee_catalog_imports
            WHERE source_article_id = ? AND source_updated_at = ?
              AND source_checksum = ?
            """,
            (article_id, updated_at, checksum),
        ).fetchone()
    if existing is not None:
        return {
            "status": "unchanged",
            "count": int(existing["rule_count"]),
            "catalog_import_id": int(existing["id"]),
            "source_checksum": checksum,
            "reused_import": True,
            "backup_file": None,
            "update_id": None,
        }

    stamp = datetime.fromisoformat(timestamp).strftime("%Y%m%d-%H%M%S-%f")
    backup = _available_backup_path(database, stamp)
    backup_sha256 = backup_database(database, backup)
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        cursor = connection.execute(
            """
            INSERT INTO service_fee_catalog_imports (
                source_article_id, source_updated_at, imported_at,
                source_checksum, rule_count
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (article_id, updated_at, timestamp, checksum, len(normalized_rules)),
        )
        catalog_import_id = int(cursor.lastrowid)
        rate_ids: list[int] = []
        event_ids: list[int] = []
        for rule in normalized_rules:
            categories = rule["category_levels"]
            duplicate = connection.execute(
                """
                SELECT 1 FROM basic_service_fee_rates
                WHERE major_category = ?
                  AND category_level_1 = ? AND category_level_2 = ?
                  AND category_level_3 = ? AND category_level_4 = ?
                  AND effective_from = ?
                """,
                (
                    rule["major_category"],
                    *categories,
                    effective_date,
                ),
            ).fetchone()
            if duplicate is not None:
                raise ValueError("相同大类、四级类目和生效日期已存在")
            rate_id = int(
                connection.execute(
                    """
                    INSERT INTO basic_service_fee_rates (
                        major_category, category_level_1, category_level_2,
                        category_level_3, category_level_4, rate,
                        special_channel_rate, effective_from, note,
                        source_article_id, source_updated_at, imported_at,
                        source_checksum, catalog_import_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rule["major_category"],
                        *categories,
                        rule["rate"],
                        rule["special_channel_rate"],
                        effective_date,
                        "抖店官方基础技术服务费率",
                        article_id,
                        updated_at,
                        timestamp,
                        checksum,
                        catalog_import_id,
                        timestamp,
                        timestamp,
                    ),
                ).lastrowid
            )
            event_id = int(
                connection.execute(
                    """
                    INSERT INTO basic_service_fee_rate_events (
                        rate_id, action, enabled, changed_at
                    ) VALUES (?, 'created', 1, ?)
                    """,
                    (rate_id, timestamp),
                ).lastrowid
            )
            rate_ids.append(rate_id)
            event_ids.append(event_id)
        _backfill_mapping_major_categories(connection)
        update_key = (
            f"service_fee:{timestamp}:official:{catalog_import_id}:"
            f"{event_ids[0]}-{event_ids[-1]}"
        )
        record_system_update(
            connection,
            update_key=update_key,
            kind="service_fee",
            reference_id=f"official:{article_id}:{catalog_import_id}",
            completed_at=timestamp,
            backup_path=backup,
            backup_sha256=backup_sha256,
            details={
                "operation": "import_official_catalog",
                "count": len(rate_ids),
                "source_article_id": article_id,
                "source_updated_at": updated_at,
                "source_checksum": checksum,
                "effective_from": effective_date,
                "catalog_import_id": catalog_import_id,
            },
        )
    return {
        "status": "applied",
        "count": len(rate_ids),
        "catalog_import_id": catalog_import_id,
        "source_checksum": checksum,
        "reused_import": False,
        "backup_file": backup.name,
        "update_id": update_key,
    }


def normalize_basic_service_fee_change(
    payload: Mapping[str, object],
) -> dict[str, object]:
    if not isinstance(payload, Mapping):
        raise ValueError("基础服务费参数必须是对象")
    operation = payload.get("operation")
    if operation == "create_version":
        raw_categories = payload.get("category_levels")
        if not isinstance(raw_categories, (list, tuple)) or len(raw_categories) != 4:
            raise ValueError("基础服务费必须提供完整四级类目")
        categories = _normalize_categories(tuple(raw_categories))
        major_category = str(payload.get("major_category") or "").strip()
        if not major_category:
            raise ValueError("经营大类不能为空")
        return {
            "operation": operation,
            "major_category": major_category,
            "category_levels": categories,
            "rate": _normalize_rate(payload.get("rate")),
            "special_channel_rate": _normalize_optional_rate(
                payload.get("special_channel_rate")
            ),
            "effective_from": _normalize_date(
                payload.get("effective_from"), field="生效日期"
            ),
            "note": str(payload.get("note") or "").strip(),
        }
    if operation == "set_enabled":
        rate_id = payload.get("rate_id")
        enabled = payload.get("enabled")
        if (
            not isinstance(rate_id, int)
            or isinstance(rate_id, bool)
            or rate_id <= 0
        ):
            raise ValueError("基础服务费率编号无效")
        if not isinstance(enabled, bool):
            raise ValueError("启用状态必须为布尔值")
        return {"operation": operation, "rate_id": rate_id, "enabled": enabled}
    raise ValueError("基础服务费操作无效")


@management_locked
def apply_basic_service_fee_update(
    database_path: str | Path,
    payload: Mapping[str, object],
    *,
    changed_at: str,
) -> dict[str, object]:
    normalized = normalize_basic_service_fee_change(payload)
    timestamp = _normalize_timestamp(changed_at)
    database = Path(database_path).resolve()
    stamp = datetime.fromisoformat(timestamp).strftime("%Y%m%d-%H%M%S-%f")
    backup = _available_backup_path(database, stamp)
    backup_sha256 = backup_database(database, backup)
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        if normalized["operation"] == "create_version":
            categories = normalized["category_levels"]
            major_category = normalized["major_category"]
            duplicate = connection.execute(
                """
                SELECT 1 FROM basic_service_fee_rates
                WHERE major_category = ?
                  AND category_level_1 = ? AND category_level_2 = ?
                  AND category_level_3 = ? AND category_level_4 = ?
                  AND effective_from = ?
                """,
                (major_category, *categories, normalized["effective_from"]),
            ).fetchone()
            if duplicate is not None:
                raise ValueError(
                    "相同经营大类、四级类目和生效日期已存在，请选择新的生效日期"
                )
            cursor = connection.execute(
                """
                INSERT INTO basic_service_fee_rates (
                    major_category, category_level_1, category_level_2,
                    category_level_3, category_level_4, rate,
                    special_channel_rate, effective_from, note,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    major_category,
                    *categories,
                    normalized["rate"],
                    normalized["special_channel_rate"],
                    normalized["effective_from"],
                    normalized["note"],
                    timestamp,
                    timestamp,
                ),
            )
            rate_id = int(cursor.lastrowid)
            event_id = int(connection.execute(
                """
                INSERT INTO basic_service_fee_rate_events (
                    rate_id, action, enabled, changed_at
                ) VALUES (?, 'created', 1, ?)
                """,
                (rate_id, timestamp),
            ).lastrowid)
            details = {
                "rate_id": rate_id,
                "operation": "create_version",
                "major_category": major_category,
                "category_levels": list(categories),
                "rate": normalized["rate"],
                "special_channel_rate": normalized["special_channel_rate"],
                "effective_from": normalized["effective_from"],
                "enabled": True,
                "note": normalized["note"],
            }
        else:
            rate_id = int(normalized["rate_id"])
            row = connection.execute(
                "SELECT * FROM basic_service_fee_rates WHERE id = ? AND archived = 0", (rate_id,)
            ).fetchone()
            if row is None:
                raise ValueError("基础服务费率不存在")
            enabled = bool(normalized["enabled"])
            if bool(row["enabled"]) == enabled:
                raise ValueError("基础服务费率启用状态没有变化")
            connection.execute(
                "UPDATE basic_service_fee_rates SET enabled = ?, updated_at = ? WHERE id = ? AND archived = 0",
                (int(enabled), timestamp, rate_id),
            )
            event_id = int(connection.execute(
                """
                INSERT INTO basic_service_fee_rate_events (
                    rate_id, action, enabled, changed_at
                ) VALUES (?, ?, ?, ?)
                """,
                (rate_id, "enabled" if enabled else "disabled", int(enabled), timestamp),
            ).lastrowid)
            details = {
                "rate_id": rate_id,
                "operation": "set_enabled",
                "major_category": str(row["major_category"]),
                "category_levels": [
                    str(row[f"category_level_{index}"]) for index in range(1, 5)
                ],
                "rate": str(row["rate"]),
                "effective_from": str(row["effective_from"]),
                "enabled": enabled,
                "note": str(row["note"]),
            }
        update_key = f"service_fee:{timestamp}:{event_id}"
        record_system_update(
            connection,
            update_key=update_key,
            kind="service_fee",
            reference_id=str(rate_id),
            completed_at=timestamp,
            backup_path=backup,
            backup_sha256=backup_sha256,
            details=details,
        )
    return {
        "status": "applied",
        "operation": normalized["operation"],
        "rate_id": rate_id,
        "backup_file": backup.name,
        "update_id": update_key,
    }


@management_locked
def apply_basic_service_fee_batch(
    database_path: str | Path,
    versions: Sequence[Mapping[str, object]],
    *,
    changed_at: str,
) -> dict[str, object]:
    if not isinstance(versions, (list, tuple)) or not versions:
        raise ValueError("基础服务费批量配置不能为空")
    normalized_versions = [
        normalize_basic_service_fee_change(
            {"operation": "create_version", **dict(version)}
        )
        for version in versions
    ]
    keys = [
        (version["major_category"], *version["category_levels"], version["effective_from"])
        for version in normalized_versions
    ]
    if len(set(keys)) != len(keys):
        raise ValueError("批量配置中存在重复的四级类目和生效日期")

    timestamp = _normalize_timestamp(changed_at)
    database = Path(database_path).resolve()
    stamp = datetime.fromisoformat(timestamp).strftime("%Y%m%d-%H%M%S-%f")
    backup = _available_backup_path(database, stamp)
    backup_sha256 = backup_database(database, backup)
    rate_ids: list[int] = []
    event_ids: list[int] = []
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        for version, key in zip(normalized_versions, keys, strict=True):
            duplicate = connection.execute(
                """
                SELECT 1 FROM basic_service_fee_rates
                WHERE major_category = ?
                  AND category_level_1 = ? AND category_level_2 = ?
                  AND category_level_3 = ? AND category_level_4 = ?
                  AND effective_from = ?
                """,
                key,
            ).fetchone()
            if duplicate is not None:
                raise ValueError(
                    "相同经营大类、四级类目和生效日期已存在，请选择新的生效日期"
                )
        for version in normalized_versions:
            categories = version["category_levels"]
            cursor = connection.execute(
                """
                INSERT INTO basic_service_fee_rates (
                    major_category, category_level_1, category_level_2,
                    category_level_3, category_level_4, rate,
                    special_channel_rate, effective_from, note,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version["major_category"],
                    *categories,
                    version["rate"],
                    version["special_channel_rate"],
                    version["effective_from"],
                    version["note"],
                    timestamp,
                    timestamp,
                ),
            )
            rate_id = int(cursor.lastrowid)
            event_id = int(connection.execute(
                """
                INSERT INTO basic_service_fee_rate_events (
                    rate_id, action, enabled, changed_at
                ) VALUES (?, 'created', 1, ?)
                """,
                (rate_id, timestamp),
            ).lastrowid)
            rate_ids.append(rate_id)
            event_ids.append(event_id)
        update_key = (
            f"service_fee:{timestamp}:batch:{event_ids[0]}-{event_ids[-1]}"
        )
        record_system_update(
            connection,
            update_key=update_key,
            kind="service_fee",
            reference_id=f"batch:{len(rate_ids)}",
            completed_at=timestamp,
            backup_path=backup,
            backup_sha256=backup_sha256,
            details={
                "operation": "create_versions",
                "count": len(rate_ids),
                "rate_ids": rate_ids,
                "versions": [
                    {
                        "major_category": version["major_category"],
                        "category_levels": list(version["category_levels"]),
                        "rate": version["rate"],
                        "special_channel_rate": version["special_channel_rate"],
                        "effective_from": version["effective_from"],
                        "enabled": True,
                        "note": version["note"],
                    }
                    for version in normalized_versions
                ],
            },
        )
    return {
        "status": "applied",
        "operation": "create_versions",
        "count": len(rate_ids),
        "rate_ids": rate_ids,
        "backup_file": backup.name,
        "update_id": update_key,
    }


def save_basic_service_fee_rate(
    database_path: str | Path,
    *,
    major_category: str = "",
    category_levels: tuple[str, str, str, str],
    rate: object,
    special_channel_rate: object | None = None,
    effective_from: str,
    note: str = "",
    changed_at: str,
) -> int:
    categories = _normalize_categories(category_levels)
    normalized_major_category = str(major_category).strip()
    normalized_rate = _normalize_rate(rate)
    normalized_special_rate = _normalize_optional_rate(special_channel_rate)
    effective_date = _normalize_date(effective_from, field="生效日期")
    timestamp = _normalize_timestamp(changed_at)
    with connect_database(database_path) as connection:
        cursor = connection.execute(
            """
            INSERT INTO basic_service_fee_rates (
                major_category, category_level_1, category_level_2,
                category_level_3, category_level_4, rate, special_channel_rate,
                effective_from, note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                normalized_major_category,
                *categories,
                normalized_rate,
                normalized_special_rate,
                effective_date,
                str(note).strip(),
                timestamp,
                timestamp,
            ),
        )
        rate_id = int(cursor.lastrowid)
        connection.execute(
            """
            INSERT INTO basic_service_fee_rate_events (
                rate_id, action, enabled, changed_at
            ) VALUES (?, 'created', 1, ?)
            """,
            (rate_id, timestamp),
        )
        return rate_id


def match_basic_service_fee_rate(
    database_path: str | Path,
    *,
    major_category: str | None = None,
    category_levels: tuple[str, str, str, str],
    effective_on: str,
) -> BasicServiceFeeMatch:
    try:
        categories = _normalize_match_categories(category_levels)
    except ValueError:
        return BasicServiceFeeMatch(None, None, None, "商品类目未配置完整")
    normalized_major_category = (
        "" if major_category is None else str(major_category).strip()
    )
    if major_category is not None and not normalized_major_category:
        return BasicServiceFeeMatch(None, None, None, "经营大类未配置")
    target_date = _normalize_date(effective_on, field="查询日期")
    with connect_database(database_path) as connection:
        row = connection.execute(
            """
            SELECT id, major_category, rate, effective_from, enabled
            FROM basic_service_fee_rates
            WHERE archived = 0 AND major_category = ?
              AND (category_level_1 IN (?, '/') OR
                   (? <> '' AND category_level_1 = '其他一级类目'))
              AND (category_level_2 IN (?, '/') OR
                   (? <> '' AND category_level_2 = '其他二级类目'))
              AND (category_level_3 IN (?, '/') OR
                   (? <> '' AND category_level_3 = '其他三级类目'))
              AND (category_level_4 IN (?, '/') OR
                   (? <> '' AND category_level_4 = '其他四级类目'))
              AND effective_from <= ?
            ORDER BY
              (CASE WHEN category_level_1 = ? THEN 2
                    WHEN category_level_1 = '其他一级类目' THEN 1 ELSE 0 END +
               CASE WHEN category_level_2 = ? THEN 2
                    WHEN category_level_2 = '其他二级类目' THEN 1 ELSE 0 END +
               CASE WHEN category_level_3 = ? THEN 2
                    WHEN category_level_3 = '其他三级类目' THEN 1 ELSE 0 END +
               CASE WHEN category_level_4 = ? THEN 2
                    WHEN category_level_4 = '其他四级类目' THEN 1 ELSE 0 END) DESC,
              effective_from DESC, id DESC
            LIMIT 1
            """,
            (
                normalized_major_category,
                *(value for category in categories for value in (category, category)),
                target_date,
                *categories,
            ),
        ).fetchone()
    if row is None:
        return BasicServiceFeeMatch(
            None, None, None, "基础服务费率未配置", normalized_major_category
        )
    if not int(row["enabled"]):
        return BasicServiceFeeMatch(
            int(row["id"]), None, str(row["effective_from"]),
            "基础服务费率已停用", str(row["major_category"])
        )
    return BasicServiceFeeMatch(
        int(row["id"]), str(row["rate"]), str(row["effective_from"]), None,
        str(row["major_category"])
    )


def set_basic_service_fee_rate_enabled(
    database_path: str | Path,
    rate_id: int,
    *,
    enabled: bool,
    changed_at: str,
) -> None:
    if not isinstance(enabled, bool):
        raise ValueError("启用状态必须为布尔值")
    timestamp = _normalize_timestamp(changed_at)
    with connect_database(database_path) as connection:
        updated = connection.execute(
            "UPDATE basic_service_fee_rates SET enabled = ?, updated_at = ? WHERE id = ? AND archived = 0",
            (int(enabled), timestamp, rate_id),
        ).rowcount
        if updated != 1:
            raise ValueError("基础服务费率不存在")
        connection.execute(
            """
            INSERT INTO basic_service_fee_rate_events (
                rate_id, action, enabled, changed_at
            ) VALUES (?, ?, ?, ?)
            """,
            (rate_id, "enabled" if enabled else "disabled", int(enabled), timestamp),
        )


def preview_legacy_service_fee_archive(
    database_path: str | Path,
) -> dict[str, object]:
    with connect_database(database_path) as connection:
        return _legacy_service_fee_archive_snapshot(connection)


@management_locked
def archive_legacy_service_fee_rates(
    database_path: str | Path,
    *,
    changed_at: str,
) -> dict[str, object]:
    timestamp = _normalize_timestamp(changed_at)
    database = Path(database_path).resolve()
    with connect_database(database) as connection:
        preview = _legacy_service_fee_archive_snapshot(connection)
    referenced = int(preview["referenced_product_count"])
    if referenced:
        raise ValueError(f"旧费率仍被 {referenced} 个商品匹配，禁止归档")
    rate_ids = [int(value) for value in preview["rate_ids"]]
    if not rate_ids:
        return {
            "status": "unchanged",
            "operation": "archive_legacy_rates",
            "count": 0,
            "rate_ids": [],
            "backup_file": None,
            "update_id": None,
        }

    stamp = datetime.fromisoformat(timestamp).strftime("%Y%m%d-%H%M%S-%f")
    backup = _available_backup_path(database, stamp)
    backup_sha256 = backup_database(database, backup)
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = _legacy_service_fee_archive_snapshot(connection)
        current_ids = [int(value) for value in current["rate_ids"]]
        current_referenced = int(current["referenced_product_count"])
        if current_referenced:
            raise ValueError(
                f"旧费率仍被 {current_referenced} 个商品匹配，禁止归档"
            )
        if current_ids != rate_ids:
            raise ValueError("基础服务费归档范围在预览后发生变化，请重新预览")
        placeholders = ", ".join("?" for _ in rate_ids)
        updated = connection.execute(
            f"""
            UPDATE basic_service_fee_rates
            SET archived = 1, archived_at = ?, updated_at = ?
            WHERE archived = 0 AND id IN ({placeholders})
            """,
            (timestamp, timestamp, *rate_ids),
        ).rowcount
        if updated != len(rate_ids):
            raise ValueError("基础服务费归档数量发生变化，请重新预览")
        update_key = (
            f"service_fee:{timestamp}:archive:{rate_ids[0]}-{rate_ids[-1]}"
        )
        record_system_update(
            connection,
            update_key=update_key,
            kind="service_fee",
            reference_id=f"archive:{len(rate_ids)}",
            completed_at=timestamp,
            backup_path=backup,
            backup_sha256=backup_sha256,
            details={
                "operation": "archive_legacy_rates",
                "count": len(rate_ids),
                "rate_ids": rate_ids,
                "criterion": "major_category_empty",
            },
        )
    return {
        "status": "applied",
        "operation": "archive_legacy_rates",
        "count": len(rate_ids),
        "rate_ids": rate_ids,
        "backup_file": backup.name,
        "update_id": update_key,
    }


def _legacy_service_fee_archive_snapshot(connection) -> dict[str, object]:
    rows = connection.execute(
        """
        SELECT id
        FROM basic_service_fee_rates
        WHERE archived = 0 AND major_category = ''
        ORDER BY id
        """
    ).fetchall()
    referenced = connection.execute(
        """
        SELECT COUNT(DISTINCT mappings.shop_name || char(31) ||
                              mappings.douyin_product_id)
        FROM douyin_sku_mappings AS mappings
        WHERE mappings.status = 'verified'
          AND mappings.major_category = ''
          AND EXISTS (
              SELECT 1
              FROM basic_service_fee_rates AS rates
              WHERE rates.archived = 0 AND rates.enabled = 1
                AND rates.major_category = ''
                AND rates.effective_from <= ?
                AND rates.category_level_1 IN (mappings.category_level_1, '/')
                AND rates.category_level_2 IN (mappings.category_level_2, '/')
                AND rates.category_level_3 IN (mappings.category_level_3, '/')
                AND rates.category_level_4 IN (mappings.category_level_4, '/')
          )
        """,
        (date.today().isoformat(),),
    ).fetchone()[0]
    return {
        "archive_count": len(rows),
        "referenced_product_count": int(referenced),
        "rate_ids": [int(row["id"]) for row in rows],
    }


def list_basic_service_fee_rate_history(
    database_path: str | Path,
    *,
    major_category: str = "",
    category_levels: tuple[str, str, str, str],
) -> tuple[BasicServiceFeeHistoryEntry, ...]:
    categories = _normalize_categories(category_levels)
    with connect_database(database_path) as connection:
        rows = connection.execute(
            """
            SELECT events.id AS event_id, rates.id AS rate_id, events.action,
                   rates.rate, rates.effective_from, events.enabled,
                   rates.note, events.changed_at
            FROM basic_service_fee_rate_events AS events
            JOIN basic_service_fee_rates AS rates ON rates.id = events.rate_id
            WHERE rates.major_category = ?
              AND rates.category_level_1 = ? AND rates.category_level_2 = ?
              AND rates.category_level_3 = ? AND rates.category_level_4 = ?
            ORDER BY events.id
            """,
            (str(major_category).strip(), *categories),
        ).fetchall()
    return tuple(
        BasicServiceFeeHistoryEntry(
            event_id=int(row["event_id"]),
            rate_id=int(row["rate_id"]),
            action=str(row["action"]),
            rate=str(row["rate"]),
            effective_from=str(row["effective_from"]),
            enabled=bool(row["enabled"]),
            note=str(row["note"]),
            changed_at=str(row["changed_at"]),
        )
        for row in rows
    )


def _normalize_categories(values: tuple[str, str, str, str]) -> tuple[str, str, str, str]:
    if not isinstance(values, tuple) or len(values) != 4:
        raise ValueError("基础服务费匹配必须提供完整四级类目")
    categories = tuple(str(value).strip() for value in values)
    if any(not value for value in categories):
        raise ValueError("基础服务费匹配必须提供完整四级类目")
    return categories  # type: ignore[return-value]


def score_service_fee_category_rule(
    rule_categories: tuple[str, str, str, str],
    categories: tuple[str, str, str, str],
) -> int | None:
    score = 0
    for index, (rule, category) in enumerate(
        zip(rule_categories, categories, strict=True)
    ):
        if rule == category:
            score += 2
        elif category and rule == OTHER_CATEGORY_RULES[index]:
            score += 1
        elif rule != "/":
            return None
    return score


def _normalize_match_categories(
    values: tuple[str, str, str, str],
) -> tuple[str, str, str, str]:
    if not isinstance(values, tuple) or len(values) != 4:
        raise ValueError("基础服务费匹配必须提供四级类目字段")
    categories = tuple(str(value).strip() for value in values)
    missing_seen = False
    for category in categories:
        if not category:
            missing_seen = True
        elif missing_seen:
            raise ValueError("基础服务费匹配的类目层级不能存在中间缺失")
    if not categories[0]:
        raise ValueError("基础服务费匹配必须提供一级类目")
    return categories  # type: ignore[return-value]


def _normalize_rate(value: object) -> str:
    if isinstance(value, bool):
        raise ValueError("基础服务费率无效")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("基础服务费率无效") from exc
    if not number.is_finite() or number < 0 or number > 1:
        raise ValueError("基础服务费率必须在 0 到 1 之间")
    normalized = format(number, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"


def _normalize_optional_rate(value: object | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    return _normalize_rate(value)


def _backfill_mapping_major_categories(connection) -> None:
    grouped: dict[str, set[str]] = {}
    for row in connection.execute(
        """
        SELECT DISTINCT category_level_1, major_category
        FROM basic_service_fee_rates
        WHERE archived = 0
          AND category_level_1 <> '' AND category_level_1 <> '/'
          AND major_category <> '' AND major_category <> '/'
        """
    ):
        grouped.setdefault(str(row["category_level_1"]), set()).add(
            str(row["major_category"])
        )
    for table in ("douyin_sku_mappings", "mapping_review_candidates"):
        categories = connection.execute(
            f"SELECT DISTINCT category_level_1 FROM {table}"
        ).fetchall()
        for row in categories:
            category = str(row["category_level_1"])
            candidates = grouped.get(category, set())
            if len(candidates) == 1:
                major_category = next(iter(candidates))
                reason = ""
            elif len(candidates) > 1:
                major_category = ""
                reason = "经营大类无法唯一确定"
            else:
                major_category = ""
                reason = "经营大类未配置"
            connection.execute(
                f"""
                UPDATE {table}
                SET major_category = ?, major_category_unconfigured_reason = ?
                WHERE category_level_1 = ?
                  AND (major_category = '' OR major_category IS NULL)
                """,
                (major_category, reason, category),
            )


def _normalize_date(value: str, *, field: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field}必须为 YYYY-MM-DD") from exc


def _normalize_timestamp(value: str) -> str:
    try:
        return datetime.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as exc:
        raise ValueError("修改时间必须为 ISO 8601 时间") from exc


def _available_backup_path(database: Path, stamp: str) -> Path:
    base = f"{database.stem}.before-service-fee-{stamp}"
    candidate = database.with_name(f"{base}{database.suffix}.bak")
    sequence = 2
    while candidate.exists():
        candidate = database.with_name(
            f"{base}-{sequence}{database.suffix}.bak"
        )
        sequence += 1
    return candidate
