import json
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from toolbox.host.errors import ToolboxError
from toolbox.host.events import Events
from toolbox.host.logs import Logs
from toolbox.host.manual import ManualDownloads
from toolbox.host.paths import DataPaths
from toolbox.host.scheduler import TaskScheduler
from toolbox.host.store import Store
from toolbox.tests.test_runtime import FixtureBrowser


class FakeCore:
    DownloadContext = lambda self, *args, **kwargs: SimpleNamespace(output=args[0], scratch=args[1])
    def __init__(self):
        self.calls = []
        self.fail = set()
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()

    def download_one(self, url, context, progress, log, cancelled):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.calls.append(url)
        try:
            for _ in range(10):
                if cancelled():
                    raise ToolboxError('CANCELLED', '停止')
                time.sleep(.005)
            if url in self.fail:
                raise ToolboxError('NETWORK_ERROR', 'fixture network failure')
            file = context.output / 'sample.mp4'
            file.write_bytes(url.encode())
            return SimpleNamespace(path=file, title='公开标题')
        finally:
            with self.lock:
                self.active -= 1


class ManualTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-manual-')
        self.paths = DataPaths(Path(self.temp.name))
        self.store = Store(self.paths)
        self.events, self.browser = Events(), FixtureBrowser()
        self.core = FakeCore()
        logs = Logs(self.paths)
        entry = Path(__file__).parents[1] / 'node/worker.cjs'
        self.manual = ManualDownloads(self.store, self.events, logs, self.browser, core=self.core,
            node=shutil.which('node'), entrypoint=entry, validate_video=lambda p: None, test_adapter=True)
        self.scheduler = TaskScheduler(self.store, self.events, logs, self.browser, node=shutil.which('node'),
            entrypoint=entry, ffmpeg='', descriptors={'manual-video': {'available': True, 'supportsResume': True,
                'supportsRetryFailed': True}}, validate_video=lambda p: None, runners={'manual-video': self.manual})

    def tearDown(self):
        self.scheduler.shutdown()
        self.store.close()
        self.temp.cleanup()

    def item(self, name, kind='public'):
        return {'id': name, 'title': name, 'publicUrl': 'https://v.douyin.com/' + name,
                'sourceKind': kind, 'locator': {'pageId': 'fixture'}}

    def wait(self, task):
        deadline = time.monotonic() + 8
        while task['id'] in self.scheduler._runs and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertNotIn(task['id'], self.scheduler._runs)
        return self.store.task(task['id'])

    def test_session_worker_metadata_protocol_updates_only_registered_reference(self):
        source = {**self.item('session', 'compass_ranking'), 'metadataRoundtrip': True}
        task = self.scheduler.create('manual-video', {'items': [source]})
        self.assertEqual(self.wait(task)['state'], 'completed')
        self.assertEqual(self.store.artifacts(task['id'])['items'][0]['metadata']['caption'], '补全会话文案')

    def test_mixed_items_have_one_state_and_only_session_uses_browser(self):
        task = self.scheduler.create('manual-video', {'items': [self.item('public'), self.item('session', 'compass_ranking')]})
        self.assertEqual(self.wait(task)['state'], 'completed')
        self.assertEqual(self.browser.order, [task['id']])
        self.assertEqual(len(self.core.calls), 1)
        self.assertEqual(self.store.artifacts(task['id'])['total'], 2)
        state = json.loads(self.paths.resolve(f"tasks/{task['id']}/engine-state.json").read_text(encoding='utf-8'))
        self.assertEqual([i['status'] for i in state['state']['items']], ['completed', 'completed'])
        self.assertEqual(state['state']['items'][0]['title'], '公开标题')
        self.assertEqual(len(list(self.paths.resolve(f"tasks/{task['id']}").glob('*.json'))), 1)

    def test_retry_skips_registered_successful_items(self):
        self.core.fail.add('https://v.douyin.com/bad')
        task = self.scheduler.create('manual-video', {'items': [self.item('good'), self.item('bad')]})
        self.assertEqual(self.wait(task)['state'], 'completed_with_errors')
        self.core.fail.clear()
        self.scheduler.control(task['id'], 'retry_failed')
        self.assertEqual(self.wait(task)['state'], 'completed')
        self.assertEqual(self.core.calls.count('https://v.douyin.com/good'), 1)
        self.assertEqual(self.store.artifacts(task['id'])['total'], 2)

    def test_public_downloads_are_serial_and_do_not_hold_shop_browser(self):
        with self.browser.queue.lease('existing-shop-task'):
            first = self.scheduler.create('manual-video', {'items': [self.item('one')]})
            second = self.scheduler.create('manual-video', {'items': [self.item('two')]})
            self.assertEqual(self.wait(first)['state'], 'completed')
            self.assertEqual(self.wait(second)['state'], 'completed')
        self.assertEqual(self.core.max_active, 1)
        self.assertEqual(self.browser.order, [])

    def test_cancel_preserves_completed_items_and_recovery_skips_them(self):
        task = self.scheduler.create('manual-video', {'items': [self.item(str(i)) for i in range(20)]})
        deadline = time.monotonic() + 5
        while self.store.artifacts(task['id'])['total'] < 1 and time.monotonic() < deadline:
            time.sleep(.01)
        self.scheduler.control(task['id'], 'cancel')
        self.assertEqual(self.wait(task)['state'], 'cancelled')
        before = self.store.artifacts(task['id'])['total']
        self.assertGreater(before, 0)
        self.scheduler.control(task['id'], 'resume')
        self.assertEqual(self.wait(task)['state'], 'completed')
        self.assertEqual(self.core.calls.count('https://v.douyin.com/0'), 1)
        self.assertEqual(self.store.artifacts(task['id'])['total'], 20)

    def test_cancel_during_progress_update_preserves_stopping_state(self):
        entered, release = threading.Event(), threading.Event()
        update_progress = self.store.update_progress
        blocked = False

        def delayed_update(*args, **kwargs):
            nonlocal blocked
            if not blocked:
                blocked = True
                entered.set()
                if not release.wait(5):
                    raise AssertionError('progress barrier timed out')
            return update_progress(*args, **kwargs)

        try:
            with patch.object(self.store, 'update_progress', side_effect=delayed_update):
                task = self.scheduler.create('manual-video', {'items': [self.item('progress-race')]})
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.scheduler.control(task['id'], 'cancel')['state'], 'stopping')
                release.set()
                self.assertEqual(self.wait(task)['state'], 'cancelled')
                self.assertEqual(self.core.calls, [])
        finally:
            release.set()

    def test_cancel_ignores_late_waiting_user_state(self):
        entered, release = threading.Event(), threading.Event()
        callback_errors = []

        def session_item(source, candidate_id, task, handle, context, progress, change_state):
            entered.set()
            if not release.wait(5):
                raise AssertionError('session barrier timed out')
            try:
                change_state('waiting_user')
            except Exception as exc:
                callback_errors.append(exc)
                raise
            raise ToolboxError('CANCELLED', 'fixture cancelled')

        try:
            with patch.object(self.manual, '_session_item', side_effect=session_item):
                task = self.scheduler.create('manual-video', {'items': [self.item('state-race', 'compass_ranking')]})
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.scheduler.control(task['id'], 'cancel')['state'], 'stopping')
                release.set()
                self.assertEqual(self.wait(task)['state'], 'cancelled')
                self.assertEqual(callback_errors, [])
                states = [event['data']['state'] for event in self.events.read()['events']
                          if event['type'] == 'task.state' and event.get('taskId') == task['id']]
                self.assertNotIn('waiting_user', states)
        finally:
            release.set()

    def test_candidate_cleanup_failure_keeps_registered_success(self):
        unlink = Path.unlink
        cleanup_blocked = False

        def occupied_candidate(path, *args, **kwargs):
            nonlocal cleanup_blocked
            if not cleanup_blocked and path.name == 'sample.mp4' and 'staging' in path.parts:
                cleanup_blocked = True
                raise PermissionError('fixture candidate occupied after registration')
            return unlink(path, *args, **kwargs)

        with patch.object(Path, 'unlink', occupied_candidate):
            task = self.scheduler.create('manual-video', {'items': [self.item('cleanup-busy')]})
            self.assertEqual(self.wait(task)['state'], 'completed')
        self.assertTrue(cleanup_blocked)
        registered = self.store.registered(task['id'], 'manual:cleanup-busy')
        self.assertIsNotNone(registered)
        self.assertTrue(self.store.artifact_path(registered['artifactId']).is_file())
