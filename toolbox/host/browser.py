import json
import os
import re
import subprocess
import shutil
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from .errors import ToolboxError
from .processes import start_process
from .resources import ResourceQueue

SOURCES = {
    'business-center': 'https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter',
    'top200': 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank',
    'video-ranking': 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank',
    'manual-video': 'https://compass.jinritemai.com/shop/chance/merchandise-product-rank',
}


def find_edge():
    candidates = []
    if os.name == 'nt':
        import winreg
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe') as key:
                    candidates.append(Path(winreg.QueryValue(key, None)))
            except OSError:
                pass
    for name in ('PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA'):
        if base := os.environ.get(name):
            candidates.append(Path(base) / 'Microsoft/Edge/Application/msedge.exe')
    return next((p for p in candidates if p.is_file()), None)


class BrowserManager:
    def __init__(self, paths, events):
        self.paths, self.events = paths, events
        self.queue = ResourceQueue()
        self._lock = threading.RLock()
        self._process = None
        self._job = None
        self._endpoint = None
        self._browser_path = None
        self._http = build_opener(ProxyHandler({}))

    def _request(self, route, method='GET'):
        if not self._endpoint:
            raise ToolboxError('BROWSER_DISCONNECTED', '请先打开并登录受管浏览器。', retryable=True)
        try:
            with self._http.open(Request(self._endpoint + route, method=method), timeout=2) as response:
                data = response.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    raise ValueError('CDP response too large')
                return json.loads(data.decode('utf-8'))
        except (OSError, ValueError) as exc:
            raise ToolboxError('BROWSER_DISCONNECTED', '受管浏览器连接已断开，请重新打开。', retryable=True) from exc

    def _check_identity(self):
        version = self._request('/json/version')
        try:
            if not isinstance(version, dict) or not isinstance(version.get('webSocketDebuggerUrl'), str):
                raise ValueError('invalid browser version')
            address = urlsplit(version['webSocketDebuggerUrl'])
            expected = urlsplit(self._endpoint)
            valid = (address.scheme == 'ws' and address.hostname in {'127.0.0.1', 'localhost'}
                     and address.port == expected.port and address.path == self._browser_path)
        except (TypeError, ValueError):
            valid = False
        if not valid:
            raise ToolboxError('BROWSER_DISCONNECTED', '浏览器会话身份不一致，请关闭受管会话后重试。')

    def _start(self):
        with self._lock:
            if self._endpoint:
                try:
                    self._check_identity()
                    return
                except ToolboxError:
                    self.close()
            executable = find_edge()
            if executable is None:
                raise ToolboxError('EDGE_NOT_FOUND', '未找到 Microsoft Edge，请先安装 Edge。')
            profile = self.paths.resolve('browser-profile')
            profile.mkdir(parents=True, exist_ok=True)
            active_port = self.paths.resolve('browser-profile/DevToolsActivePort')
            active_port.unlink(missing_ok=True)
            self._process, self._job = start_process(
                [str(executable), f'--user-data-dir={profile}', '--remote-debugging-port=0',
                 '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', 'about:blank'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if self._process.poll() is not None:
                        break
                    try:
                        lines = active_port.read_text(encoding='utf-8').splitlines()
                        if len(lines) == 2 and re.fullmatch(r'/devtools/browser/[a-f0-9-]+', lines[1]):
                            port = int(lines[0])
                            if 1 <= port <= 65535:
                                self._endpoint = f'http://127.0.0.1:{port}'
                                self._browser_path = lines[1]
                                self._check_identity()
                                self.events.emit('browser.state', self.state())
                                return
                    except (OSError, ValueError, ToolboxError):
                        pass
                    time.sleep(.1)
                raise ToolboxError('BROWSER_DISCONNECTED', 'Edge 未能建立受管会话，请确认没有旧的工具箱浏览器正在运行。', retryable=True)
            except BaseException:
                self.close()
                raise

    @contextmanager
    def lease(self, owner, cancelled=lambda: False, reservation=None):
        try:
            with self.queue.lease(owner, cancelled, reservation) as ticket:
                self.events.emit('browser.state', self.state())
                self._start()
                yield {'endpoint': self._endpoint, 'leaseId': ticket['leaseId']}
        finally:
            self.events.emit('browser.state', self.state())

    def state(self):
        resource = self.queue.state()
        return {'connected': bool(self._endpoint and self._process and self._process.poll() is None), 'edgeAvailable': find_edge() is not None,
                'login': 'unknown', **resource}

    def open(self, source):
        if source not in SOURCES:
            raise ToolboxError('INVALID_PARAMETERS', '平台来源无效。')
        with self.lease('open:' + source):
            self._check_identity()
            result = self._request('/json/new?' + quote(SOURCES[source], safe=''), method='PUT')
            if not isinstance(result, dict) or not isinstance(result.get('id'), str):
                raise ToolboxError('BROWSER_DISCONNECTED', '浏览器没有返回有效标签页。', retryable=True)
            return {'pageId': result.get('id'), 'source': source}

    def list_pages(self):
        with self.lease('list-pages'):
            self._check_identity()
            pages = self._request('/json/list')
            if not isinstance(pages, list):
                raise ToolboxError('BROWSER_DISCONNECTED', '无法读取浏览器标签页。', retryable=True)
            result = []
            for entry in pages:
                if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not isinstance(entry.get('url'), str):
                    continue
                parsed = urlsplit(entry.get('url', ''))
                if entry.get('type') != 'page' or parsed.scheme != 'https':
                    continue
                if parsed.hostname not in {'compass.jinritemai.com', 'fxg.jinritemai.com', 'www.douyin.com'}:
                    continue
                source = 'compass_ranking' if parsed.hostname == 'compass.jinritemai.com' else 'store' if parsed.hostname == 'fxg.jinritemai.com' else 'douyin'
                result.append({'id': entry['id'], 'title': entry.get('title', ''), 'source': source})
            return result

    def close(self):
        with self._lock:
            if self._job:
                self._job.close()
                self._job = None
            if self._process:
                if self._process.poll() is None:
                    self._process.terminate()
                self._process.wait(timeout=10)
            self._process = None
            self._endpoint = self._browser_path = None

    def clear_login(self):
        state = self.queue.state()
        if state['holder'] or state['waiting']:
            raise ToolboxError('BROWSER_BUSY', '请先结束浏览器任务与读取操作，再清除登录资料。')
        with self.queue.lease('clear-login'):
            self.close()
            profile = self.paths.resolve('browser-profile')
            for child in profile.rglob('*'):
                self.paths.relative(child)
            try:
                shutil.rmtree(profile)
            except FileNotFoundError:
                pass
            profile.mkdir(exist_ok=True)
        self.events.emit('browser.state', self.state())
        return {'cleared': True}
