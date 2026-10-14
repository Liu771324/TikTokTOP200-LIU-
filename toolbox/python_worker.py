"""Hidden Python business worker using the toolbox's existing NDJSON protocol."""
import io
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
from types import SimpleNamespace

if __package__ in {None, ''}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from toolbox.host.errors import ToolboxError
from toolbox.host.events import now
from toolbox.host.logs import redact
from toolbox.host.state import save_state

MAX_MESSAGE = 1024 * 1024


class Cancelled(ToolboxError):
    def __init__(self):
        super().__init__('CANCELLED', '任务已停止，已保留进度。')


class WorkerApi:
    def __init__(self, context, send, command):
        self.context, self.send, self.command = context, send, command
        self.control = SimpleNamespace(cancelled=False, pauseRequested=False, waitingUser=False)
        self.condition = threading.Condition()
        self.pending = {}
        self.closed = False

    def emit(self, kind, data):
        if self.closed:
            raise Cancelled()
        if kind == 'state' and self.control.cancelled:
            return
        self.send(kind, data)

    def checkpoint(self, state):
        if self.closed or self.command != 'run':
            raise ToolboxError('UNSUPPORTED_OPERATION', '当前操作不能保存任务进度。')
        try:
            save_state(self.context['statePath'], self.context, state)
        except OSError as exc:
            raise ToolboxError('CHECKPOINT_IO_ERROR', '无法保存检查点，已停止继续采集，请检查磁盘和文件占用。') from exc
        self.send('checkpoint', {'savedAt': now()})

    def boundary(self):
        with self.condition:
            if self.closed or self.control.cancelled:
                raise Cancelled()
            if self.control.pauseRequested:
                self.send('state', {'state': 'paused'})
                while self.control.pauseRequested and not self.control.cancelled:
                    self.condition.wait(.1)
                if self.closed or self.control.cancelled:
                    raise Cancelled()
                self.send('state', {'state': 'running'})

    def wait_for_user(self, message):
        if self.command != 'run':
            raise ToolboxError('LOGIN_REQUIRED', '请在受管浏览器完成登录后重新读取。')
        self.boundary()
        with self.condition:
            self.control.waitingUser = True
            self.send('state', {'state': 'waiting_user', 'message': redact(message)})
            while self.control.waitingUser and not self.control.cancelled:
                self.condition.wait(.1)
            if self.closed or self.control.cancelled:
                raise Cancelled()
            self.send('state', {'state': 'running'})
        self.boundary()

    def register(self, candidate):
        if self.closed or self.command != 'run':
            raise ToolboxError('UNSUPPORTED_OPERATION', '当前操作不能登记报告。')
        key = candidate['candidateId']
        pending = {'event': threading.Event(), 'data': None}
        with self.condition:
            if key in self.pending:
                raise ToolboxError('WORKER_PROTOCOL_ERROR', '报告正在登记。')
            self.pending[key] = pending
        try:
            # A stopping task may still publish its partial report before the host's deadline.
            self.send('artifact_candidate', candidate)
            if not pending['event'].wait(5):
                raise ToolboxError('WORKER_EXITED', '报告登记超时，已保留检查点。')
            data = pending['data']
            if data.get('error'):
                error = data['error']
                raise ToolboxError(error['code'], error['message'])
            return data
        finally:
            with self.condition:
                self.pending.pop(key, None)

    def reply_artifact(self, data):
        with self.condition:
            pending = self.pending.get(data.get('candidateId'))
            if pending:
                pending['data'] = data
                pending['event'].set()

    def command_control(self, command):
        with self.condition:
            if command == 'cancel':
                self.control.cancelled = True
            else:
                self.control.pauseRequested = command == 'pause'
                if command == 'resume':
                    self.control.waitingUser = False
            self.condition.notify_all()


