import queue
import json
from pathlib import Path

from .errors import ToolboxError
from .logs import redact
from .resources import ResourceQueue
from .state import load_state, save_state
from .worker import NodeWorker


class ManualDownloads:
    """One authoritative state writer for mixed public and shop-session items."""
    def __init__(self, store, events, logs, browser, *, core, node, entrypoint, validate_video, process_factory=None, test_adapter=False):
        self.store, self.events, self.logs, self.browser = store, events, logs, browser
        self.core, self.node, self.entrypoint = core, node, entrypoint
        self.validate_video, self.process_factory = validate_video, process_factory
        self.test_adapter = test_adapter
        self.public_queue = ResourceQueue()

    def run(self, task, handle, context, change_state):
        items = task['parameters']['items']
        state_path = Path(context['statePath'])
        state = load_state(state_path, task['id'], task['toolId'])['state'] if state_path.exists() else {'items': []}
        previous = {item['itemId']: item for item in state['items']}
        state['items'] = [previous.get(item['id'], {'itemId': item['id'], 'title': item['title'],
                            'sourceKind': item['sourceKind'], 'status': 'pending'}) for item in items]
        def checkpoint():
            save_state(state_path, context, state)
            completed = sum(i['status'] == 'completed' for i in state['items'])
            failed = sum(i['status'] == 'failed' for i in state['items'])
            progress = {'current': completed + failed, 'total': len(items), 'completed': completed,
                        'failed': failed, 'message': f'已完成 {completed} / {len(items)}，失败 {failed}'}
            if self.store.update_progress(task['id'], task['attempt'], progress):
                self.events.emit('task.progress', progress, task['id'])
        checkpoint()
        for index, (source, record) in enumerate(zip(items, state['items'])):
            if handle['cancel'].is_set():
                checkpoint()
                return {'state': 'cancelled'}
            candidate_id = 'manual:' + source['id']
            registration = self.store.registered(task['id'], candidate_id)
            if registration:
                with self.store._lock:
                    metadata = json.loads(self.store._db.execute('SELECT metadata_json FROM task_artifacts WHERE task_id=? AND candidate_id=?',
                        (task['id'], candidate_id)).fetchone()[0])
                record.update(title=metadata.get('title') or record['title'], caption=metadata.get('caption', ''))
                record.update(status='completed', artifactId=registration['artifactId'], error=None)
                checkpoint()
                continue
            record.update(status='running', error=None)
            checkpoint()
            def progress(data):
                self.events.emit('task.progress', {'phase': data.get('phase', 'downloading'),
                    'current': index, 'total': len(items), 'message': f'正在处理 {index + 1} / {len(items)}',
                    **{k: v for k, v in data.items() if k in {'downloaded_bytes', 'total_bytes'}}}, task['id'])
            try:
                if source['sourceKind'] == 'public':
                    with self.public_queue.lease(task['id'], handle['cancel'].is_set):
                        download_context = self.core.DownloadContext(
                            Path(context['artifactStagingRoot']), Path(context['scratchRoot']), Path(context['ffmpegPath']),
                            **({'process_factory': self.process_factory} if self.process_factory else {}))
                        candidate = self.core.download_one(source['publicUrl'], download_context, progress,
                            lambda text: self.logs.write(text, task['id']), handle['cancel'].is_set)
                        if handle['cancel'].is_set():
                            raise ToolboxError('CANCELLED', '操作已停止。')
                        registration = self.store.register(task['id'], task['attempt'], {
                            'candidateId': candidate_id, 'kind': 'video', 'role': 'video',
                            'relpath': self.store.paths.relative(candidate.path),
                            'displayName': candidate.title or source['title'],
                            'metadata': {'title': candidate.title or source['title'], 'sourceKind': 'public',
                                         'publicUrl': source['publicUrl'], 'caption': ''}}, validate_video=self.validate_video)
                        record.update(title=candidate.title or source['title'], caption='')
                else:
                    progress({'phase': 'waiting_browser'})
                    with self.browser.lease(task['id'], handle['cancel'].is_set) as session:
                        session = {**session, 'pageId': source['locator'].get('pageId')}
                        result = self._session_item(source, candidate_id, task, handle, {**context, 'browser': session}, progress, change_state)
                        record.update(title=result.get('title') or source['title'], caption=result.get('caption', ''))
                        registration = self.store.registered(task['id'], candidate_id)
                        if not registration:
                            raise ToolboxError('MEDIA_UNAVAILABLE', '引擎未登记可用的视频结果。')
                record.update(status='completed', artifactId=registration['artifactId'], error=None)
            except Exception as exc:
                if handle['cancel'].is_set() or getattr(exc, 'code', None) == 'CANCELLED':
                    record.update(status='pending', error=None)
                    checkpoint()
                    return {'state': 'cancelled'}
                error = exc if isinstance(exc, ToolboxError) else ToolboxError(
                    getattr(exc, 'code', 'MEDIA_UNAVAILABLE'), redact(str(exc)) if getattr(exc, 'code', None)
                    else '视频处理失败，可重新读取来源后重试。', retryable=True)
                if self.store.task(task['id'])['state'] == 'waiting_user':
                    change_state('running')
                record.update(status='failed', error=error.as_dict())
                self.logs.write(str(error), task['id'], 'warning')
            checkpoint()
        failures = sum(item['status'] == 'failed' for item in state['items'])
        successes = sum(item['status'] == 'completed' for item in state['items'])
        return {'state': 'completed_with_errors' if failures and successes else 'failed' if failures else 'completed'}

    def _session_item(self, source, candidate_id, task, handle, context, progress, change_state):
        with NodeWorker(self.node, self.entrypoint, on_log=lambda line: self.logs.write(line, task['id']), test_adapter=self.test_adapter) as worker:
            handle['worker'] = worker
            try:
                request_id = worker.send('download_item', context=context, parameters={'item': source, 'candidateId': candidate_id})
                while True:
                    if handle['cancel'].is_set():
                        raise ToolboxError('CANCELLED', '操作已停止。')
                    try:
                        message = worker.receive(.2)
                    except queue.Empty:
                        continue
                    if message.get('requestId') != request_id:
                        continue
                    kind, data = message['type'], message.get('data', {})
                    if kind == 'artifact_candidate':
                        try:
                            result = self.store.register(task['id'], task['attempt'], data, validate_video=self.validate_video)
                            response = {'candidateId': data['candidateId'], **result}
                            self.events.emit('task.artifact', result, task['id'])
                        except ToolboxError as exc:
                            response = {'candidateId': data['candidateId'], 'error': exc.as_dict()}
                        worker.send('artifact_result', task_id=task['id'], attempt=task['attempt'], data=response)
                    elif kind == 'artifact_lookup':
                        worker.send('artifact_result', task_id=task['id'], attempt=task['attempt'], data={
                            'candidateId': data['candidateId'], 'registration': self.store.registered(task['id'], data['candidateId'])})
                    elif kind == 'artifact_metadata':
                        try:
                            if type(data) is not dict or data.keys() != {'candidateId', 'metadata'}:
                                raise ToolboxError('INVALID_PARAMETERS', '结果元数据消息格式无效。')
                            updated = self.store.update_metadata(task['id'], task['attempt'], data['candidateId'], data['metadata'])
                            response = {'candidateId': data['candidateId'], **updated}
                            self.events.emit('task.artifact', updated, task['id'])
                        except ToolboxError as exc:
                            response = {'candidateId': data.get('candidateId') if isinstance(data, dict) else None, 'error': exc.as_dict()}
                        worker.send('artifact_result', task_id=task['id'], attempt=task['attempt'], data=response)
                    elif kind == 'progress':
                        progress(data)
                    elif kind == 'state':
                        if not handle['cancel'].is_set():
                            change_state(data['state'], data.get('message'))
                    elif kind == 'log':
                        self.logs.write(data.get('message', ''), task['id'])
                    elif kind == 'error':
                        raise ToolboxError(data.get('code', 'MEDIA_UNAVAILABLE'), redact(data.get('message', '视频下载失败。')))
                    elif kind == 'result':
                        return data
            finally:
                handle['worker'] = None
