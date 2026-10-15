import hashlib
import json
import shutil
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from toolbox.host.bridge import Bridge
from toolbox.host.errors import ToolboxError
from toolbox.host.events import Events
from toolbox.host.files import Files
from toolbox.host.logs import Logs
from toolbox.host.operations import Operations
from toolbox.host.paths import DataPaths, atomic_json
from toolbox.host.scheduler import TaskScheduler
from toolbox.host.store import Store
from toolbox.host.titles import Titles


def plan_fixture():
    return {'engine': 'product-title-v1', 'fileName': '标题.xlsx', 'inputSha256': '1' * 64,
        'shops': [{'id': '11', 'name': '样本店'}], 'productStatus': {'value': '', 'label': '所有'},
        'groups': [{'original': '原标题', 'titleCount': 1, 'productCount': 1, 'unused': 0}],
        'items': [{'id': '123', 'shopId': '11', 'shopName': '样本店', 'original': '原标题',
            'before': '原标题', 'target': '新标题', 'excelRow': 2, 'order': 1, 'status': 'pending'}],
        'summary': {'productCount': 1, 'changeCount': 1}}


class TitleHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-title-')
        self.paths = DataPaths(Path(self.temp.name) / '数据')
        self.store = Store(self.paths)
        self.app = SimpleNamespace(store=self.store, window=Mock(), logs=Mock(),
            scheduler=SimpleNamespace(_lock=threading.RLock(), create=Mock(return_value={'id': 'a' * 32})),
            operations=SimpleNamespace(_lock=threading.RLock(), _call=Mock(return_value={'groupCount': 1}), submit=Mock()))
        self.titles = self.app.titles = Titles(self.app)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def receive(self, plan=None):
        operation_id = 'b' * 32
        path = self.paths.resolve('scratch/operation-' + operation_id + '/plan.json')
        atomic_json(path, plan or plan_fixture())
        return self.titles.receive_plan({'planPath': str(path)}, {'operationId': operation_id})

    def test_native_input_uses_snapshot_and_opaque_id(self):
        source = Path(self.temp.name) / '我的标题.xls'
        source.write_bytes(b'fixture workbook')
        self.app.window.create_file_dialog.return_value = [str(source)]
        webview = SimpleNamespace(FileDialog=SimpleNamespace(OPEN=1))
        with patch.dict('sys.modules', {'webview': webview}):
            result = self.titles.choose_input()
        args = self.app.operations._call.call_args.args
        self.assertEqual(args[0], 'title_input')
        self.assertEqual(Path(args[1]['inputPath']).read_bytes(), source.read_bytes())
        self.assertNotEqual(Path(args[1]['inputPath']), source)
        self.assertEqual(args[1]['inputSha256'], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(result['fileName'], source.name)
        self.assertNotIn('inputPath', result)
        self.assertEqual(len(result['inputId']), 32)

    def test_real_worker_reads_native_selected_workbook_without_browser(self):
        from openpyxl import Workbook
        source = Path(self.temp.name) / '中文样本.xlsx'
        workbook = Workbook()
        workbook.active.title = 'Sheet1'
        workbook.active.append(['原标题', '新标题'])
        workbook.active.append(['原标题', '新标题'])
        workbook.save(source)
        self.app.operations = Operations(self.store, Events(), Logs(self.paths), Mock(), node=shutil.which('node'),
            entrypoint=Path(__file__).resolve().parents[1] / 'node/worker.cjs',
            descriptors={'product-title': {'available': True, 'engine': 'node'}})
        self.app.window.create_file_dialog.return_value = [str(source)]
        with patch.dict('sys.modules', {'webview': SimpleNamespace(FileDialog=SimpleNamespace(OPEN=1))}):
            result = self.titles.choose_input()
        self.assertEqual(result['titleCount'], 1)
        self.assertEqual(result['groups'][0]['titles'], ['新标题'])
        self.app.operations.browser.lease.assert_not_called()

    def test_cancelled_native_selection_keeps_current_approval(self):
        approved = self.receive()
        self.app.window.create_file_dialog.return_value = None
        with patch.dict('sys.modules', {'webview': SimpleNamespace(FileDialog=SimpleNamespace(OPEN=1))}):
            self.assertTrue(self.titles.choose_input()['cancelled'])
        self.assertEqual(self.titles.plan_page(approved['token'])['total'], 1)

    def test_plan_paths_counts_duplicates_and_scope_are_checked(self):
        with self.assertRaises(ToolboxError):
            self.titles.receive_plan({'planPath': str(Path(self.temp.name) / 'outside')}, {'operationId': 'b' * 32})
        for mutate in (lambda plan: plan['items'].append(dict(plan['items'][0])),
                       lambda plan: plan['summary'].update(changeCount=2),
                       lambda plan: plan['items'][0].update(shopId='999')):
            plan = plan_fixture()
            mutate(plan)
            with self.subTest(plan=plan), self.assertRaises(ToolboxError):
                self.receive(plan)

    def test_confirmation_single_use_expiry_and_tamper(self):
        approved = self.receive()
        self.app.window.create_confirmation_dialog.return_value = False
        self.assertTrue(self.titles.create(approved['token'])['cancelled'])
        self.app.scheduler.create.assert_not_called()
        self.app.window.create_confirmation_dialog.return_value = True
        self.assertEqual(self.titles.create(approved['token'])['taskId'], 'a' * 32)
        with self.assertRaises(ToolboxError):
            self.titles.create(approved['token'])
        approved = self.receive()
        record = self.titles._plans[approved['token']]
        record['expires'] = time.monotonic() - 1
        with self.assertRaises(ToolboxError):
            self.titles.create(approved['token'])
        approved = self.receive()
        record = self.titles._plans[approved['token']]
        plan = json.loads(record['path'].read_text(encoding='utf-8'))
        plan['items'][0]['target'] = '未经预览的标题'
        atomic_json(record['path'], plan)
        with self.assertRaises(ToolboxError):
            self.titles.create(approved['token'])

    def test_bridge_rejects_untrusted_ui_and_direct_write_creation(self):
        self.app.window.get_current_url.return_value = 'http://trusted/'
        bridge = Bridge(self.app, 'http://trusted/')
        result = bridge.invoke('tasks.create', {'toolId': 'product-title', 'parameters': {}})
        self.assertFalse(result['ok'])
        self.app.scheduler.create.assert_not_called()
        self.app.window.get_current_url.return_value = 'https://untrusted/'
        self.assertFalse(bridge.invoke('title.choose_input')['ok'])
        self.app.window.create_file_dialog.assert_not_called()

    def test_active_plan_and_preview_inputs_survive_cache_cleanup(self):
        plan_id = 'a' * 32
        task = self.store.create_task('product-title', {'planId': plan_id, 'planSha256': 'b' * 64})
        active = self.paths.resolve('scratch/title-plan-' + plan_id + '/plan.json')
        source = self.paths.resolve('scratch/title-import-' + 'c' * 32 + '/input.xlsx')
        atomic_json(active, {})
        source.parent.mkdir()
        source.write_bytes(b'sample')
        Files(self.store).clean_cache(operations_active=True)
        self.assertTrue(active.exists())
        self.assertTrue(source.exists())
        Files(self.store).clean_cache()
        self.assertTrue(active.exists())
        self.assertFalse(source.exists())
        self.store.transition(task['id'], 'cancelled', attempt=1)
        Files(self.store).clean_cache()
        self.assertFalse(active.exists())

    def test_restart_never_schedules_queued_title_writes(self):
        title = self.store.create_task('product-title', {'planId': 'a' * 32, 'planSha256': 'b' * 64})
        scheduler = TaskScheduler(self.store, Events(), Logs(self.paths), Mock(), node=None, entrypoint=None,
            ffmpeg='', descriptors={'product-title': {'available': True}}, validate_video=None)
        self.assertEqual(self.store.task(title['id'])['state'], 'failed')
        self.assertEqual(scheduler._runs, {})

    def test_title_stop_allows_bounded_current_submission_verification(self):
        task = self.store.create_task('product-title', {})
        scheduler = TaskScheduler(self.store, Events(), Logs(self.paths), Mock(), node=None, entrypoint=None,
            ffmpeg='', descriptors={'product-title': {'available': True}}, validate_video=None)
        # The restart rule has failed this fixture; place a fresh running task.
        task = self.store.create_task('product-title', {})
        self.store.transition(task['id'], 'running', attempt=1)
        handle = {'cancel': threading.Event(), 'worker': Mock(), 'deadline': None}
        scheduler._runs[task['id']] = handle
        scheduler.control(task['id'], 'cancel')
        self.assertGreater(handle['deadline'] - time.monotonic(), 70)
        self.assertEqual(self.store.task(task['id'])['state'], 'stopping')
        handle['worker'].send.assert_called_once()
        self.assertFalse(scheduler.descriptors['product-title'].get('supportsResume'))


if __name__ == '__main__':
    unittest.main()