class Runtime:
    def __init__(self, output, adapter=None):
        self.output, self.adapter = output, adapter
        self.write_lock = threading.Lock()
        self.active = None
        self.closing = threading.Event()

    def write(self, kind, data, *, request_id=None, context=None):
        message = {'protocolVersion': 1, 'type': kind, 'requestId': request_id, 'data': data}
        if context:
            keys = ('taskId', 'attempt') if context.get('taskId') else ('operationId',)
            message.update({key: context[key] for key in keys})
        line = json.dumps(message, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(line) > MAX_MESSAGE:
            raise ToolboxError('WORKER_PROTOCOL_ERROR', '工作者消息超过大小限制。')
        with self.write_lock:
            self.output.write(line + b'\n')
            self.output.flush()

    def handle(self, message):
        if (type(message) is not dict or message.get('protocolVersion') != 1
                or not isinstance(message.get('requestId'), str) or not isinstance(message.get('type'), str)):
            raise ValueError('invalid envelope')
        kind, request_id = message['type'], message['requestId']
        active = self.active
        if kind == 'shutdown':
            self.write('ack', {'command': kind}, request_id=request_id)
            self.stop()
            return
        if kind in {'pause', 'resume', 'cancel', 'artifact_result'}:
            if (not active or not active['context'].get('taskId')
                    or any(message.get(key) != active['context'][key] for key in ('taskId', 'attempt'))):
                self.write('error', {'code': 'UNSUPPORTED_OPERATION', 'message': '执行身份已改变。'}, request_id=request_id)
                return
            if kind == 'artifact_result':
                if type(message.get('data')) is not dict:
                    raise ValueError('invalid artifact response')
                active['api'].reply_artifact(message['data'])
            else:
                active['api'].command_control(kind)
                self.write('ack', {'command': kind}, request_id=request_id)
            return
        context, parameters = message.get('context'), message.get('parameters', {})
        task_command = kind in {'run', 'read_results'}
        if (kind not in {'run', 'discover', 'read_results'} or type(context) is not dict
                or context.get('protocolVersion') != 1 or context.get('toolId') != 'business-center'
                or type(parameters) is not dict
                or (task_command and (not re.fullmatch('[a-f0-9]{32}', str(context.get('taskId', '')))
                    or type(context.get('attempt')) is not int or context['attempt'] < 1))
                or (not task_command and not isinstance(context.get('operationId'), str))):
            self.write('error', {'code': 'INVALID_PARAMETERS', 'message': '执行上下文无效。'}, request_id=request_id)
            return
        if active or self.closing.is_set():
            self.write('error', {'code': 'BROWSER_BUSY', 'message': '工作者正在处理其他操作。'}, request_id=request_id)
            return
        send = lambda event, data: self.write(event, data, request_id=request_id, context=context)
        api = WorkerApi(context, send, kind)
        active = {'context': context, 'api': api}
        self.active = active
        self.write('ack', {'command': kind}, request_id=request_id)
        active['thread'] = threading.Thread(target=self.execute, args=(kind, parameters, context, api, send), daemon=True)
        active['thread'].start()

    def execute(self, kind, parameters, context, api, send):
        try:
            adapter = self.adapter
            if adapter is None:
                from toolbox.engines.business import adapter
            send('result', getattr(adapter, kind)(parameters, context, api) or {})
        except Exception as exc:
            code = getattr(exc, 'code', 'WORKER_EXITED')
            message = str(exc) if isinstance(exc, ToolboxError) or getattr(exc, 'code', None) else '采集执行异常，已保留已提交进度。'
            send('error', {'code': code, 'message': redact(message), 'retryable': code in {'WORKER_EXITED', 'BROWSER_DISCONNECTED'}})
        finally:
            api.closed = True
            self.active = None

    def stop(self):
        self.closing.set()
        if self.active:
            self.active['api'].command_control('cancel')

    def heartbeat(self):
        while not self.closing.wait(5):
            try:
                self.write('heartbeat', {})
            except (OSError, ValueError):
                self.stop()


def pipe_stream(stream, std_handle, mode):
    if stream is not None:
        return stream.buffer
    # A windowed PyInstaller executable has no sys.std* even when pipes are supplied.
    import ctypes
    from ctypes import wintypes
    import msvcrt
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    handle = kernel.GetStdHandle(std_handle & 0xffffffff)
    if handle in (None, 0, wintypes.HANDLE(-1).value):
        raise OSError('Worker requires redirected pipes')
    flags = os.O_BINARY | (os.O_RDONLY if mode == 'rb' else os.O_WRONLY)
    return os.fdopen(msvcrt.open_osfhandle(int(handle), flags), mode, buffering=0)


def main():
    input_pipe = pipe_stream(sys.stdin, -10, 'rb')
    output_pipe = pipe_stream(sys.stdout, -11, 'wb')
    error_pipe = pipe_stream(sys.stderr, -12, 'wb')
    sys.stderr = io.TextIOWrapper(error_pipe, encoding='utf-8', write_through=True)
    sys.stdout = sys.stderr
    runtime = Runtime(output_pipe)
    threading.Thread(target=runtime.heartbeat, daemon=True).start()
    runtime.write('ready', {'pid': os.getpid(), 'protocolVersion': 1})
    try:
        while not runtime.closing.is_set():
            line = input_pipe.readline(MAX_MESSAGE + 2)
            if not line:
                break
            if len(line.rstrip(b'\r\n')) > MAX_MESSAGE or not line.endswith(b'\n'):
                raise ValueError('message too large or incomplete')
            runtime.handle(json.loads(line.decode('utf-8')))
    except (ValueError, UnicodeError):
        runtime.write('error', {'code': 'WORKER_PROTOCOL_ERROR', 'message': '工作者通信格式异常。'})
    finally:
        runtime.stop()


if __name__ == '__main__':
    main()
