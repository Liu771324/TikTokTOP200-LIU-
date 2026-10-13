import queue
import threading
import time
from contextlib import nullcontext
from pathlib import Path

from .errors import ToolboxError
from .logs import redact
from .state import ACTIVE
from .worker import NodeWorker

PARAMETERS = {
    'business-center': {'categories', 'minSales', 'maxSales', 'only30dGrowth'},
    'top200': {'categories', 'rankingTypes', 'brandType'},
    'video-ranking': {'category', 'brandType', 'period', 'trendMode'},
    'manual-video': {'items'},
}


class TaskScheduler:
    def __init__(self, store, events, logs, browser, *, node, entrypoint, ffmpeg,
                 descriptors, validate_video, visual_match=None, test_adapter=False, runners=None):
        self.store, self.events, self.logs, self.browser = store, events, logs, browser
        self.node, self.entrypoint, self.ffmpeg = node, entrypoint, ffmpeg
        self.descriptors = descriptors
        self.validate_video, self.visual_match = validate_video, visual_match
        self._test_adapter = test_adapter
        self.runners = runners or {}
        self._lock = threading.RLock()
        self._runs = {}
        self._closing = False
        store.reconcile()
        store.recover()
        queued, offset = [], 0
        while True:
            batch = store.list_tasks(state='queued', offset=offset, limit=100)
            queued.extend(batch['items'])
            offset += len(batch['items'])
            if offset >= batch['total']:
                break
        for task in reversed(queued):
            if self.descriptors.get(task['toolId'], {}).get('available'):
                self._schedule(task)
            else:
                self._state(task['id'], 'failed', task['attempt'], error={'code': 'UNSUPPORTED_OPERATION', 'message': '当前版本尚未接入此工具，请使用支持的版本继续。'})

    def _descriptor(self, tool_id):
        descriptor = self.descriptors.get(tool_id)
        if not descriptor or not descriptor.get('available'):
            raise ToolboxError('UNSUPPORTED_OPERATION', '此工具尚未完成接入。')
        return descriptor

    def create(self, tool_id, parameters):
        with self._lock:
            self._descriptor(tool_id)
            if type(parameters) is not dict or parameters.keys() - PARAMETERS[tool_id]:
                raise ToolboxError('INVALID_PARAMETERS', '任务包含不支持的参数。')
            if self._closing:
                raise ToolboxError('UNSUPPORTED_OPERATION', '工具箱正在退出。')
            task = self.store.create_task(tool_id, parameters)
            self._schedule(task)
            return self.store.task(task['id'])

    def _state(self, task_id, state, attempt, **kwargs):
        if self.store.transition(task_id, state, attempt=attempt, **kwargs):
            self.events.emit('task.state', self.store.task(task_id), task_id)

    def _worker_state(self, task_id, state, attempt, message=None):
        with self._lock:
            current = self.store.task(task_id)
            if current['attempt'] != attempt or current['state'] == 'stopping':
                return
            progress = current['progress']
            if message:
                progress = {**progress, 'message': redact(message)}
            self._state(task_id, state, attempt, progress=progress)

    def _schedule(self, task, retry_failed=False):
        task_id = task['id']
        if task_id in self._runs:
            raise ToolboxError('UNSUPPORTED_OPERATION', '任务仍在结束处理中，请稍后重试。', retryable=True)
        handle = {'cancel': threading.Event(), 'worker': None, 'deadline': None}
        needs_browser = self._descriptor(task['toolId']).get('requiresBrowser', False)
        reservation = self.browser.queue.reserve(task_id) if needs_browser else None
        thread = threading.Thread(target=self._execute, args=(task, handle, reservation, retry_failed), daemon=True)
        handle['thread'] = thread
        self._runs[task_id] = handle
        self.events.emit('task.state', task, task_id)
        try:
            thread.start()
        except Exception:
            if reservation:
                self.browser.queue.withdraw(reservation)
            self._runs.pop(task_id, None)
            self._state(task_id, 'failed', task['attempt'], error={'code': 'WORKER_EXITED', 'message': '无法启动后台任务，请稍后重试。'})

    def _execute(self, task, handle, reservation, retry_failed):
        task_id, attempt = task['id'], task['attempt']
        resource = self.browser.lease(task_id, handle['cancel'].is_set, reservation) if reservation else nullcontext(None)
        try:
            with resource as session:
                with self._lock:
                    if handle['cancel'].is_set():
                        if self.store.task(task_id)['state'] == 'queued':
                            self._state(task_id, 'cancelled', attempt)
                        return
                    context = self.store.paths.task_context(task, self.ffmpeg, session)
                    self._state(task_id, 'running', attempt)
                if task['toolId'] in self.runners:
                    result = self.runners[task['toolId']].run(task, handle, context,
                        lambda state, message=None: self._worker_state(task_id, state, attempt, message))
                    with self._lock:
                        self._state(task_id, 'cancelled' if handle['cancel'].is_set() else result['state'], attempt)
                    return
                with NodeWorker(self.node, self.entrypoint,
                                on_log=lambda line: self.logs.write(line, task_id), test_adapter=self._test_adapter) as worker:
                    with self._lock:
                        handle['worker'] = worker
                        # Control intent is separate from immutable business parameters.
                        parameters = dict(task['parameters'])
                        if retry_failed:
                            context['retryFailed'] = True
                        request_id = worker.send('run', context=context, parameters=parameters)
                        if handle['cancel'].is_set():
                            worker.send('cancel', task_id=task_id, attempt=attempt)
                    last_summary = 0
                    while True:
                        if handle['deadline'] and time.monotonic() > handle['deadline']:
                            raise ToolboxError('WORKER_EXITED', '停止操作超时，已保留最近进度。', retryable=True)
                        try:
                            message = worker.receive(.2)
                        except queue.Empty:
                            continue
                        if message.get('requestId') != request_id:
                            if message['type'] == 'error':
                                self.logs.write(message['data'].get('message', ''), task_id, 'warning')
                            continue
                        if message.get('taskId', task_id) != task_id or message.get('attempt', attempt) != attempt:
                            continue
                        kind, data = message['type'], message.get('data', {})
                        if kind == 'log':
                            self.logs.write(data.get('message', ''), task_id)
                        elif kind == 'progress':
                            if 'message' in data:
                                data['message'] = redact(data['message'])
                            self.events.emit('task.progress', data, task_id)
                            if time.monotonic() - last_summary >= 1:
                                with self._lock:
                                    current = self.store.task(task_id)
                                    self.store.transition(task_id, current['state'], attempt=attempt, progress=data, error=current['error'])
                                last_summary = time.monotonic()
                        elif kind == 'checkpoint':
                            with self._lock:
                                current = self.store.task(task_id)
                                progress = {**current['progress'], 'checkpointAt': data.get('savedAt')}
                                self.store.transition(task_id, current['state'], attempt=attempt, progress=progress, error=current['error'])
                        elif kind == 'state':
                            self._worker_state(task_id, data['state'], attempt, data.get('message'))
                        elif kind == 'artifact_candidate':
                            try:
                                registered = self.store.register(task_id, attempt, data,
                                    validate_video=self.validate_video, visual_match=self.visual_match)
                                response = {'candidateId': data['candidateId'], **registered}
                                self.events.emit('task.artifact', registered, task_id)
                            except ToolboxError as exc:
                                response = {'candidateId': data.get('candidateId'), 'error': exc.as_dict()}
                            worker.send('artifact_result', task_id=task_id, attempt=attempt, data=response)
                        elif kind == 'artifact_lookup':
                            worker.send('artifact_result', task_id=task_id, attempt=attempt, data={
                                'candidateId': data['candidateId'],
                                'registration': self.store.registered(task_id, data['candidateId'])})
                        elif kind == 'artifact_metadata':
                            try:
                                if type(data) is not dict or data.keys() != {'candidateId', 'metadata'}:
                                    raise ToolboxError('INVALID_PARAMETERS', '结果元数据消息格式无效。')
                                updated = self.store.update_metadata(task_id, attempt, data['candidateId'], data['metadata'])
                                response = {'candidateId': data['candidateId'], **updated}
                                self.events.emit('task.artifact', updated, task_id)
                            except ToolboxError as exc:
                                response = {'candidateId': data.get('candidateId') if isinstance(data, dict) else None, 'error': exc.as_dict()}
                            worker.send('artifact_result', task_id=task_id, attempt=attempt, data=response)
                        elif kind == 'result':
                            with self._lock:
                                final = 'cancelled' if handle['cancel'].is_set() else data.get('state')
                                if final not in {'completed', 'completed_with_errors', 'failed', 'cancelled'}:
                                    raise ToolboxError('WORKER_PROTOCOL_ERROR', '引擎未报告明确的最终状态。')
                                self._state(task_id, final, attempt, error=data.get('error'))
                            return
                        elif kind == 'error':
                            raise ToolboxError(data.get('code', 'WORKER_EXITED'), redact(data.get('message', '执行失败。')), retryable=data.get('retryable', False))
        except Exception as exc:
            error = exc if isinstance(exc, ToolboxError) else ToolboxError('WORKER_EXITED', '任务执行异常，已保留现有结果。', retryable=True)
            with self._lock:
                current = self.store.task(task_id)
                if current['state'] in ACTIVE:
                    if error.code == 'CANCELLED':
                        final = 'cancelled'
                    elif error.code in {'WORKER_EXITED', 'WORKER_PROTOCOL_ERROR'} and current['state'] != 'queued':
                        final = 'interrupted'
                    else:
                        final = 'failed'
                    self._state(task_id, final, attempt, error=error.as_dict())
                self.logs.write(f'{type(exc).__name__}: {error}', task_id, 'error')
        finally:
            with self._lock:
                self._runs.pop(task_id, None)

    def control(self, task_id, command):
        with self._lock:
            if self._closing and command != 'cancel':
                raise ToolboxError('UNSUPPORTED_OPERATION', '工具箱正在退出。')
            task = self.store.task(task_id)
            descriptor = self._descriptor(task['toolId'])
            handle = self._runs.get(task_id)
            state = task['state']
            if command == 'cancel':
                if not handle and state == 'queued':
                    self._state(task_id, 'cancelled', task['attempt'])
                    return self.store.task(task_id)
                if not handle or state not in ACTIVE or handle['cancel'].is_set():
                    return task
                handle['cancel'].set()
                if state == 'queued':
                    self._state(task_id, 'cancelled', task['attempt'])
                elif state != 'stopping':
                    self._state(task_id, 'stopping', task['attempt'])
                handle['deadline'] = time.monotonic() + 10
                if handle['worker']:
                    try:
                        handle['worker'].send('cancel', task_id=task_id, attempt=task['attempt'])
                    except ToolboxError:
                        # The reader/shutdown still reaps a worker that exited during this request.
                        handle['deadline'] = time.monotonic()
            elif command == 'pause' and descriptor.get('supportsPause'):
                if state in {'pausing', 'paused'}:
                    return task
                if state != 'running' or not handle or not handle['worker']:
                    raise ToolboxError('UNSUPPORTED_OPERATION', '任务当前不能暂停。')
                self._state(task_id, 'pausing', task['attempt'])
                handle['worker'].send('pause', task_id=task_id, attempt=task['attempt'])
            elif command == 'resume' and state in {'paused', 'waiting_user'} and handle:
                handle['worker'].send('resume', task_id=task_id, attempt=task['attempt'])
            elif command in {'resume', 'retry_failed'}:
                capability = 'supportsResume' if command == 'resume' else 'supportsRetryFailed'
                allowed = {'cancelled', 'interrupted', 'failed'} if command == 'resume' else {'failed', 'completed_with_errors'}
                if not descriptor.get(capability) or state not in allowed or handle:
                    raise ToolboxError('UNSUPPORTED_OPERATION', '任务当前不能恢复或重试。')
                if not Path(self.store.paths.resolve(f'tasks/{task_id}/engine-state.json')).is_file():
                    raise ToolboxError('STATE_CORRUPT', '没有可恢复的进度，请按相同条件创建新任务。')
                self._state(task_id, 'queued', task['attempt'])
                self._schedule(self.store.task(task_id), command == 'retry_failed')
            else:
                raise ToolboxError('UNSUPPORTED_OPERATION', '任务不支持此操作。')
            return self.store.task(task_id)

    def shutdown(self):
        with self._lock:
            self._closing = True
            handles = list(self._runs.items())
        for task_id, _ in handles:
            self.control(task_id, 'cancel')
        deadline = time.monotonic() + 20
        for _, handle in handles:
            handle['thread'].join(max(0, deadline - time.monotonic()))
        remaining = [handle for _, handle in handles if handle['thread'].is_alive()]
        for handle in remaining:
            if handle['worker']:
                handle['worker'].close()
            handle['thread'].join(2)
        if any(handle['thread'].is_alive() for handle in remaining):
            raise ToolboxError('WORKER_EXITED', '仍有任务正在保存，请稍后再次退出。', retryable=True)
