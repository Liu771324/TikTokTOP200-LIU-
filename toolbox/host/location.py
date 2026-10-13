"""Persistent data location and verified, restart-only migration."""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from .errors import ToolboxError
from .paths import atomic_json


def _safe_path(path):
    path = Path(path)
    if not path.is_absolute() or path == Path(path.anchor):
        raise ToolboxError('INVALID_PARAMETERS', '请选择独立的数据文件夹，不能选择磁盘根目录。')
    for entry in (path, *path.parents):
        try:
            attributes = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(attributes.st_mode) or getattr(attributes, 'st_file_attributes', 0) & 0x400:
            raise ToolboxError('INVALID_PARAMETERS', '数据目录不能包含目录链接。')
    return path.resolve()


def _inventory(root, exclude=()):
    records = []
    for file in sorted(Path(root).rglob('*')):
        attributes = file.lstat()
        if stat.S_ISLNK(attributes.st_mode) or getattr(attributes, 'st_file_attributes', 0) & 0x400:
            raise ToolboxError('INVALID_PARAMETERS', '数据目录内存在链接，不能自动迁移或清理。')
        if not file.is_file() or file.relative_to(root).as_posix() in exclude:
            continue
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        records.append({'path': file.relative_to(root).as_posix(), 'size': file.stat().st_size, 'sha256': digest})
    return records


