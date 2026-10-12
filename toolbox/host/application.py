import importlib.util
import json
import shutil
import sys
from pathlib import Path

from .browser import BrowserManager
from .capture import Capture
from .events import Events
from .files import Files
from .logs import Logs
from .media import VideoValidator
from .operations import Operations
from .scheduler import TaskScheduler
from .store import Store


ROOT = Path(__file__).resolve().parents[2]


def load_core():
    if 'douyin_downloader_core' in sys.modules:
        return sys.modules['douyin_downloader_core']
    spec = importlib.util.spec_from_file_location('douyin_downloader_core', ROOT / '抖音视频下载器（免 Python 版）/douyin_downloader_core.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Application:
    def __init__(self, paths, *, test_adapter=False):
        self.window = None
        self.events = Events()
        self.store = Store(paths)
        self.logs = Logs(paths)
        self.browser = BrowserManager(paths, self.events)
        self.files = Files(self.store)
        self.capture = Capture(self.store, self.events, load_core())
        self.descriptors = {d['toolId']: d for d in json.loads((ROOT / 'toolbox/tools.json').read_text(encoding='utf-8'))}
        if test_adapter:
            self.descriptors['top200']['available'] = True
        node = ROOT / 'toolbox/runtime/node.exe'
        node = node if node.is_file() else shutil.which('node')
        ffmpeg = ROOT / 'toolbox/runtime/ffmpeg.exe'
        ffmpeg = ffmpeg if ffmpeg.is_file() else ROOT / '抖音视频下载器（免 Python 版）/ffmpeg.exe'
        self.scheduler = TaskScheduler(self.store, self.events, self.logs, self.browser,
            node=node, entrypoint=ROOT / 'toolbox/node/worker.cjs', ffmpeg=ffmpeg, descriptors=self.descriptors,
            validate_video=VideoValidator(ffmpeg, paths.resolve('scratch')), test_adapter=test_adapter)
        self.operations = Operations(self.store, self.events, self.logs, self.browser,
            node=node, entrypoint=ROOT / 'toolbox/node/worker.cjs', descriptors=self.descriptors,
            on_capture=self.capture.ingest, test_adapter=test_adapter)

    def shutdown(self):
        self.operations.shutdown()
        self.scheduler.shutdown()
        self.browser.close()
        self.store.close()
