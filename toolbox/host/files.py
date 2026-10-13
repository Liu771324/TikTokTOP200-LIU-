import ctypes
import errno
import hashlib
import json
import os
import shutil
import tempfile
import threading
from ctypes import wintypes
from datetime import datetime
from pathlib import Path

from .errors import ToolboxError
from .paths import display_filename
from .state import ACTIVE


def clipboard(text):
    user, kernel = ctypes.WinDLL('user32'), ctypes.WinDLL('kernel32')
    user.OpenClipboard.argtypes = [wintypes.HWND]
    user.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user.SetClipboardData.restype = wintypes.HANDLE
    kernel.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel.GlobalAlloc.restype = wintypes.HANDLE
    kernel.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel.GlobalLock.restype = ctypes.c_void_p
    kernel.GlobalUnlock.argtypes = [wintypes.HANDLE]
    kernel.GlobalFree.argtypes = [wintypes.HANDLE]
    data = (text + '\0').encode('utf-16-le')
    handle = kernel.GlobalAlloc(0x42, len(data))
    if not handle:
        raise ToolboxError('FILE_BUSY', '无法分配剪贴板，请稍后重试。')
    try:
        pointer = kernel.GlobalLock(handle)
        if not pointer:
            raise ToolboxError('FILE_BUSY', '无法打开剪贴板，请稍后重试。')
        ctypes.memmove(pointer, data, len(data))
        kernel.GlobalUnlock(handle)
        if not user.OpenClipboard(None):
            raise ToolboxError('FILE_BUSY', '剪贴板正在使用，请稍后重试。')
        try:
            user.EmptyClipboard()
            if not user.SetClipboardData(13, handle):
                raise ToolboxError('FILE_BUSY', '复制失败，请稍后重试。')
            handle = None  # The system owns successful clipboard data.
        finally:
            user.CloseClipboard()
    finally:
        if handle:
            kernel.GlobalFree(handle)


