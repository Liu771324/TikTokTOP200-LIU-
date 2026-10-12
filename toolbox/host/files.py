import ctypes
import os
import shutil
import threading
from ctypes import wintypes
from pathlib import Path

from .errors import ToolboxError
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

    def export(self, artifact_ids):
        import webview
        if type(artifact_ids) is not list or not artifact_ids or len(artifact_ids) > 200:
            raise ToolboxError('INVALID_PARAMETERS', '请选择一到二百个结果。')
        with self._lock:
            sources = [(item, self.store.artifact_path(item)) for item in dict.fromkeys(artifact_ids)]
            if len(sources) == 1:
                source = sources[0][1]
                selected = self.window.create_file_dialog(webview.FileDialog.SAVE, save_filename='工具箱结果' + source.suffix)
            else:
                selected = self.window.create_file_dialog(webview.FileDialog.FOLDER)
            if not selected:
                return {'exported': 0, 'skipped': len(sources), 'failed': 0}
            exported, failed = 0, 0
            for index, (artifact_id, source) in enumerate(sources, 1):
                target = Path(selected[0]) if len(sources) == 1 else Path(selected[0]) / f'结果_{index}_{artifact_id[:8]}{source.suffix}'
                try:
                    # Batch exports never replace a pre-existing external file.
                    mode = 'wb' if len(sources) == 1 else 'xb'
                    with source.open('rb') as incoming, target.open(mode) as outgoing:
                        shutil.copyfileobj(incoming, outgoing)
                    exported += 1
                except OSError:
                    failed += 1
            return {'exported': exported, 'skipped': 0, 'failed': failed}

    def capture_export(self, items):
        import webview
        from openpyxl import Workbook
        with self._lock:
            selected = self.window.create_file_dialog(webview.FileDialog.SAVE, save_filename='视频待选列表.xlsx', file_types=('Excel 文件 (*.xlsx)',))
            if not selected:
                return {'exported': 0}
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
            workbook.save(selected[0])
            return {'exported': len(items)}

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
