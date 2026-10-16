"""Recoverable publication of the database and its companion Excel file."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path


class RecoveryRequiredError(RuntimeError):
    pass


def publication_journal(database: str | Path) -> Path:
    database = Path(database).resolve()
    return database.with_name(f".{database.name}.publication.jsonl")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_journal(path: Path) -> tuple[dict, bool]:
    try:
        if path.stat().st_size > 64 * 1024:
            raise ValueError("恢复清单过大")
        lines = path.read_bytes().splitlines(keepends=True)
        if not lines or not lines[0].endswith(b"\n"):
            raise ValueError("恢复清单未完整写入")
        record = json.loads(lines[0])
        if not isinstance(record, dict) or record.get("version") != 1:
            raise ValueError("恢复清单版本无效")
        if not isinstance(record.get("files"), list) or not 1 <= len(record["files"]) <= 2:
            raise ValueError("恢复文件数量无效")
        return record, len(lines) == 2 and lines[1] == b"committed\n"
    except (OSError, ValueError, TypeError) as exc:
        raise RecoveryRequiredError("发布恢复清单无法核实，已保留现场并停止数据操作") from exc


def require_no_pending_publication(database: str | Path) -> None:
    journal = publication_journal(database)
    if journal.exists() and not _read_journal(journal)[1]:
        raise RecoveryRequiredError("成本文件正在发布或等待恢复，请稍后重试；持续提示时重启成本助手")


def _validated_files(record: dict, allowed: set[Path]) -> list[dict]:
    files = []
    for item in record["files"]:
        if not isinstance(item, dict) or not isinstance(item.get("target"), str):
            raise RecoveryRequiredError("恢复文件记录无效")
        target = Path(item["target"]).resolve()
        if target not in allowed or any(entry["target"] == target for entry in files):
            raise RecoveryRequiredError("恢复目标不符合当前数据目录，已停止恢复")
        backup = item.get("backup")
        if backup is not None:
            if not isinstance(backup, str):
                raise RecoveryRequiredError("恢复备份路径无效")
            backup = Path(backup).resolve()
            if (backup.parent != target.parent or not backup.name.startswith(f".{target.name}.")
                    or not backup.name.endswith(".previous")):
                raise RecoveryRequiredError("恢复备份不在预期目录")
        for key in ("old_sha256", "new_sha256"):
            value = item.get(key)
            if value is None and key == "old_sha256" and backup is None:
                continue
            if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
                raise RecoveryRequiredError("恢复文件校验信息无效")
        if (backup is None) != (item.get("old_sha256") is None):
            raise RecoveryRequiredError("恢复备份与校验信息不一致")
        files.append({**item, "target": target, "backup": backup})
    return files


def _cleanup(journal: Path, files: list[dict]) -> None:
    try:
        for item in files:
            backup = item["backup"]
            if backup is not None:
                backup.unlink(missing_ok=True)
        journal.unlink(missing_ok=True)
    except OSError:
        # A durable commit or a completed restoration must not be reported as failed.
        logging.getLogger("cost-assistant").warning("发布已完成，恢复临时文件清理暂未完成")


def cleanup_staged_files(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logging.getLogger("cost-assistant").warning("暂存文件清理暂未完成：%s", path.name)


def recover_publication(database: str | Path, output_excel: str | Path, *, force_rollback: bool = False) -> bool:
    """Caller holds the database management lock; never consumes recovery backups."""
    journal = publication_journal(database)
    if not journal.exists():
        return False
    record, committed = _read_journal(journal)
    files = _validated_files(record, {Path(database).resolve(), Path(output_excel).resolve()})
    if committed and not force_rollback:
        _cleanup(journal, files)
        return True
    if force_rollback:
        # Make the rollback decision durable BEFORE restoring even one target.
        # A previous commit marker must never let startup discard recovery files
        # after a partially completed compensation.
        try:
            with journal.open("r+b") as stream:
                stream.readline()
                stream.truncate()
                stream.flush()
                os.fsync(stream.fileno())
        except OSError as exc:
            raise RecoveryRequiredError("无法持久记录恢复决定，已保留文件并停止自动补偿") from exc
    # Check every backup and target before restoring any target. Repeated recovery
    # is safe after an interruption because the originals remain available.
    for item in files:
        backup, target = item["backup"], item["target"]
        if backup is not None and (not backup.is_file() or _sha256(backup) != item["old_sha256"]):
            raise RecoveryRequiredError("发布恢复备份缺失或校验失败，已保留其他恢复材料")
        if target.exists() and _sha256(target) not in {item["old_sha256"], item["new_sha256"]}:
            raise RecoveryRequiredError("发布目标已有清单之外的变化，已停止自动恢复")
    try:
        for item in reversed(files):
            target, backup = item["target"], item["backup"]
            if backup is None:
                target.unlink(missing_ok=True)
                continue
            if target.is_file() and _sha256(target) == item["old_sha256"]:
                continue
            descriptor, name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".restore", dir=target.parent)
            os.close(descriptor)
            staged = Path(name)
            try:
                shutil.copy2(backup, staged)
                with staged.open("r+b") as stream:
                    os.fsync(stream.fileno())
                os.replace(staged, target)
            finally:
                staged.unlink(missing_ok=True)
    except OSError as exc:
        raise RecoveryRequiredError("自动恢复尚未完成，已保留清单和全部原始恢复备份；请关闭占用文件后重启") from exc
    # Restoration is now committed too: a cleanup failure may safely be retried.
    with journal.open("r+b") as stream:
        stream.readline()
        stream.truncate()
        stream.write(b"committed\n")
        stream.flush()
        os.fsync(stream.fileno())
    _cleanup(journal, files)
    return True


def publish_files(pairs: list[tuple[Path, Path]], *, database: Path) -> None:
    journal = publication_journal(database)
    require_no_pending_publication(database)
    if journal.exists():
        record, _ = _read_journal(journal)
        _cleanup(journal, _validated_files(record, {target.resolve() for _, target in pairs}))
        if journal.exists():
            raise RecoveryRequiredError("上次发布清理尚未完成，请关闭占用文件后重试")
    files = []
    prepared = False
    try:
        for source, target in pairs:
            source, target = source.resolve(), target.resolve()
            if source == target or source.parent != target.parent:
                raise ValueError("发布暂存文件必须独立且与目标位于同一目录")
            backup = None
            old_sha256 = None
            if target.exists():
                descriptor, name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".previous", dir=target.parent)
                os.close(descriptor)
                backup = Path(name)
                files.append({"target": target, "backup": backup, "old_sha256": None, "new_sha256": None})
                shutil.copy2(target, backup)
                with backup.open("r+b") as stream:
                    os.fsync(stream.fileno())
                old_sha256 = _sha256(backup)
                files[-1].update(old_sha256=old_sha256, new_sha256=_sha256(source))
            with source.open("r+b") as stream:
                os.fsync(stream.fileno())
            if backup is None:
                files.append({"target": target, "backup": None, "old_sha256": None, "new_sha256": _sha256(source)})
        record = {"version": 1, "files": [
            {key: str(value) if isinstance(value, Path) else value for key, value in item.items()}
            for item in files
        ]}
        with journal.open("xb") as stream:
            stream.write(json.dumps(record, ensure_ascii=False).encode("utf-8") + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        prepared = True
        for source, target in pairs:
            os.replace(source, target)
        with journal.open("ab") as stream:
            stream.write(b"committed\n")
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        if prepared:
            excel = next((target for _, target in pairs if target.resolve() != database.resolve()), database)
            recover_publication(database, excel, force_rollback=True)
        elif not journal.exists():
            _cleanup(journal, files)
        raise
    _cleanup(journal, files)
