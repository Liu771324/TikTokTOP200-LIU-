"""Own the cost process for the desktop lifetime, independently of collection tasks."""
import base64
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
from uuid import uuid4

from .errors import ToolboxError
from .processes import start_process
from .paths import display_filename


class CostServiceManager:
    def __init__(self, paths, logs, *, port=8765):
        self.paths, self.logs, self.port = paths, logs, port
        self.root = paths.resolve('cost')
        self._lock = threading.RLock()
        self._process = self._job = None
        self._closed = False
        self._error = None
        self._stopped = False
        self._restarts = 0
        self._started_once = False
        self._closing = threading.Event()
        threading.Thread(target=self._watch, daemon=True).start()

    @property
    def enabled(self):
        return (self.root / 'initialized.json').is_file()

    def _read(self, process, messages):
        try:
            while line := process.stdout.readline(1024 * 1024 + 2):
                if len(line) > 1024 * 1024 or not line.endswith(b'\n'):
                    raise ValueError('成本通信格式无效')
                messages.put_nowait(json.loads(line))
        except (OSError, ValueError, queue.Full):
            pass
        finally:
            try:
                messages.put_nowait({'type': 'fatal', 'message': '成本后台连接中断，请核对更新历史后重新预览'})
            except queue.Full:
                pass

    def _receive(self, timeout):
        try:
            value = self._messages.get(timeout=timeout)
        except queue.Empty as exc:
            raise ToolboxError('COST_RESULT_UNCERTAIN', '成本操作仍在处理或结果尚未确认，请查看更新历史，不要重复提交。') from exc
        if value.get('type') == 'fatal':
            raise ToolboxError('COST_UNAVAILABLE', value.get('message', '成本后台不可用'))
        return value

    def _start(self):
        if self._closed:
            raise ToolboxError('COST_UNAVAILABLE', '工具箱正在退出')
        if self._process is not None and self._process.poll() is None:
            return
        if self._started_once:
            if self._restarts >= 3:
                raise ToolboxError('COST_UNAVAILABLE', '成本后台连续退出，已停止自动重启。请查看日志，处理后点击启动服务。')
            self._restarts += 1
        self._started_once = True
        self._dispose()
        command = ([sys.executable, '--cost-service-worker'] if getattr(sys, 'frozen', False)
                   else [sys.executable, '-u', '-m', 'toolbox.cost_worker'])
        command += ['--root', str(self.root), '--port', str(self.port)]
        self._messages = queue.Queue(maxsize=256)
        environment = os.environ.copy()
        environment['PYTHONUTF8'] = '1'
        self._process, self._job = start_process(command, cwd=Path(__file__).resolve().parents[2],
            env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        threading.Thread(target=self._read, args=(self._process, self._messages), daemon=True).start()
        ready = self._receive(30)
        if ready.get('type') != 'ready':
            raise ToolboxError('COST_UNAVAILABLE', '成本后台未正确就绪')
        self.port = ready['port']
        self._error = None

    def _dispose(self):
        if self._process is None:
            return
        if self._process.poll() is None:
            raise ToolboxError('COST_UNAVAILABLE', '成本后台仍在退出，请稍后再试')
        if self._job:
            self._job.close()
        for pipe in (self._process.stdin, self._process.stdout):
            if pipe:
                pipe.close()
        self._process = self._job = None

    def _request(self, action, payload):
        request_id = uuid4().hex
        data = json.dumps({'id': request_id, 'action': action, 'payload': payload}, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(data) > 1024 * 1024 - 1:
            raise ToolboxError('INVALID_PARAMETERS', '成本参数超过通信限制')
        try:
            self._process.stdin.write(data + b'\n')
            self._process.stdin.flush()
        except (OSError, ValueError) as exc:
            raise ToolboxError('COST_RESULT_UNCERTAIN', '成本连接已中断，请先核对更新历史，不要重复提交。') from exc
        chunks = bytearray()
        deadline = time.monotonic() + 120
        while True:
            try:
                message = self._receive(max(.01, deadline - time.monotonic()))
            except ToolboxError as exc:
                raise ToolboxError('COST_RESULT_UNCERTAIN', '成本请求发出后连接中断或仍在处理，请先核对更新历史，不要重复提交。') from exc
            if message.get('id') != request_id:
                continue
            if message['type'] == 'result':
                return message['response']
            if message['type'] == 'chunk':
                chunks.extend(base64.b64decode(message['data'], validate=True))
                if len(chunks) > 16 * 1024 * 1024:
                    raise ToolboxError('COST_UNAVAILABLE', '成本返回结果超过安全上限')
            elif message['type'] == 'end':
                return json.loads(chunks)

    def invoke(self, action, payload):
        with self._lock:
            if action == 'start_service':
                self._restarts = 0
            self._stopped = action == 'stop_service' or (self._stopped and action != 'start_service')
            self._start()
            response = self._request(action, payload)
            if not response.get('ok'):
                raise ToolboxError('COST_OPERATION_FAILED', response.get('error', '成本操作未完成'))
            return response.get('result')

    def choose_file(self, window, kind):
        import webview
        extensions = {'.xlsx', '.csv', '.tsv'} if kind == 'cost' else {'.xlsx'}
        if kind not in {'cost', 'ordinary', 'combination', 'mapping'}:
            raise ToolboxError('INVALID_PARAMETERS', '不支持此文件类型')
        selected = window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=False,
            file_types=('成本表 (*.xlsx;*.csv;*.tsv)',) if kind == 'cost' else ('Excel 工作簿 (*.xlsx)',))
        if not selected:
            return None
        return self.stage_input(Path(selected[0]), extensions)

    def stage_input(self, source, extensions=None):
        with self._lock:
            self._start()
            if source.suffix.lower() not in (extensions or {'.xlsx', '.csv', '.tsv'}) or not source.is_file():
                raise ToolboxError('INVALID_PARAMETERS', '请选择支持的成本表格')
            token = uuid4().hex
            target = self.paths.resolve('cost/inputs/' + token + '/' + display_filename(source.stem, source.suffix.lower()))
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                with source.open('rb') as incoming, target.open('xb') as outgoing:
                    total = 0
                    while block := incoming.read(1024 * 1024):
                        total += len(block)
                        if total > 16 * 1024 * 1024:
                            raise ToolboxError('INVALID_PARAMETERS', '成本表超过 16 MB 上限')
                        outgoing.write(block)
            except BaseException:
                target.unlink(missing_ok=True)
                raise
            return {'name': source.name, 'path': token}

    def _watch(self):
        delay = 1
        while not self._closing.wait(delay):
            delay = 2
            if not self.enabled or self._stopped or self._restarts >= 3:
                continue
            with self._lock:
                if self._closed or (self._process is not None and self._process.poll() is None):
                    continue
                try:
                    self._start()
                except Exception as exc:
                    delay = min(30, 2 ** self._restarts)
                    self._error = str(exc)
                    self.logs.write('成本后台启动失败，请在成本助手检查服务状态。', level='error')

    def shutdown(self):
        if not self._lock.acquire(timeout=1):
            raise ToolboxError('COST_BUSY', '成本资料仍在处理，请等待保存完成再退出。')
        try:
            self._closing.set()
            self._closed = True
            if self._process is not None and self._process.poll() is None:
                self._request('shutdown', {})
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired as exc:
                    raise ToolboxError('COST_BUSY', '成本后台正在释放文件，请稍后再次退出。') from exc
            self._dispose()
        finally:
            self._lock.release()
