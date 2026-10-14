import json
import os
import queue
import subprocess
import threading
import time
import sys
from pathlib import Path
from uuid import uuid4

from .errors import ToolboxError
from .processes import start_process

MAX_MESSAGE = 1024 * 1024


class NodeWorker:
    def __init__(self, node, entrypoint, *, on_log=lambda message: None, test_adapter=False, command=None):
        self._messages = queue.Queue(maxsize=256)
        self._write_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._requests = {}
        self._failure = None
        self._closed = False
        self._last_heartbeat = time.monotonic()
        command = list(command) if command else [str(node), str(entrypoint)]
        if test_adapter:
            command.append('--test-adapter')
        self.process, self._job = start_process(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._logs, args=(on_log,), daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()
        try:
            ready = self.receive(10)
            if ready.get('type') != 'ready':
                raise ToolboxError('WORKER_PROTOCOL_ERROR', '工作者未正确就绪。')
        except BaseException:
            self.close()
            raise

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_MESSAGE + 2)
                if not line:
                    break
                if len(line.rstrip(b'\r\n')) > MAX_MESSAGE or not line.endswith(b'\n'):
                    raise ValueError('message too large or incomplete')
                message = json.loads(line.decode('utf-8'))
                if not isinstance(message, dict) or message.get('protocolVersion') != 1 or not isinstance(message.get('type'), str):
                    raise ValueError('invalid envelope')
                if message['type'] == 'heartbeat':
                    self._last_heartbeat = time.monotonic()
                elif message['type'] == 'ready':
                    self._messages.put_nowait(message)
                elif message.get('requestId') is None:
                    raise ValueError('unattributed message')
                else:
                    with self._write_lock:
                        expected = self._requests.get(message['requestId'])
                        if expected is None:
                            continue  # A completed request may have late messages; never apply them.
                        context = expected.get('context')
                        if context and message['type'] != 'ack' and (message['type'] != 'error' or 'taskId' in message or 'operationId' in message):
                            keys = ('taskId', 'attempt') if context.get('taskId') else ('operationId',)
                            if any(message.get(key) != context.get(key) for key in keys):
                                continue
                        if message['type'] in {'result', 'error'} or (not context and message['type'] == 'ack'):
                            self._requests.pop(message['requestId'], None)
                    self._messages.put_nowait(message)
        except (ValueError, OSError, UnicodeError, queue.Full):
            self._failure = ToolboxError('WORKER_PROTOCOL_ERROR', '工作者通信格式异常，已保留进度。')
        finally:
            try:
                self._messages.put_nowait(ToolboxError('WORKER_EXITED', '工作者已退出，已保留进度。', retryable=True))
            except queue.Full:
                pass

    def _watch(self):
        while not self._closed:
            if self._failure or time.monotonic() - self._last_heartbeat > 30:
                self._failure = self._failure or ToolboxError('WORKER_EXITED', '工作者长时间未响应，已保留进度。', retryable=True)
                self.close()
                return
            time.sleep(.2)

    def _logs(self, callback):
        while line := self.process.stderr.readline(8192):
            try:
                callback(line.decode('utf-8', errors='replace').rstrip())
            except Exception:
                pass  # Logging must not stop the pipe reader and deadlock the child.

    def send(self, kind, *, context=None, parameters=None, task_id=None, attempt=None, data=None):
        message = {'protocolVersion': 1, 'requestId': uuid4().hex, 'type': kind}
        if context is not None:
            message.update(context=context, parameters=parameters or {})
        if task_id is not None:
            message.update(taskId=task_id, attempt=attempt)
        if data is not None:
            message['data'] = data
        line = json.dumps(message, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(line) > MAX_MESSAGE:
            raise ToolboxError('WORKER_PROTOCOL_ERROR', '命令超过通信大小限制。')
        with self._write_lock:
            try:
                if kind != 'artifact_result':
                    self._requests[message['requestId']] = message
                self.process.stdin.write(line + b'\n')
                self.process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError) as exc:
                raise ToolboxError('WORKER_EXITED', '工作者已退出。', retryable=True) from exc
        return message['requestId']

    def receive(self, timeout=1):
        if self._failure:
            self.close()
            raise self._failure
        try:
            message = self._messages.get(timeout=timeout)
        except queue.Empty:
            if time.monotonic() - self._last_heartbeat > 30:
                self.close()
                raise ToolboxError('WORKER_EXITED', '工作者长时间未响应，已保留进度。', retryable=True)
            raise
        if isinstance(message, ToolboxError):
            self.close()
            raise message
        return message

    def close(self):
        with self._close_lock:
            if self._closed:
                return
            self._job.close()
            if self.process.poll() is None and os.name != 'nt':
                self.process.kill()
            self.process.wait(timeout=10)
            for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
                pipe.close()
            self._closed = True

    def shutdown(self, grace_seconds=3):
        if self.process.poll() is None:
            try:
                self.send('shutdown')
                self.process.wait(timeout=grace_seconds)
            except (ToolboxError, subprocess.TimeoutExpired):
                pass
        self.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class PythonWorker(NodeWorker):
    """Use the same bounded protocol/identity checks for the Python business engine."""
    def __init__(self, node=None, entrypoint=None, *, on_log=lambda message: None, test_adapter=False):
        command = ([sys.executable, '--business-worker'] if getattr(sys, 'frozen', False)
                   else [sys.executable, '-u', str(Path(__file__).parents[1] / 'python_worker.py')])
        super().__init__(node, entrypoint, on_log=on_log, command=command)
