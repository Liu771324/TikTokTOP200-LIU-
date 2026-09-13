from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .database import connect_database, count_products
from .excel import export_enabled_products, validate_excel
from .locks import management_locked


@dataclass(frozen=True)
class RollbackResult:
    update_key: str
    recovery_backup_path: Path
    recovery_backup_sha256: str
    rebuilt_excel: bool


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def backup_database(database_path: str | Path, backup_path: str | Path) -> str:
    database = Path(database_path).resolve()
    backup = Path(backup_path).resolve()
    if backup.exists():
        raise FileExistsError(f"备份文件已存在：{backup.name}")
    source_uri = f"{database.as_uri()}?mode=ro"
    try:
        with closing(sqlite3.connect(source_uri, uri=True)) as source:
            with closing(sqlite3.connect(backup)) as target:
                source.backup(target)
                _require_integrity(target)
    except Exception:
        backup.unlink(missing_ok=True)
        raise
    return file_sha256(backup)


def record_system_update(
    connection: sqlite3.Connection,
    *,
    update_key: str,
    kind: str,
    reference_id: str,
    completed_at: str,
    backup_path: str | Path,
    backup_sha256: str,
    details: dict[str, object],
) -> None:
    backup_name = Path(backup_path).name
    normalized_hash = backup_sha256.lower()
    if (
        kind not in {"catalog", "mapping", "shipping", "service_fee"}
        or len(normalized_hash) != 64
        or any(character not in "0123456789abcdef" for character in normalized_hash)
    ):
        raise ValueError("更新备份元数据无效")
    connection.execute(
        """
        INSERT INTO system_updates (
            update_key, kind, reference_id, status, completed_at,
            backup_file, backup_sha256, details_json
        ) VALUES (?, ?, ?, 'applied', ?, ?, ?, ?)
        """,
        (
            update_key,
            kind,
            reference_id,
            completed_at,
            backup_name,
            normalized_hash,
            json.dumps(details, ensure_ascii=False, separators=(",", ":")),
        ),
    )


@management_locked
def rollback_latest_update(
    database_path: str | Path,
    output_excel_path: str | Path,
    update_key: str,
    *,
    rolled_back_at: str,
) -> RollbackResult:
    database = Path(database_path).resolve()
    output_excel = Path(output_excel_path).resolve()
    record = _load_latest_record(database, update_key)
    backup = _resolve_backup(database, str(record["backup_file"]))
    if not backup.is_file():
        raise ValueError("更新前备份不存在，禁止回滚")
    if file_sha256(backup) != str(record["backup_sha256"]):
        raise ValueError("更新前备份 SHA-256 不匹配，禁止回滚")
    _check_database_file(backup)

    stamp = datetime.fromisoformat(rolled_back_at).strftime("%Y%m%d-%H%M%S-%f")
    recovery = database.with_name(
        f"{database.stem}.before-update-rollback-{stamp}{database.suffix}.bak"
    )
    recovery_sha256 = backup_database(database, recovery)
    staged_database = _temporary_file(database.parent, database.name, database.suffix)
    staged_excel: Path | None = None
    try:
        _copy_database(backup, staged_database)
        with connect_database(staged_database) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO system_updates (
                    update_key, kind, reference_id, status, completed_at,
                    backup_file, backup_sha256, rolled_back_at,
                    recovery_backup_file, recovery_backup_sha256, details_json
                ) VALUES (?, ?, ?, 'rolled_back', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(record["update_key"]),
                    str(record["kind"]),
                    str(record["reference_id"]),
                    str(record["completed_at"]),
                    str(record["backup_file"]),
                    str(record["backup_sha256"]),
                    rolled_back_at,
                    recovery.name,
                    recovery_sha256,
                    str(record["details_json"]),
                ),
            )
            _require_integrity(connection)
            if str(record["kind"]) == "catalog":
                staged_excel = _temporary_file(
                    output_excel.parent, output_excel.name, output_excel.suffix
                )
                enabled_count = count_products(connection, enabled_only=True)
                exported = export_enabled_products(connection, staged_excel)
                if exported != enabled_count:
                    raise ValueError("回滚后的 Excel 行数与启用商品数不一致")
                validate_excel(staged_excel, expected_rows=enabled_count)
        pairs: list[tuple[Path, Path]] = []
        if staged_excel is not None:
            pairs.append((staged_excel, output_excel))
        pairs.append((staged_database, database))
        _publish_rollback(pairs, database)
    finally:
        staged_database.unlink(missing_ok=True)
        if staged_excel is not None:
            staged_excel.unlink(missing_ok=True)

    return RollbackResult(
        update_key=update_key,
        recovery_backup_path=recovery,
        recovery_backup_sha256=recovery_sha256,
        rebuilt_excel=str(record["kind"]) == "catalog",
    )