class Files:
    def __init__(self, store):
        self.store = store
        self.window = None
        self._lock = threading.Lock()

    def open(self, artifact_id):
        os.startfile(self.store.artifact_path(artifact_id))
        return {'opened': True}

    def _external(self, target):
        target = Path(target)
        if not target.is_absolute():
            raise ToolboxError('INVALID_PARAMETERS', '请选择外部导出位置。')
        def canonical(path):
            raw = str(path.resolve())
            if raw.startswith('\\\\?\\UNC\\'):
                raw = '\\\\' + raw[8:]
            elif raw.startswith('\\\\?\\'):
                raw = raw[4:]
            elif raw.startswith('\\\\.\\'):
                raise ToolboxError('INVALID_PARAMETERS', '请选择普通文件或文件夹作为导出位置。')
            return Path(raw)
        resolved, internal = canonical(target), canonical(self.store.paths.root)
        if resolved == internal or internal in resolved.parents:
            raise ToolboxError('INVALID_PARAMETERS', '导出位置不能位于工具箱内部数据目录。')
        return target

    @staticmethod
    def _name(parent, name, suffix='', maximum=80):
        # Leave room below the traditional Windows path limit, including collision suffixes.
        available = min(maximum, 235 - len(str(parent)) - len(suffix))
        if available < 8:
            raise OSError(errno.ENAMETOOLONG, '导出目录过长，请选择较短的位置。')
        return display_filename(name)[:available].rstrip(' .') + suffix

    def _publish(self, outputs, *, replace=False):
        """Stage complete files beside the destination, then publish without partial targets."""
        staged, published = [], []
        try:
            for target, writer in outputs:
                self._external(target)
                with tempfile.NamedTemporaryFile(mode='wb', dir=target.parent, prefix='.toolbox-export-', suffix='.tmp', delete=False) as stream:
                    temporary = Path(stream.name)
                    staged.append((temporary, target))
                    writer(stream)
                    stream.flush()
                    os.fsync(stream.fileno())
            number = 1
            while True:
                targets = [(temporary, target if number == 1 else target.with_name(f'{target.stem} ({number}){target.suffix}'))
                           for temporary, target in staged]
                if not replace and any(target.exists() or target.is_symlink() for _, target in targets):
                    number += 1
                    continue
                try:
                    for temporary, target in targets:
                        self._external(target)
                        info = temporary.stat()
                        identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
                        if replace:
                            os.replace(temporary, target)
                        elif os.name == 'nt':
                            os.rename(temporary, target)  # Windows rename refuses an existing destination.
                        else:
                            os.link(temporary, target)  # POSIX rename would overwrite a competing exporter.
                        published.append((temporary, target, identity))
                    return
                except OSError as error:
                    for temporary, target, identity in reversed(published):
                        try:
                            info = target.stat()
                        except FileNotFoundError:
                            continue
                        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) == identity:
                            if temporary.exists():
                                target.unlink()
                            else:
                                os.rename(target, temporary)
                    published.clear()
                    if not replace and isinstance(error, FileExistsError):
                        number += 1
                        continue
                    raise
        finally:
            for temporary, _ in staged:
                temporary.unlink(missing_ok=True)

    @staticmethod
    def _error(error, artifact_id=None):
        if isinstance(error, ToolboxError):
            code, message = error.code, str(error)
        elif error.errno == errno.ENOSPC or getattr(error, 'winerror', None) == 112:
            code, message = 'DISK_FULL', '导出空间不足，请选择其他位置或清理空间。'
        elif isinstance(error, PermissionError) or error.errno in {errno.EACCES, errno.EBUSY}:
            code, message = 'FILE_IN_USE', '导出文件或目录被占用，请关闭占用程序后重试。'
        elif error.errno == errno.ENAMETOOLONG:
            code, message = 'INVALID_PARAMETERS', '导出目录过长，请选择较短的位置。'
        else:
            code, message = 'FILE_WRITE_FAILED', '无法导出该结果，请检查文件和导出位置。'
        result = {'artifactId': artifact_id, 'code': code, 'message': message}
        if isinstance(error, OSError):
            result['details'] = {'errno': error.errno, 'winerror': getattr(error, 'winerror', None)}
        return result

    def _references(self, artifact_ids, task_id):
        if task_id is not None:
            task = self.store.task(task_id)
            references, offset = [], 0
            while True:
                result = self.store.artifacts(task_id, offset=offset, limit=200)
                references.extend({**item, 'task': task} for item in result['items'] if item['id'] in artifact_ids)
                if len(references) > 200:
                    raise ToolboxError('INVALID_PARAMETERS', '所选结果包含超过二百个任务引用，请分批导出。')
                offset += len(result['items'])
                if offset >= result['total'] or not result['items']:
                    break
            return references
        references = []
        for artifact_id in artifact_ids:
            with self.store._lock:
                artifact = self.store._db.execute('SELECT kind FROM artifacts WHERE id=?', (artifact_id,)).fetchone()
                rows = self.store._db.execute('SELECT task_id,display_name,metadata_json FROM task_artifacts WHERE artifact_id=?', (artifact_id,)).fetchall()
            if artifact:
                row = rows[0] if len(rows) == 1 else None
                references.append({'id': artifact_id, 'kind': artifact['kind'],
                    'displayName': row['display_name'] if row else '工具箱结果',
                    'metadata': json.loads(row['metadata_json']) if row else {},
                    'task': self.store.task(row['task_id']) if row else None})
        return references

    def _video_directory(self, folder, reference):
        task, metadata = reference.get('task'), reference['metadata']
        names = {'video-ranking': '自动短视频', 'manual-video': '人工视频', 'top200': '商品TOP200', 'business-center': '商机中心'}
        label = '视频结果'
        task_suffix = ''
        if task:
            try:
                stamp = datetime.fromisoformat(task['createdAt'].replace('Z', '+00:00')).astimezone().strftime('%Y%m%d-%H%M%S')
            except (ValueError, KeyError):
                stamp = '任务'
            label = f"{names.get(task['toolId'], '工具箱')}-{stamp}"
            task_suffix = '-' + task['id'][:8]
        maximum = min(45, max(20, (235 - len(str(folder)) - 16) // 3))
        parent = folder / self._name(folder, label, task_suffix, maximum=maximum - len(task_suffix))
        product = metadata.get('productName') or '未分组商品'
        product_suffix = ''
        if metadata.get('rank') is not None:
            product = f"{metadata['rank']}_{product}"
        if (metadata.get('productKey') and metadata.get('rank') is None) or display_filename(product) != product or len(product) > maximum:
            product_suffix = '_' + hashlib.sha256(str(metadata.get('productKey') or product).encode('utf-8')).hexdigest()[:6]
        target = parent / self._name(parent, product, product_suffix, maximum=maximum - len(product_suffix))
        self._external(target)
        target.mkdir(parents=True, exist_ok=True)
        return target

    def export(self, artifact_ids, task_id=None):
        import webview
        if (type(artifact_ids) is not list or not artifact_ids or len(artifact_ids) > 200
                or any(not isinstance(item, str) or not item for item in artifact_ids)
                or (task_id is not None and not isinstance(task_id, str))):
            raise ToolboxError('INVALID_PARAMETERS', '请选择一到二百个结果。')
        with self._lock:
            selected_ids = list(dict.fromkeys(artifact_ids))
            references = self._references(selected_ids, task_id)
            missing = set(selected_ids) - {item['id'] for item in references}
            errors = [{'artifactId': item, 'code': 'ARTIFACT_MISSING', 'message': '所选任务结果不可用。'} for item in selected_ids if item in missing]
            sources = []
            for reference in references:
                try:
                    sources.append((reference, self.store.artifact_path(reference['id'])))
                except (OSError, ToolboxError) as error:
                    errors.append(self._error(error, reference['id']))
            if not sources:
                return {'exported': 0, 'skipped': 0, 'failed': len(errors), 'errors': errors}
            single = len(references) == 1 and not missing and sources[0][0]['kind'] != 'video'
            if single:
                reference, source = sources[0]
                label = reference['displayName']
                if label.lower().endswith(source.suffix.lower()):
                    label = label[:-len(source.suffix)]
                selected = self.window.create_file_dialog(webview.FileDialog.SAVE, save_filename=display_filename(label, source.suffix))
            else:
                selected = self.window.create_file_dialog(webview.FileDialog.FOLDER)
            if not selected:
                return {'exported': 0, 'skipped': len(sources), 'failed': len(errors), 'cancelled': True, 'errors': errors}
            exported = 0
            for reference, _ in sources:
                try:
                    with self.store._files_lock:
                        source = self.store.artifact_path(reference['id'])
                        folder = self._external(Path(selected[0]))
                        if not single and reference['kind'] == 'video':
                            folder = self._video_directory(folder, reference)
                        label = reference['displayName'] or reference['metadata'].get('title') or '工具箱结果'
                        if label.lower().endswith(source.suffix.lower()):
                            label = label[:-len(source.suffix)]
                        target = folder if single else folder / self._name(folder, label, source.suffix)
                        def copy_to(stream):
                            with source.open('rb') as incoming:
                                shutil.copyfileobj(incoming, stream)
                        outputs = [(target, copy_to)]
                        if reference['kind'] == 'video':
                            caption = reference['metadata'].get('caption') or '未获取到文案。'
                            outputs.append((target.with_suffix('.txt'), lambda stream: stream.write(str(caption).encode('utf-8'))))
                        self._publish(outputs, replace=single)
                    exported += 1
                except (OSError, ToolboxError) as error:
                    errors.append(self._error(error, reference['id']))
            return {'exported': exported, 'skipped': 0, 'failed': len(errors), 'errors': errors}

    def capture_export(self, items):
        import webview
        from openpyxl import Workbook
        if type(items) is not list or not 1 <= len(items) <= 200 or any(not isinstance(item, dict) for item in items):
            raise ToolboxError('INVALID_PARAMETERS', '请选择一到二百个待选条目。')
        with self._lock:
            selected = self.window.create_file_dialog(webview.FileDialog.SAVE, save_filename='视频待选列表.xlsx', file_types=('Excel 文件 (*.xlsx)',))
            if not selected:
                return {'exported': 0, 'skipped': len(items), 'failed': 0, 'cancelled': True}
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = '视频列表'
            sheet.append(['标题', '公开链接', '链接类型', '来源', '读取时间'])
            for item in items:
                sheet.append([item['title'], item['publicUrl'] or '需重新读取临时链接', item['linkKind'], item['sourcePage'], item['capturedAt']])
                for cell in sheet[sheet.max_row]:
                    cell.data_type = 's'
            for column, width in {'A': 48, 'B': 60, 'C': 22, 'D': 24, 'E': 28}.items():
                sheet.column_dimensions[column].width = width
            try:
                self._publish([(Path(selected[0]), workbook.save)], replace=True)
                return {'exported': len(items), 'skipped': 0, 'failed': 0}
            except (OSError, ToolboxError) as error:
                return {'exported': 0, 'skipped': 0, 'failed': len(items), 'errors': [self._error(error)]}

    def clean_cache(self, operations_active=False):
        released = 0
        with self.store._files_lock:
            active = set()
            with self.store._lock:
                active = {r[0] for r in self.store._db.execute('SELECT id FROM tasks WHERE state IN (%s)' % ','.join('?' * len(ACTIVE)), tuple(ACTIVE))}
            for directory in self.store.paths.resolve('scratch').iterdir():
                if directory.name in active or (directory.name.startswith('operation-') and operations_active):
                    continue
                self.store.paths.relative(directory)
                if not directory.is_dir():
                    continue
                children = list(directory.rglob('*'))
                for child in children:
                    self.store.paths.relative(child)
                size = sum(p.stat().st_size for p in children if p.is_file())
                try:
                    shutil.rmtree(directory)
                    released += size
                except OSError:
                    continue
        return {'releasedBytes': released}
