import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from toolbox.host.application import load_core
from toolbox.host.bridge import Bridge
from toolbox.host.capture import Capture
from toolbox.host.errors import ToolboxError
from toolbox.host.events import Events
from toolbox.host.logs import Logs
from toolbox.host.operations import Operations
from toolbox.host.paths import DataPaths
from toolbox.host.store import Store
from toolbox.tests.test_runtime import FixtureBrowser


class BridgeOperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-operations-')
        self.paths = DataPaths(Path(self.temp.name))
        self.store = Store(self.paths)
        self.events, self.browser = Events(), FixtureBrowser()
        self.capture = Capture(self.store, self.events, load_core())
        self.operations = Operations(self.store, self.events, Logs(self.paths), self.browser,
            node=shutil.which('node'), entrypoint=Path(__file__).parents[1] / 'node/worker.cjs',
            descriptors={'top200': {'available': True}, 'manual-video': {'available': True}},
            on_capture=self.capture.ingest, test_adapter=True)

    def tearDown(self):
        self.operations.shutdown()
        self.store.close()
        self.temp.cleanup()

    def until_done(self, operation_id):
        deadline = time.monotonic() + 8
        while operation_id in self.operations._runs and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertNotIn(operation_id, self.operations._runs)
        return next(e['data'] for e in self.events.read()['events']
                    if e['type'] == 'operation.state' and e['data']['operationId'] == operation_id
                    and e['data']['state'] in {'completed', 'failed'})

    def test_discover_fifo_waits_behind_task_resource_without_creating_task(self):
        with self.browser.queue.lease('existing-task'):
            first = self.operations.submit('discover', 'top200', {})['operationId']
            second = self.operations.submit('discover', 'top200', {})['operationId']
            self.assertEqual([t['owner'] for t in self.browser.queue.state()['waiting']], [first, second])
            self.assertEqual(self.browser.order, [])
        self.assertEqual(self.until_done(first)['state'], 'completed')
        self.assertEqual(self.until_done(second)['state'], 'completed')
        self.assertEqual(self.browser.order, [first, second])
        self.assertEqual(self.store.list_tasks()['total'], 0)

    def test_capture_temporary_media_not_in_database_or_interface_events(self):
        operation_id = self.operations.submit('capture_page', 'manual-video', {'pageId': 'fixture-page'})['operationId']
        self.assertEqual(self.until_done(operation_id)['state'], 'completed')
        item = self.capture.list()['items'][0]
        self.assertTrue(item['temporaryAvailable'])
        persistent = json.dumps([dict(r) for r in self.store._db.execute('SELECT * FROM capture_items')])
        self.assertNotIn('signature', persistent)
        self.assertNotIn('secret', json.dumps(self.events.read()))
        reopened = Capture(self.store, self.events, load_core())
        self.assertFalse(reopened.list()['items'][0]['temporaryAvailable'])
        self.assertEqual(reopened.list()['items'][0]['title'], item['title'])

    def test_public_input_deduplicates_and_task_snapshot_survives_removal(self):
        result = self.capture.add_text('分享 https://v.douyin.com/fixture/ https://v.douyin.com/fixture/ https://evil.test/video')
        self.assertEqual(result['added'], 1)
        self.assertEqual(result['rejectedCount'], 1)
        item = self.capture.list()['items'][0]
        task = self.store.create_task('manual-video', {'items': self.capture.selected([item['id']])})
        self.capture.remove([item['id']])
        self.assertEqual(self.capture.list()['total'], 0)
        self.assertEqual(self.store.task(task['id'])['parameters']['items'][0]['title'], item['title'])

    def test_capture_rejects_media_url_in_locator(self):
        with self.assertRaises(ToolboxError):
            self.capture.ingest({'items': [{'sourceKey': 'fixture', 'sourceKind': 'compass_ranking',
                                          'locator': {'videoKey': 'https://media.test/?signature=secret'}}]})
        self.assertEqual(self.capture.list()['total'], 0)

    def test_read_results_does_not_take_browser_or_create_directories(self):
        task = self.store.create_task('top200', {})
        context = self.paths.task_context(task, '')
        from toolbox.host.state import save_state
        save_state(context['statePath'], context, {'count': 8})
        before = {str(p) for p in self.paths.root.rglob('*')}
        with self.browser.queue.lease('long-running-task'):
            result = self.operations.results(task['id'])
        self.assertEqual(result, {'items': [{'count': 8}], 'total': 1})
        self.assertEqual(self.browser.order, [])
        self.assertEqual({str(p) for p in self.paths.root.rglob('*')}, before)

    def test_bridge_rejects_remote_page_unknown_action_and_extra_parameters(self):
        app = SimpleNamespace(window=SimpleNamespace(get_current_url=lambda: 'https://foreign.test'))
        bridge = Bridge(app, 'http://127.0.0.1:1234/own/index.html')
        self.assertFalse(bridge.invoke('app.get_state')['ok'])
        app.window.get_current_url = lambda: 'http://127.0.0.1:1234/own/index.html'
        self.assertFalse(bridge.invoke('execute', {'command': 'anything'})['ok'])
        self.assertFalse(bridge.invoke('artifacts.open', {'artifactId': 'id', 'path': 'outside'})['ok'])
        self.assertFalse(bridge.invoke('__dict__')['ok'])
