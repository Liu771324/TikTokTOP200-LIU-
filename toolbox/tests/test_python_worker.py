"""Python worker control, identity and legacy record compatibility; no platform access."""
import io
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from toolbox.host.errors import ToolboxError
from toolbox.host.events import Events
from toolbox.host.logs import Logs
from toolbox.host.paths import DataPaths
from toolbox.host.scheduler import TaskScheduler
from toolbox.host.state import save_state
from toolbox.host.store import Store
from toolbox.host.worker import PythonWorker
from toolbox.python_worker import Cancelled, Runtime, WorkerApi


def until(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError('worker did not reach expected state')


class PythonProtocolTests(unittest.TestCase):
    def test_pause_resume_then_stop_preserves_last_safe_checkpoint(self):
        with tempfile.TemporaryDirectory(prefix='python-worker-') as folder:
            context = {'protocolVersion': 1, 'toolId': 'business-center', 'taskId': 'a' * 32,
                       'attempt': 1, 'statePath': str(Path(folder) / 'engine-state.json')}
            events = []
            api = WorkerApi(context, lambda kind, data: events.append((kind, data)), 'run')
            counts, failure = [], []

            def run():
                try:
                    for i in range(1000):
                        api.boundary()
                        counts.append(i)
                        api.checkpoint({'engine': 'business-python-v1', 'done': i})
                        time.sleep(.01)
                except Cancelled:
                    api.checkpoint({'engine': 'business-python-v1', 'done': counts[-1], 'stopped': True})
                except BaseException as exc:
                    failure.append(exc)

            thread = threading.Thread(target=run)
            thread.start()
            until(lambda: len(counts) >= 2)
            api.command_control('pause')
            until(lambda: ('state', {'state': 'paused'}) in events)
            paused_count = len(counts)
            time.sleep(.04)
            self.assertEqual(len(counts), paused_count)
            api.command_control('resume')
            until(lambda: len(counts) > paused_count)
            api.command_control('cancel')
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failure, [])
            saved = json.loads(Path(context['statePath']).read_text(encoding='utf-8'))
            self.assertEqual(saved['taskId'], context['taskId'])
            self.assertEqual(saved['state']['done'], counts[-1])
            self.assertTrue(saved['state']['stopped'])

    def test_wrong_attempt_cannot_cancel_active_worker(self):
        started, finish = threading.Event(), threading.Event()

        def run(parameters, context, api):
            started.set()
            finish.wait(3)
            return {'state': 'cancelled' if api.control.cancelled else 'completed'}

        output = io.BytesIO()
        runtime = Runtime(output, SimpleNamespace(run=run))
        context = {'protocolVersion': 1, 'toolId': 'business-center', 'taskId': 'b' * 32, 'attempt': 2}
        runtime.handle({'protocolVersion': 1, 'type': 'run', 'requestId': 'run', 'context': context})
        started.wait(3)
        thread = runtime.active['thread']
        runtime.handle({'protocolVersion': 1, 'type': 'cancel', 'requestId': 'old', 'taskId': 'b' * 32, 'attempt': 1})
        self.assertFalse(runtime.active['api'].control.cancelled)
        finish.set()
        thread.join(3)
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(next(m for m in messages if m['requestId'] == 'old')['type'], 'error')
        self.assertEqual(next(m for m in messages if m['type'] == 'result')['data']['state'], 'completed')

    def test_short_operation_cannot_write_task_or_register_report(self):
        api = WorkerApi({}, lambda *args: None, 'discover')
        with self.assertRaises(ToolboxError):
            api.checkpoint({})
        with self.assertRaises(ToolboxError):
            api.register({'candidateId': 'x'})

    def test_stopping_task_can_register_partial_report(self):
        events = []
        api = WorkerApi({}, lambda kind, data: events.append((kind, data)), 'run')
        api.command_control('cancel')
        results = []
        thread = threading.Thread(target=lambda: results.append(api.register({'candidateId': 'report'})))
        thread.start()
        until(lambda: bool(events))
        api.reply_artifact({'candidateId': 'report', 'artifactId': 'c' * 32})
        thread.join(2)
        self.assertEqual(results[0]['artifactId'], 'c' * 32)

    def test_real_python_child_reads_legacy_record_without_browser(self):
        with tempfile.TemporaryDirectory(prefix='legacy-business-') as folder:
            context = {'protocolVersion': 1, 'toolId': 'business-center', 'taskId': 'd' * 32,
                       'attempt': 1, 'statePath': str(Path(folder) / 'engine-state.json'), 'browser': None}
            state = {'taskId': context['taskId'], 'results': [{'productName': '历史商品', 'keyword': '核桃仁'}],
                     'failures': [], 'unparseableItems': [], 'combinations': [], 'stats': {}}
            save_state(context['statePath'], context, state)
            with PythonWorker() as worker:
                request_id = worker.send('read_results', context=context, parameters={})
                while True:
                    response = worker.receive(5)
                    if response.get('requestId') == request_id and response['type'] in {'result', 'error'}:
                        break
                self.assertEqual(response['type'], 'result', response)
                self.assertEqual(response['data']['items'][0]['productName'], '历史商品')

    def test_frozen_child_uses_executable_worker_entry(self):
        with patch('toolbox.host.worker.sys.frozen', True, create=True), patch('toolbox.host.worker.NodeWorker.__init__', return_value=None) as init:
            PythonWorker()
        self.assertEqual(init.call_args.kwargs['command'][1:], ['--business-worker'])

    def test_legacy_resume_rejected_before_task_state_changes(self):
        with tempfile.TemporaryDirectory(prefix='legacy-guard-') as folder:
            store = Store(DataPaths(Path(folder)))
            scheduler = TaskScheduler(store, Events(), Logs(store.paths), None, node='', entrypoint='', ffmpeg='',
                descriptors={'business-center': {'available': True, 'engine': 'python', 'supportsResume': True}},
                validate_video=lambda path: None)
            try:
                task = store.create_task('business-center', {})
                store.transition(task['id'], 'running', attempt=1)
                store.transition(task['id'], 'interrupted', attempt=1)
                context = store.paths.task_context(store.task(task['id']), '')
                save_state(context['statePath'], context, {'taskId': task['id'], 'results': []})
                with self.assertRaises(ToolboxError) as caught:
                    scheduler.control(task['id'], 'resume')
                self.assertEqual(caught.exception.code, 'STATE_INCOMPATIBLE')
                self.assertEqual(store.task(task['id'])['state'], 'interrupted')
            finally:
                scheduler.shutdown()
                store.close()