def _load_latest_record(database: Path, update_key: str) -> sqlite3.Row:
    uri = f"{database.as_uri()}?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        has_tracking = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_updates'"
        ).fetchone()
        if has_tracking is None:
            raise ValueError("数据库没有安全回滚记录，禁止回滚")
        latest = connection.execute(
            "SELECT * FROM system_updates WHERE status = 'applied' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        requested = connection.execute(
            "SELECT * FROM system_updates WHERE update_key = ?", (update_key,)
        ).fetchone()
        global_latest_keys = _global_latest_keys(connection)
    if requested is None or str(requested["status"]) != "applied":
        raise ValueError("指定更新不是可回滚的成功记录")
    if latest is None or int(latest["id"]) != int(requested["id"]):
        raise ValueError("只允许回滚全局最新一次成功更新")
    if global_latest_keys != {update_key}:
        raise ValueError("只允许回滚全局最新一次成功更新")
    return requested


def _global_latest_keys(connection: sqlite3.Connection) -> set[str]:
    events: list[tuple[datetime, str]] = []
    for row in connection.execute(
        "SELECT update_key, completed_at FROM system_updates WHERE status = 'applied'"
    ):
        events.append(
            (_parse_history_time(str(row["completed_at"])), str(row["update_key"]))
        )
    catalog = connection.execute(
        "SELECT value FROM sync_state WHERE key = 'last_successful_sync'"
    ).fetchone()
    if catalog is not None:
        value = str(catalog[0])
        events.append((_parse_history_time(value), f"catalog:{value}"))
    for row in connection.execute(
        "SELECT id, imported_at FROM mapping_import_batches WHERE status = 'applied'"
    ):
        events.append(
            (_parse_history_time(str(row["imported_at"])), f"mapping:{int(row['id'])}")
        )
    if not events:
        return set()
    latest_time = max(item[0] for item in events)
    return {key for completed_at, key in events if completed_at == latest_time}


def _parse_history_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError
        return parsed
    except ValueError as exc:
        raise ValueError("更新历史包含无效完成时间，禁止回滚") from exc


def _resolve_backup(database: Path, backup_file: str) -> Path:
    if not backup_file or Path(backup_file).name != backup_file:
        raise ValueError("更新前备份路径无效，禁止回滚")
    backup = (database.parent / backup_file).resolve()
    if backup.parent != database.parent:
        raise ValueError("更新前备份不在数据库目录，禁止回滚")
    return backup


def _copy_database(source: Path, target: Path) -> None:
    source_uri = f"{source.as_uri()}?mode=ro"
    with closing(sqlite3.connect(source_uri, uri=True)) as source_connection:
        with closing(sqlite3.connect(target)) as target_connection:
            source_connection.backup(target_connection)


def _check_database_file(path: Path) -> None:
    uri = f"{path.as_uri()}?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as connection:
        _require_integrity(connection)


def _require_integrity(connection: sqlite3.Connection) -> None:
    result = connection.execute("PRAGMA integrity_check").fetchone()
    if result is None or str(result[0]).lower() != "ok":
        raise sqlite3.DatabaseError("SQLite integrity_check 未通过")


def _temporary_file(directory: Path, name: str, suffix: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{name}.", suffix=f".rollback{suffix}", dir=directory
    )
    os.close(descriptor)
    return Path(temporary)


def _publish_rollback(pairs: list[tuple[Path, Path]], database: Path) -> None:
    previous: dict[Path, Path] = {}
    published: list[Path] = []
    restored = False
    succeeded = False
    try:
        for _, target in pairs:
            if target.exists():
                snapshot = _temporary_file(target.parent, target.name, ".previous")
                shutil.copy2(target, snapshot)
                previous[target] = snapshot
        try:
            for source, target in pairs:
                os.replace(source, target)
                published.append(target)
            succeeded = True
        except Exception as publish_error:
            restoration_errors: list[str] = []
            for target in reversed(published):
                snapshot = previous.get(target)
                try:
                    if snapshot is None:
                        target.unlink(missing_ok=True)
                    else:
                        os.replace(snapshot, target)
                except OSError as restore_error:
                    restoration_errors.append(f"{target.name}: {restore_error}")
            if restoration_errors:
                retained = ", ".join(path.name for path in previous.values() if path.exists())
                raise RuntimeError(
                    "回滚发布失败，自动恢复也失败；已保留恢复文件 "
                    f"{retained}。详情：{'；'.join(restoration_errors)}"
                ) from publish_error
            restored = True
            raise
    finally:
        if not published or restored or succeeded:
            for snapshot in previous.values():
                try:
                    snapshot.unlink(missing_ok=True)
                except OSError:
                    # Publication has already committed when succeeded is true.
                    # A locked cleanup file must not turn that success into a
                    # reported rollback failure; the snapshot is safe to retain.
                    pass
