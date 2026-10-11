from __future__ import annotations

import sqlite3
import json
from contextlib import closing
from datetime import datetime
from pathlib import Path


def read_update_history(database_path: str | Path) -> list[dict[str, object]]:
    """Read catalog and mapping updates without changing the database."""

    database = Path(database_path).resolve()
    uri = f"{database.as_uri()}?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        state = {
            str(row["key"]): str(row["value"])
            for row in connection.execute("SELECT key, value FROM sync_state")
        }
        history = _catalog_history(state)
        history.extend(_mapping_history(connection))
        journal = _journal_history(connection)
        applied_journal = [entry for entry in journal if entry["status"] == "applied"]
        rollbackable_update_ids = (
            {str(applied_journal[-1]["update_id"])} if applied_journal else set()
        )

    by_update_id = {str(entry["update_id"]): entry for entry in history}
    by_update_id.update(
        {str(entry["update_id"]): entry for entry in journal}
    )
    history = list(by_update_id.values())

    history.sort(
        key=lambda entry: datetime.fromisoformat(str(entry["completed_at"])),
        reverse=True,
    )
    applied_history = [entry for entry in history if entry["status"] == "applied"]
    latest_update_ids: set[str] = set()
    if applied_history:
        latest_time = datetime.fromisoformat(str(applied_history[0]["completed_at"]))
        latest_update_ids = {
            str(entry["update_id"])
            for entry in applied_history
            if datetime.fromisoformat(str(entry["completed_at"])) == latest_time
        }
    latest_found = False
    for entry in history:
        is_latest = not latest_found and entry["status"] == "applied"
        entry["is_latest"] = is_latest
        entry["can_rollback"] = (
            is_latest
            and latest_update_ids == {str(entry["update_id"])}
            and str(entry["update_id"]) in rollbackable_update_ids
        )
        latest_found = latest_found or is_latest
    return history


def _catalog_history(state: dict[str, str]) -> list[dict[str, object]]:
    completed_at = state.get("last_successful_sync")
    if not completed_at:
        return []
    return [
        {
            "update_id": f"catalog:{completed_at}",
            "kind": "catalog",
            "title": "商品成本更新",
            "status": "applied",
            "completed_at": completed_at,
            "mode": state.get("last_mode"),
            "enabled_count": _optional_int(state.get("last_enabled_count")),
            "ordinary_count": _optional_int(state.get("last_ordinary_count")),
            "combination_count": _optional_int(state.get("last_combination_count")),
        }
    ]


def _mapping_history(connection: sqlite3.Connection) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT id, source_file, total_rows, verified_rows, pending_rows,
               inserted_rows, existing_rows, updated_rows, removed_rows,
               legacy_rows, shop_name, import_mode, status, imported_at,
               rolled_back_at
        FROM mapping_import_batches
        """
    )
    return [
        {
            "update_id": f"mapping:{int(row['id'])}",
            "kind": "mapping",
            "title": "店铺映射更新",
            "status": str(row["status"]),
            "completed_at": str(row["imported_at"]),
            "rolled_back_at": row["rolled_back_at"],
            "batch_id": int(row["id"]),
            "shop_name": str(row["shop_name"]),
            "source_file": str(row["source_file"]),
            "mode": str(row["import_mode"]),
            "total_rows": int(row["total_rows"]),
            "verified_rows": int(row["verified_rows"]),
            "pending_rows": int(row["pending_rows"]),
            "inserted_rows": int(row["inserted_rows"]),
            "existing_rows": int(row["existing_rows"]),
            "updated_rows": int(row["updated_rows"]),
            "removed_rows": int(row["removed_rows"]),
            "legacy_rows": int(row["legacy_rows"]),
        }
        for row in rows
    ]


def _journal_history(connection: sqlite3.Connection) -> list[dict[str, object]]:
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_updates'"
    ).fetchone()
    if exists is None:
        return []
    columns = {
        str(row[1]) for row in connection.execute("PRAGMA table_info(system_updates)")
    }
    rolled_back_column = "rolled_back_at" if "rolled_back_at" in columns else "NULL"
    details_column = "details_json" if "details_json" in columns else "'{}'"
    rows = connection.execute(
        f"""
        SELECT update_key, kind, status, completed_at,
               {rolled_back_column} AS rolled_back_at,
               backup_file, backup_sha256, {details_column} AS details_json
        FROM system_updates
        ORDER BY id
        """
    )
    history: list[dict[str, object]] = []
    for row in rows:
        try:
            details = json.loads(str(row["details_json"]))
        except (TypeError, ValueError):
            details = {}
        if not isinstance(details, dict):
            details = {}
        kind = str(row["kind"])
        title = {
            "catalog": "商品成本更新",
            "mapping": "店铺映射更新",
            "shipping": "运费模板更新",
            "service_fee": "基础服务费更新",
        }.get(kind, "配置更新")
        if kind == "shipping" and details.get("mode") == "bind_products":
            title = "商品运费模板绑定"
        elif kind == "service_fee" and details.get("operation") == "import_official_catalog":
            title = "官方基础服务费目录导入"
        elif kind == "service_fee" and details.get("operation") == "archive_legacy_rates":
            title = "旧基础服务费归档"
        entry: dict[str, object] = {
            "update_id": str(row["update_key"]),
            "kind": kind,
            "title": title,
            "status": str(row["status"]),
            "completed_at": str(row["completed_at"]),
            "rolled_back_at": row["rolled_back_at"],
            "backup_file": str(row["backup_file"]),
            "backup_sha256": str(row["backup_sha256"]),
        }
        if kind == "catalog":
            allowed_details = {
                "mode", "enabled_count", "ordinary_count", "combination_count",
                "total_count", "fetched_count",
            }
        elif kind == "shipping":
            allowed_details = {
                "template_id", "name", "shop_name", "mode", "is_default",
                "region_rule_count", "product_count",
            }
        elif kind == "service_fee":
            allowed_details = {
                "rate_id", "operation", "category_levels", "rate",
                "effective_from", "enabled", "note", "count",
                "source_article_id", "source_updated_at", "source_checksum",
                "catalog_import_id",
            }
        else:
            allowed_details = {
                "batch_id", "shop_name", "source_file", "mode", "total_rows",
                "verified_rows", "pending_rows", "inserted_rows", "existing_rows",
                "updated_rows", "removed_rows", "legacy_rows",
            }
        entry.update(
            {key: value for key, value in details.items() if key in allowed_details}
        )
        history.append(entry)
    return history


def _optional_int(value: str | None) -> int | None:
    return None if value is None else int(value)
