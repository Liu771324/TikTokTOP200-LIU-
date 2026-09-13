from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

from .api import JushuitanClient
from .config import AppConfig
from .database import (
    connect_database,
    copy_mapping_state,
    count_products,
    get_sync_state,
    set_sync_state,
    upsert_products,
)
from .excel import export_enabled_products, validate_excel
from .locks import create_management_lock
from .update_rollback import backup_database, record_system_update
from .windows import iter_time_windows


SHANGHAI = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True)
class SyncResult:
    mode: str
    fetched_count: int
    total_count: int
    enabled_count: int
    completed_at: str


class SyncService:
    def __init__(
        self,
        config: AppConfig,
        client: JushuitanClient,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.config = config
        self.client = client
        self._now = now or (lambda: datetime.now(SHANGHAI).replace(microsecond=0))

    def run_full(self) -> SyncResult:
        start = datetime.combine(self.config.sync_start_date, time.min, SHANGHAI)
        return self._run(mode="full", date_field="created", start=start)

    def run_incremental(self) -> SyncResult:
        if not self.config.database_path.exists():
            raise FileNotFoundError("尚无正式 SQLite 文件，请先执行 full 全量同步")
        with connect_database(self.config.database_path) as connection:
            last_successful = get_sync_state(connection, "last_successful_sync")
        if not last_successful:
            raise ValueError("SQLite 缺少 last_successful_sync，请重新执行 full 全量同步")
        start = datetime.fromisoformat(last_successful) - timedelta(minutes=5)
        if start.tzinfo is None:
            start = start.replace(tzinfo=SHANGHAI)
        return self._run(mode="incremental", date_field="modified", start=start)

    def _run(self, *, mode: str, date_field: str, start: datetime) -> SyncResult:
        with create_management_lock(self.config.database_path):
            return self._run_locked(mode=mode, date_field=date_field, start=start)

    def _run_locked(self, *, mode: str, date_field: str, start: datetime) -> SyncResult:
        completed_at = self._now()
        if start > completed_at:
            raise ValueError("同步起始时间晚于当前时间，请检查系统时间和同步状态")

        output_dir = self.config.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        previous_total = 0
        if mode == "full" and self.config.database_path.exists():
            with connect_database(self.config.database_path) as previous_connection:
                previous_total = count_products(previous_connection)
        staged_files: list[Path] = []
        try:
            staged_database = _create_temporary_file(
                output_dir,
                prefix=f".{self.config.database_path.name}.",
                suffix=f".staged{self.config.database_path.suffix}",
            )
            staged_files.append(staged_database)
            staged_excel = _create_temporary_file(
                output_dir,
                prefix=f".{self.config.excel_path.name}.",
                suffix=f".staged{self.config.excel_path.suffix}",
            )
            staged_files.append(staged_excel)
            if mode == "incremental":
                shutil.copy2(self.config.database_path, staged_database)

            fetched_skus: set[str] = set()
            with connect_database(staged_database) as connection:
                if mode == "full" and self.config.database_path.exists():
                    copy_mapping_state(self.config.database_path, connection)
                for begin, end in iter_time_windows(
                    start, completed_at, window_days=self.config.window_days
                ):
                    for products in self.client.iter_product_pages(
                        date_field=date_field,
                        begin=begin,
                        end=end,
                        page_size=100,
                    ):
                        upsert_products(
                            connection,
                            products,
                            synced_at=completed_at.isoformat(),
                        )
                        fetched_skus.update(product.sku_id for product in products)

                total_count = count_products(connection)
                enabled_count = count_products(connection, enabled_only=True)
                if mode == "full" and previous_total > 0 and total_count == 0:
                    raise ValueError(
                        "全量同步返回 0 条商品，已拒绝覆盖现有非空正式数据"
                    )
                fetched_count = total_count if mode == "full" else len(fetched_skus)
                set_sync_state(
                    connection,
                    {
                        "last_successful_sync": completed_at.isoformat(),
                        "last_mode": mode,
                        "last_fetched_count": str(fetched_count),
                        "last_enabled_count": str(enabled_count),
                    },
                )
                connection.commit()
                exported_count = export_enabled_products(connection, staged_excel)

            if exported_count != enabled_count:
                raise ValueError("Excel 导出行数与 SQLite 启用商品数不一致")
            validate_excel(staged_excel, expected_rows=enabled_count)
            if self.config.database_path.exists():
                stamp = datetime.now(SHANGHAI).strftime("%Y%m%d-%H%M%S-%f")
                backup_path = self.config.database_path.with_name(
                    f"{self.config.database_path.stem}.before-{mode}-sync-{stamp}"
                    f"{self.config.database_path.suffix}.bak"
                )
                backup_sha256 = backup_database(
                    self.config.database_path, backup_path
                )
                with connect_database(staged_database) as connection:
                    record_system_update(
                        connection,
                        update_key=f"catalog:{completed_at.isoformat()}",
                        kind="catalog",
                        reference_id=completed_at.isoformat(),
                        completed_at=completed_at.isoformat(),
                        backup_path=backup_path,
                        backup_sha256=backup_sha256,
                        details={
                            "mode": mode,
                            "enabled_count": enabled_count,
                            "total_count": total_count,
                            "fetched_count": fetched_count,
                        },
                    )
            _publish_pair(
                (staged_database, self.config.database_path),
                (staged_excel, self.config.excel_path),
            )
        finally:
            for staged_file in staged_files:
                staged_file.unlink(missing_ok=True)

        return SyncResult(
            mode=mode,
            fetched_count=fetched_count,
            total_count=total_count,
            enabled_count=enabled_count,
            completed_at=completed_at.isoformat(),
        )


def _create_temporary_file(
    directory: Path, *, prefix: str, suffix: str
) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=directory)
    os.close(descriptor)
    return Path(name)


def _publish_pair(*pairs: tuple[Path, Path]) -> None:
    backups: dict[Path, Path] = {}
    published: list[Path] = []
    try:
        for _, target in pairs:
            if target.exists():
                backup = _create_temporary_file(
                    target.parent,
                    prefix=f".{target.name}.",
                    suffix=".previous",
                )
                backups[target] = backup
                shutil.copy2(target, backup)

        try:
            for source, target in pairs:
                os.replace(source, target)
                published.append(target)
        except Exception:
            for target in reversed(published):
                backup = backups.get(target)
                if backup is not None:
                    os.replace(backup, target)
                elif target.exists():
                    target.unlink()
            raise
    finally:
        for backup in backups.values():
            backup.unlink(missing_ok=True)