class DataLocation:
    def __init__(self, base=None, forbidden=()):
        explicit_base = base is not None
        base = base or os.environ.get('LOCALAPPDATA')
        if not base:
            raise ToolboxError('INVALID_PARAMETERS', '无法找到当前用户的本地数据目录。')
        self.base = Path(base).resolve()
        self.legacy = self.base / 'ScriptAllToolbox'
        self.settings = (self.base / 'ScriptAllToolboxLauncher/settings.json' if explicit_base else
                         Path(os.environ.get('USERPROFILE') or Path.home()) / '.scriptall-toolbox/settings.json')
        self.old_settings = self.base / 'ScriptAllToolboxLauncher/settings.json'
        self.forbidden = tuple(Path(p).resolve() for p in forbidden)

    def read(self):
        # A user-home pointer is stable when a packaged desktop host redirects AppData.
        if not self.settings.exists() and self.old_settings != self.settings and self.old_settings.exists():
            try:
                data = json.loads(self.old_settings.read_text(encoding='utf-8'))
                if data.get('version') != 1 or not isinstance(data.get('dataRoot'), str):
                    raise ValueError()
                _safe_path(data['dataRoot'])
                atomic_json(self.settings, data)
            except (OSError, ValueError, TypeError) as exc:
                raise ToolboxError('STATE_CORRUPT', '旧数据位置配置无法读取。') from exc
        if not self.settings.exists():
            return {'version': 1, 'dataRoot': str(self.legacy)}
        try:
            data = json.loads(self.settings.read_text(encoding='utf-8'))
            if data['version'] != 1 or not isinstance(data['dataRoot'], str):
                raise ValueError()
            _safe_path(data['dataRoot'])
            if data.get('migration'):
                request = data['migration']
                if (not isinstance(request, dict) or set(request) != {'id', 'source', 'target'}
                        or not isinstance(request['id'], str) or not re.fullmatch('[a-f0-9]{32}', request['id'])):
                    raise ValueError()
                _safe_path(request['source'])
                _safe_path(request['target'])
            return data
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ToolboxError('STATE_CORRUPT', '数据位置配置无法读取，请保留原数据并修复配置。') from exc

    def current(self):
        data = self.read()
        root = _safe_path(data['dataRoot'])
        if self.settings.exists() and not root.is_dir():
            raise ToolboxError('FILE_BUSY', '数据盘或数据目录不可用，请恢复原磁盘后重新打开软件。')
        if self.settings.exists() and not (root / 'toolbox.sqlite3').is_file():
            raise ToolboxError('STATE_CORRUPT', '现有数据目录缺少数据库，软件不会创建空库，请恢复原数据库。')
        return root

    def status(self):
        data = self.read()
        root = self.current()
        probe = root
        while not probe.exists():
            probe = probe.parent
        space = shutil.disk_usage(probe)
        result = {'path': str(root), 'freeBytes': space.free, 'totalBytes': space.total,
                  'pending': bool(data.get('migration'))}
        if data.get('migration'):
            result['requestedPath'] = data['migration']['target']
        if data.get('previous'):
            result['previousPath'] = data['previous']['path']
        if data.get('migrationError'):
            result['error'] = data['migrationError']
        return result

    def _target(self, target, source):
        target = _safe_path(target)
        source = _safe_path(source)
        if target == source or target in source.parents or source in target.parents:
            raise ToolboxError('INVALID_PARAMETERS', '新旧数据目录不能相同或互相包含。')
        for forbidden in (self.base, *self.forbidden):
            if target == forbidden or forbidden in target.parents or target in forbidden.parents:
                raise ToolboxError('INVALID_PARAMETERS', '请将数据保存在程序、系统资料和源码目录之外。')
        return target

    def request(self, target):
        data = self.read()
        if data.get('previous'):
            raise ToolboxError('INVALID_PARAMETERS', '请先清理已验证的旧数据位置，再发起下一次迁移。')
        source = self.current()
        target = self._target(target, source)
        if target.exists() and (not target.is_dir() or any(target.iterdir())):
            raise ToolboxError('INVALID_PARAMETERS', '目标数据文件夹必须为空，不会覆盖已有文件。')
        probe = target
        while not probe.exists():
            probe = probe.parent
        size = sum(file.stat().st_size for file in source.rglob('*') if file.is_file())
        if shutil.disk_usage(probe).free < size + 16 * 1024 * 1024:
            raise ToolboxError('FILE_BUSY', '目标磁盘剩余空间不足，请选择其他磁盘。')
        data['migration'] = {'id': uuid4().hex, 'source': str(source), 'target': str(target)}
        data.pop('migrationError', None)
        atomic_json(self.settings, data)
        return {'restartRequired': True, 'path': str(target)}

    def migrate_pending(self):
        data = self.read()
        request = data.get('migration')
        if not request:
            return False
        source = self.current()
        if request['source'] != str(source) or not isinstance(request['id'], str) or len(request['id']) != 32:
            raise ToolboxError('STATE_CORRUPT', '迁移记录不一致，未改变原数据位置。')
        target = self._target(request['target'], source)
        marker_name = '.toolbox-migration-owner.json'
        marker = target / marker_name
        if target.exists() and any(target.iterdir()):
            try:
                if json.loads(marker.read_text(encoding='utf-8')) != request:
                    raise ValueError()
            except (OSError, ValueError) as exc:
                raise ToolboxError('INVALID_PARAMETERS', '目标目录出现其他文件，未覆盖或切换原数据。') from exc
        target.mkdir(parents=True, exist_ok=True)
        atomic_json(marker, request)
        records = _inventory(source)
        allowed = {item['path'] for item in records}
        existing = _inventory(target, (marker_name,))
        if any(item['path'] not in allowed for item in existing):
            raise ToolboxError('INVALID_PARAMETERS', '迁移目标出现外来文件，请保留并检查目标目录。')
        size = sum(item['size'] for item in records)
        if shutil.disk_usage(target).free < size + 16 * 1024 * 1024:
            raise ToolboxError('FILE_BUSY', '目标磁盘剩余空间不足，仍使用原数据位置。')
        existing = {item['path']: item for item in existing}
        for item in records:
            if existing.get(item['path']) == item:
                continue
            destination = target / item['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / item['path'], destination)
        if _inventory(target, (marker_name,)) != records or _inventory(source) != records:
            raise ToolboxError('FILE_BUSY', '数据校验不一致，未切换或删除原数据，请重试。')
        receipt_name = '.toolbox-migration-receipt-' + request['id'] + '.json'
        atomic_json(target / receipt_name, {'source': str(source), 'target': str(target), 'files': records})
        # Pointer publication is last: a failed copy always leaves the old root active.
        atomic_json(self.settings, {'version': 1, 'dataRoot': str(target),
                                   'previous': {'path': str(source), 'receipt': receipt_name}})
        try:
            marker.unlink(missing_ok=True)
        except OSError:
            pass  # The verified data pointer is already committed; this marker is inactive.
        return True

    def record_failure(self):
        data = self.read()
        data['migrationError'] = '迁移未完成，仍使用原数据。请检查目标空间和文件占用，再退出重开重试。'
        atomic_json(self.settings, data)

    def clean_previous(self):
        data = self.read()
        previous = data.get('previous')
        if not previous:
            return {'removed': False, 'releasedBytes': 0}
        root = self.current()
        source = _safe_path(previous['path'])
        if source == root or source in root.parents or root in source.parents:
            raise ToolboxError('STATE_CORRUPT', '旧数据目录与当前目录重叠，不能清理。')
        receipt_name = previous['receipt']
        if not isinstance(receipt_name, str) or not receipt_name.startswith('.toolbox-migration-receipt-') or Path(receipt_name).name != receipt_name:
            raise ToolboxError('STATE_CORRUPT', '旧位置校验记录无效，不能清理。')
        receipt = json.loads((root / receipt_name).read_text(encoding='utf-8'))
        if receipt['source'] != str(source) or receipt['target'] != str(root):
            raise ToolboxError('STATE_CORRUPT', '旧位置身份不一致，不能清理。')
        expected = {item['path']: item for item in receipt['files']}
        actual = _inventory(source) if source.exists() else []
        if any(expected.get(item['path']) != item for item in actual) or (not previous.get('cleaning') and len(actual) != len(expected)):
            raise ToolboxError('FILE_BUSY', '旧位置文件已有变化，未删除；请保留并人工核对。')
        # Remember pre-existing unavailable assets, so unrelated historical failures
        # do not mask a migration loss or prevent reclaiming a verified duplicate.
        if 'unavailableArtifacts' not in receipt:
            with closing(sqlite3.connect((source / 'toolbox.sqlite3').as_uri() + '?mode=ro', uri=True)) as db:
                receipt['unavailableArtifacts'] = [row[0] for row in db.execute(
                    "SELECT id FROM artifacts WHERE status='missing'")]
            atomic_json(root / receipt_name, receipt)
        try:
            with closing(sqlite3.connect((root / 'toolbox.sqlite3').as_uri() + '?mode=ro', uri=True)) as db:
                if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchone():
                    raise ValueError()
                rows = db.execute('''SELECT DISTINCT a.id,a.relpath,a.size,a.sha256,a.status
                    FROM artifacts a JOIN task_artifacts r ON r.artifact_id=a.id''').fetchall()
                from .paths import DataPaths
                for artifact_id, relative, size, digest, status in rows:
                    if status == 'missing' and artifact_id in receipt['unavailableArtifacts']:
                        continue
                    file = DataPaths(root).resolve(relative)
                    if status != 'ready' or not file.is_file() or file.stat().st_size != size:
                        raise ValueError()
                    with file.open('rb') as stream:
                        if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                            raise ValueError()
        except (OSError, sqlite3.Error, ValueError) as exc:
            raise ToolboxError('FILE_BUSY', '新位置数据库或结果尚未通过校验，保留旧副本，请先恢复或检查结果。') from exc
        released = sum(item['size'] for item in actual)
        previous['cleaning'] = True
        atomic_json(self.settings, data)
        if source.exists():
            shutil.rmtree(source)
        data.pop('previous')
        atomic_json(self.settings, data)
        (root / receipt_name).unlink(missing_ok=True)
        return {'removed': True, 'releasedBytes': released}
