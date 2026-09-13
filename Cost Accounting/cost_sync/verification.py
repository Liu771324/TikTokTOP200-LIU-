from __future__ import annotations

from dataclasses import dataclass

from .config import AppConfig
from .database import connect_database, count_products, get_sync_state
from .excel import validate_excel


@dataclass(frozen=True)
class VerificationResult:
    total_count: int
    enabled_count: int
    last_mode: str
    last_successful_sync: str


def verify_outputs(config: AppConfig) -> VerificationResult:
    if not config.database_path.exists():
        raise FileNotFoundError(f"SQLite 文件不存在：{config.database_path}")
    if not config.excel_path.exists():
        raise FileNotFoundError(f"Excel 文件不存在：{config.excel_path}")

    with connect_database(config.database_path) as connection:
        total_count = count_products(connection)
        enabled_count = count_products(connection, enabled_only=True)
        last_mode = get_sync_state(connection, "last_mode")
        last_successful_sync = get_sync_state(connection, "last_successful_sync")
        recorded_enabled = get_sync_state(connection, "last_enabled_count")

    if last_mode not in {"full", "incremental"}:
        raise ValueError("SQLite 的 last_mode 无效")
    if not last_successful_sync:
        raise ValueError("SQLite 缺少 last_successful_sync")
    if recorded_enabled != str(enabled_count):
        raise ValueError("SQLite 同步状态中的启用商品数与当前数据不一致")
    validate_excel(config.excel_path, expected_rows=enabled_count)

    return VerificationResult(
        total_count=total_count,
        enabled_count=enabled_count,
        last_mode=last_mode,
        last_successful_sync=last_successful_sync,
    )

