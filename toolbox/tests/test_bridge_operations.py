import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

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

    def call_with_messages(self, messages, kind='discover', tool_id='business-center'):
        worker = MagicMock()
        worker.__enter__.return_value = worker
        worker.send.return_value = 'fixture-request'
        worker.receive.side_effect = messages
        with patch('toolbox.host.operations.NodeWorker', return_value=worker):
            return self.operations._call(kind, {}, {'toolId': tool_id, 'operationId': 'fixture-operation'})

    def test_business_discover_reassembles_over_one_mib_of_required_categories(self):
        categories = [{'displayPath': f'电商一级类目 / 二级商品分类 / 商品三级类目{index}',
                       'segments': ['电商一级类目', '二级商品分类', f'商品三级类目{index}'],
                       'valuePath': ['100', '200', str(index)]} for index in range(10000)]
        self.assertGreater(len(json.dumps(categories, ensure_ascii=False).encode('utf-8')), 1024 * 1024)
        messages = [{'requestId': 'fixture-request', 'type': 'options_chunk',
                     'data': {'field': 'categories', 'items': categories[offset:offset + 50]}}
                    for offset in range(0, len(categories), 50)]
        messages.append({'requestId': 'fixture-request', 'type': 'result',
                         'data': {'categories': [], 'discoveredAt': '2026-10-12T00:00:00Z'}})
        result = self.call_with_messages(messages)
        self.assertEqual(result, {'categories': categories, 'discoveredAt': '2026-10-12T00:00:00Z'})
        self.assertEqual(self.store.list_tasks()['total'], 0)
        self.assertEqual(self.events.read()['events'], [])

    def test_options_chunks_reject_wrong_operation_or_tool(self):
        item = {'displayPath': '测试', 'segments': ['测试'], 'valuePath': ['1']}
        message = {'requestId': 'fixture-request', 'type': 'options_chunk',
                   'data': {'field': 'categories', 'items': [item]}}
        for kind, tool_id in [('capture_page', 'business-center'), ('read_results', 'business-center'), ('discover', 'top200')]:
            with self.subTest(kind=kind, tool_id=tool_id), self.assertRaises(ToolboxError) as caught:
                self.call_with_messages([message], kind, tool_id)
            self.assertEqual(caught.exception.code, 'WORKER_PROTOCOL_ERROR')

    def test_options_chunks_reject_invalid_shapes_and_mixed_final_result(self):
        item = {'displayPath': '测试', 'segments': ['测试'], 'valuePath': ['1']}
        for data in [None, {'field': 'unexpected', 'items': [item]}, {'field': 'categories', 'items': []},
                     {'field': 'categories', 'items': [item] * 51}, {'field': 'categories', 'items': [{}]}]:
            with self.subTest(data=data), self.assertRaises(ToolboxError) as caught:
                self.call_with_messages([{'requestId': 'fixture-request', 'type': 'options_chunk', 'data': data}])
            self.assertEqual(caught.exception.code, 'WORKER_PROTOCOL_ERROR')
        chunk = {'requestId': 'fixture-request', 'type': 'options_chunk', 'data': {'field': 'categories', 'items': [item]}}
        with self.assertRaises(ToolboxError) as caught:
            self.call_with_messages([chunk, {'requestId': 'fixture-request', 'type': 'result', 'data': {'categories': [item]}}])
        self.assertEqual(caught.exception.code, 'WORKER_PROTOCOL_ERROR')

    def test_options_chunks_reject_over_ten_thousand_categories(self):
        item = {'displayPath': '测试', 'segments': ['测试'], 'valuePath': ['1']}
        chunk = {'requestId': 'fixture-request', 'type': 'options_chunk', 'data': {'field': 'categories', 'items': [item] * 50}}
        with self.assertRaises(ToolboxError) as caught:
            self.call_with_messages([chunk] * 201)
        self.assertEqual(caught.exception.code, 'WORKER_PROTOCOL_ERROR')

    def test_options_chunks_ignore_other_request_and_small_results_stay_compatible(self):
        result = {'categories': [{'displayPath': '测试', 'segments': ['测试'], 'valuePath': ['1']}]}
        messages = [{'requestId': 'other-request', 'type': 'options_chunk', 'data': None},
                    {'requestId': 'fixture-request', 'type': 'result', 'data': result}]
        self.assertEqual(self.call_with_messages(messages), result)

    def test_options_chunk_error_does_not_return_partial_categories(self):
        messages = [{'requestId': 'fixture-request', 'type': 'options_chunk',
                     'data': {'field': 'categories', 'items': [{'displayPath': '测试', 'segments': ['测试'], 'valuePath': ['1']}]}},
                    {'requestId': 'fixture-request', 'type': 'error',
                     'data': {'code': 'CANCELLED', 'message': 'fixture stopped'}}]
        with self.assertRaises(ToolboxError) as caught:
            self.call_with_messages(messages)
        self.assertEqual(caught.exception.code, 'CANCELLED')
        self.assertEqual(self.events.read()['events'], [])

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

    def test_capture_failed_batch_does_not_publish_temporary_addresses(self):
        with self.assertRaises(ToolboxError):
            self.capture.ingest({'items': [
                {'sourceKey': 'safe', 'sourceKind': 'compass_ranking', 'sourcePage': 'compass_ranking',
                 'mediaUrl': 'https://media.test/?signature=secret'},
                {'sourceKey': 'invalid', 'sourceKind': 'unsupported'},
            ]})
        self.assertEqual(self.capture.list()['total'], 0)
        self.assertEqual(self.capture._temporary, {})

    def test_capture_rejects_non_page_urls_and_normalizes_compass_public_url(self):
        for url in ['ftp://www.douyin.com/video/123', 'https://www.douyin.com/aweme/v1/play?signature=secret']:
            with self.subTest(url=url), self.assertRaises(ToolboxError):
                self.capture.ingest({'items':[{'sourceKey':'safe','sourceKind':'public','publicUrl':url}]})
        self.capture.ingest({'items':[{'sourceKey':'compass:video:123','sourceKind':'compass_ranking',
            'sourcePage':'compass_ranking','publicUrl':'https://www.douyin.com/video/123/?signature=tracking'}]})
        self.assertEqual(self.capture.list()['items'][0]['publicUrl'],'https://www.douyin.com/video/123')

    def test_capture_source_page_query_is_not_saved_and_refresh_clears_stale_media(self):
        item = {'sourceKey': 'safe', 'sourceKind': 'compass_ranking',
                'sourcePage': 'https://compass.jinritemai.com/shop?signature=secret#secret',
                'mediaUrl': 'https://media.test/?signature=secret'}
        self.capture.ingest({'items': [item]})
        self.assertEqual(self.capture.list()['items'][0]['sourcePage'], 'https://compass.jinritemai.com/shop')
        del item['mediaUrl']
        self.capture.ingest({'items': [item]})
        self.assertFalse(self.capture.list()['items'][0]['temporaryAvailable'])

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
