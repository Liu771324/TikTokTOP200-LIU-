import queue
import threading
import time
from uuid import uuid4

from .errors import ToolboxError
from .logs import redact
from .worker import NodeWorker


class Operations:
    """Short operations share the browser queue, never create a business task."""
    def __init__(self, store, events, logs, browser, *, node, entrypoint, descriptors, on_capture=None, test_adapter=False):
        self.store, self.events, self.logs, self.browser = store, events, logs, browser
        self.node, self.entrypoint, self.descriptors = node, entrypoint, descriptors
        self.on_capture, self.test_adapter = on_capture, test_adapter
        self._lock = threading.RLock()
        self._runs = {}
        self._closed = False

    def submit(self, kind, tool_id, parameters):
        if kind not in {'discover', 'capture_page'} or not self.descriptors.get(tool_id, {}).get('available'):
            raise ToolboxError('UNSUPPORTED_OPERATION', '此工具尚未支持该操作。')
        with self._lock:
            if self._closed or len(self._runs) >= 20:
                raise ToolboxError('BROWSER_BUSY', '操作队列已满或工具箱正在退出，请稍后重试。', retryable=True)
            operation_id = uuid4().hex
            reservation = self.browser.queue.reserve(operation_id)
            handle = {'cancel': threading.Event(), 'worker': None}
            thread = threading.Thread(target=self._run, args=(operation_id, kind, tool_id, parameters, reservation, handle), daemon=True)
            handle['thread'] = thread
            self._runs[operation_id] = handle
            try:
                thread.start()
            except Exception:
                self._runs.pop(operation_id)
                self.browser.queue.withdraw(reservation)
                raise ToolboxError('WORKER_EXITED', '无法启动后台操作。')
            return {'operationId': operation_id}

    def _run(self, operation_id, kind, tool_id, parameters, reservation, handle):
        self.events.emit('operation.state', {'operationId': operation_id, 'kind': kind, 'state': 'queued'})
        try:
            with self.browser.lease(operation_id, handle['cancel'].is_set, reservation) as session:
                scratch = self.store.paths.resolve('scratch/operation-' + operation_id)
                scratch.mkdir(parents=True)
                context = {'protocolVersion': 1, 'toolId': tool_id, 'operationId': operation_id,
                           'dataRoot': str(self.store.paths.root), 'scratchRoot': str(scratch), 'browser': session}
                self.events.emit('operation.state', {'operationId': operation_id, 'kind': kind, 'state': 'running'})
                result = self._call(kind, parameters, context, handle)
                if kind == 'capture_page' and self.on_capture:
                    result = self.on_capture(result)
                self.events.emit('operation.state', {'operationId': operation_id, 'kind': kind, 'state': 'completed', 'result': result})
        except Exception as exc:
            error = exc if isinstance(exc, ToolboxError) else ToolboxError('WORKER_EXITED', '操作失败，请重新读取。', retryable=True)
            self.logs.write(f'{type(exc).__name__}: {error}', level='error')
            self.events.emit('operation.state', {'operationId': operation_id, 'kind': kind, 'state': 'failed', 'error': error.as_dict()})
        finally:
            with self._lock:
                self._runs.pop(operation_id, None)

    def _call(self, kind, parameters, context, handle=None):
        with NodeWorker(self.node, self.entrypoint, on_log=self.logs.write, test_adapter=self.test_adapter) as worker:
            if handle:
                with self._lock:
                    handle['worker'] = worker
                if handle['cancel'].is_set():
                    raise ToolboxError('CANCELLED', '操作已停止。')
            request_id = worker.send(kind, context=context, parameters=parameters)
            deadline = time.monotonic() + (30 if kind == 'read_results' else 120)
            categories = []
            while time.monotonic() < deadline:
                if handle and handle['cancel'].is_set():
                    raise ToolboxError('CANCELLED', '操作已停止。')
                try:
                    message = worker.receive(.2)
                except queue.Empty:
                    continue
                if message.get('requestId') != request_id:
                    continue
                if message['type'] == 'options_chunk':
                    data = message.get('data', {})
                    items = data.get('items') if type(data) is dict else None
                    if (kind != 'discover' or context['toolId'] != 'business-center'
                            or type(data) is not dict or data.get('field') != 'categories' or type(items) is not list
                            or not 1 <= len(items) <= 50 or len(categories) + len(items) > 10000
                            or any(type(item) is not dict or not isinstance(item.get('displayPath'), str)
                                   or type(item.get('segments')) is not list or not item['segments']
                                   or type(item.get('valuePath')) is not list
                                   or any(not isinstance(part, str) for part in item['segments'] + item['valuePath'])
                                   for item in items)):
                        raise ToolboxError('WORKER_PROTOCOL_ERROR', '类目分片格式无效或超过安全上限。')
                    categories.extend(items)
                if message['type'] == 'result':
                    result = message.get('data', {})
                    if categories:
                        if type(result) is not dict or result.get('categories') != []:
                            raise ToolboxError('WORKER_PROTOCOL_ERROR', '类目分片结束标记无效。')
                        result = {**result, 'categories': categories}
                    return result
                if message['type'] == 'error':
                    data = message.get('data', {})
                    raise ToolboxError(data.get('code', 'WORKER_EXITED'), redact(data.get('message', '读取失败。')))
                if message['type'] == 'log':
                    self.logs.write(message.get('data', {}).get('message', ''))
            raise ToolboxError('WORKER_EXITED', '读取超时，请重新操作。', retryable=True)

    def results(self, task_id, offset=0, limit=50, section='results'):
        from .store import page
        page(offset, limit, 200)
        task = self.store.task(task_id)
        allowed = {'results', 'failures', 'unparseableItems'} if task['toolId'] == 'business-center' else {'results', 'failures'} if task['toolId'] == 'top200' else {'results'}
        if section not in allowed:
            raise ToolboxError('INVALID_PARAMETERS', '此工具不支持该结果分区。')
        state = self.store.paths.resolve(f'tasks/{task_id}/engine-state.json')
        if not state.exists():
            return {'items': [], 'total': 0}
        # No task_context(), mkdir, browser lease, or engine store construction here.
        context = {'protocolVersion': 1, 'toolId': task['toolId'], 'taskId': task_id,
                   'attempt': task['attempt'], 'dataRoot': str(self.store.paths.root), 'statePath': str(state), 'browser': None}
        parameters = {'offset': offset, 'limit': limit}
        if section != 'results':
            parameters['section'] = section
        return self._call('read_results', parameters, context)

    def shutdown(self):
        with self._lock:
            self._closed = True
            handles = list(self._runs.values())
            for handle in handles:
                handle['cancel'].set()
        for handle in handles:
            handle['thread'].join(5)
            if handle['thread'].is_alive() and handle['worker']:
                handle['worker'].close()
                handle['thread'].join(2)
        if any(handle['thread'].is_alive() for handle in handles):
            raise ToolboxError('WORKER_EXITED', '仍有后台读取正在结束，请稍后再次退出。')
