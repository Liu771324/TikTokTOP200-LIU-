import importlib.util
import json
import shutil
import sys
import os
from pathlib import Path

from .browser import BrowserManager
from .capture import Capture
from .events import Events
from .files import Files
from .logs import Logs
from .media import VideoValidator
from .manual import ManualDownloads
from .processes import start_process
from .operations import Operations
from .scheduler import TaskScheduler
from .store import Store
from .location import DataLocation
from .errors import ToolboxError
from .state import ACTIVE


ROOT = Path(__file__).resolve().parents[2]


def load_core():
    if 'douyin_downloader_core' in sys.modules:
        return sys.modules['douyin_downloader_core']
    if getattr(sys, 'frozen', False):
        return importlib.import_module('douyin_downloader_core')
    spec = importlib.util.spec_from_file_location('douyin_downloader_core', ROOT / '抖音视频下载器（免 Python 版）/douyin_downloader_core.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Application:
    def __init__(self, paths, *, test_adapter=False, acceptance=False):
        self.window = None
        self.events = Events()
        self.store = Store(paths)
        self.logs = Logs(paths)
        self.browser = BrowserManager(paths, self.events)
        self.files = Files(self.store)
        self.location = DataLocation(forbidden=(ROOT, Path(sys.executable).parent))
        self.capture = Capture(self.store, self.events, load_core())
        self.descriptors = {d['toolId']: d for d in json.loads((ROOT / 'toolbox/tools.json').read_text(encoding='utf-8'))}
        if acceptance:
            for descriptor in self.descriptors.values():
                descriptor['available'] = True
        if test_adapter:
            self.descriptors['top200']['available'] = True
        node = ROOT / 'toolbox/runtime/node.exe'
        node = node if node.is_file() else shutil.which('node')
        if getattr(sys, 'frozen', False):
            os.environ['PLAYWRIGHT_NODEJS_PATH'] = str(node)
        ffmpeg = ROOT / 'toolbox/runtime/ffmpeg.exe'
        ffmpeg = ffmpeg if ffmpeg.is_file() else ROOT / '抖音视频下载器（免 Python 版）/ffmpeg.exe'
        validator = VideoValidator(ffmpeg, paths.resolve('scratch'))
        self.manual = ManualDownloads(self.store, self.events, self.logs, self.browser, core=load_core(), node=node,
            entrypoint=ROOT / 'toolbox/node/worker.cjs', validate_video=validator, process_factory=start_process, test_adapter=test_adapter)
        self.scheduler = TaskScheduler(self.store, self.events, self.logs, self.browser,
            node=node, entrypoint=ROOT / 'toolbox/node/worker.cjs', ffmpeg=ffmpeg, descriptors=self.descriptors,
            validate_video=validator, test_adapter=test_adapter, runners={'manual-video': self.manual})
        self.operations = Operations(self.store, self.events, self.logs, self.browser,
            node=node, entrypoint=ROOT / 'toolbox/node/worker.cjs', descriptors=self.descriptors,
            on_capture=self.capture.ingest, test_adapter=test_adapter)

    def choose_data_location(self):
        import webview
        with self.scheduler._lock, self.operations._lock:
            if self.operations._runs or self.scheduler._runs or any(
                    self.store.list_tasks(state=state, limit=1)['total'] for state in ACTIVE):
                raise ToolboxError('BROWSER_BUSY', '请先结束运行、排队、暂停任务和页面读取，再更改数据位置。')
            selected = self.window.create_file_dialog(webview.FileDialog.FOLDER)
            if not selected:
                return {'cancelled': True}
            target = Path(selected[0]) / 'ScriptAllToolbox'
            if not self.window.create_confirmation_dialog('更改数据位置',
                    '将迁移任务、视频和登录资料到所选文件夹。请退出软件后重新打开完成复制校验；成功前保留原数据。确定更改？'):
                return {'cancelled': True}
            return self.location.request(target)

    def shutdown(self):
        self.operations.shutdown()
        self.scheduler.shutdown()
        self.browser.close()
        self.store.close()
