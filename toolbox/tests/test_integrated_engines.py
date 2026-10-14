"""Real worker protocol and release-layout tests, with no browser or platform IO."""
import copy
import hashlib
import json
import os
import queue
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from toolbox.host.errors import ToolboxError
from toolbox.host.events import Events
from toolbox.host.logs import Logs
from toolbox.host.operations import Operations
from toolbox.host.paths import DataPaths
from toolbox.host.resources import ResourceQueue
from toolbox.host.state import save_state
from toolbox.host.store import Store
from toolbox.host.worker import NodeWorker, PythonWorker
from toolbox.windows.layout import SOURCE_FILES, validate_sources


REPO = Path(__file__).resolve().parents[2]
HELPER = Path(__file__).with_name('integration-fixtures.cjs')
WORKER = REPO / 'toolbox/node/worker.cjs'
TOOLS = ('business-center', 'top200', 'video-ranking', 'manual-video')


def tree_snapshot(root):
    """Metadata only, avoiding reads of legacy media/report contents."""
    root = Path(root)
    if not root.exists():
        return None
    return sorted((str(item.relative_to(root)), item.is_dir(), item.stat().st_size if item.is_file() else 0,
                   item.stat().st_mtime_ns) for item in root.rglob('*'))


def legacy_snapshot():
    folders = {'business-node': ('data', 'logs', 'reports'), 'top200': ('data', 'logs', 'reports'),
               'video': ('data', 'logs', '视频'), 'business-python': ('data', 'reports', 'checkpoints')}
    return {(project, folder): tree_snapshot(REPO / 'local-archive/legacy-tools' / project / folder)
            for project, names in folders.items() for folder in names}


class IntegratedEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which('node')
        if not cls.node:
            raise RuntimeError('Real Node runtime is required for integrated-engine tests')
        result = subprocess.run([cls.node, str(HELPER), 'fixtures'], capture_output=True,
                                text=True, encoding='utf-8', timeout=30, check=True)
        cls.fixtures = json.loads(result.stdout)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-integrated-engines-')
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)

    def context(self, tool_id, index=1, root=None):
        data_root = Path(root or self.root)
        task_id = f'{index:032x}'
        return {'protocolVersion': 1, 'toolId': tool_id, 'taskId': task_id, 'attempt': 2,
                'dataRoot': str(data_root), 'statePath': str(data_root / 'tasks' / task_id / 'engine-state.json'),
                'scratchRoot': str(data_root / 'scratch' / task_id),
                'artifactStagingRoot': str(data_root / 'tasks' / task_id / 'staging'), 'browser': None}

    def seed(self, context):
        state = copy.deepcopy(self.fixtures[context['toolId']]['state'])
        for key in ('taskId', 'id'):
            if key in state:
                state[key] = context['taskId']
        for row in state.get('results', []):
            if 'taskId' in row:
                row['taskId'] = context['taskId']
        save_state(context['statePath'], {**context, 'attempt': 1}, state)
        return state

    def call(self, tool_id, kind, parameters, context, entrypoint=WORKER, started=True):
        events = []
        # No --test-adapter: the fixed allowlist loads production adapter modules.
        Worker = PythonWorker if tool_id == 'business-center' else NodeWorker
        with Worker(self.node, entrypoint, on_log=lambda line: events.append(('stderr', line))) as worker:
            self.assertNotIn('--test-adapter', worker.process.args)
            request_id = worker.send(kind, context=context, parameters=parameters)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    message = worker.receive(.2)
                except queue.Empty:
                    continue
                self.assertEqual(message.get('requestId'), request_id)
                events.append((message['type'], message.get('data', {})))
                if message['type'] in {'result', 'error'}:
                    if started:
                        self.assertEqual(message.get('taskId'), context['taskId'])
                        self.assertEqual(message.get('attempt'), context['attempt'])
                        self.assertEqual([kind for kind, _ in events], ['ack', message['type']])
                    else:
                        self.assertEqual(message['type'], 'error')
                        self.assertNotIn('taskId', message)
                        self.assertNotIn('attempt', message)
                        self.assertEqual([kind for kind, _ in events], ['error'])
                    return message
            self.fail(f'Timed out reading real {tool_id} worker result')

    def assert_rows(self, actual, expected, task_id):
        self.assertEqual(len(actual), len(expected))
        for result, reference in zip(actual, expected):
            for key, value in reference.items():
                self.assertEqual(result[key], task_id if key == 'taskId' else value)

    def test_four_actual_adapters_paginate_chinese_success_and_error_results_without_side_effects(self):
        sources_before = legacy_snapshot()
        for index, tool_id in enumerate(TOOLS, 1):
            context = self.context(tool_id, index)
            self.seed(context)
            before = tree_snapshot(self.root)
            state_hash = hashlib.sha256(Path(context['statePath']).read_bytes()).digest()
            for section, expected in self.fixtures[tool_id]['expected'].items():
                for offset, limit in ((0, 1), (1, 1), (50, 2)):
                    with self.subTest(tool=tool_id, section=section, offset=offset):
                        parameters = {'offset': offset, 'limit': limit}
                        if section != 'results':
                            parameters['section'] = section
                        message = self.call(tool_id, 'read_results', parameters, context)
                        self.assertEqual(message['type'], 'result', message)
                        self.assertEqual(message['data']['total'], len(expected))
                        self.assert_rows(message['data']['items'], expected[offset:offset + limit], context['taskId'])
            self.assertEqual(tree_snapshot(self.root), before)
            self.assertEqual(hashlib.sha256(Path(context['statePath']).read_bytes()).digest(), state_hash)
        self.assertEqual(legacy_snapshot(), sources_before)

    def test_operations_sections_use_real_workers_and_never_take_browser_lease(self):
        store = Store(DataPaths(self.root / 'host-data'))
        self.addCleanup(store.close)
        queue_ = ResourceQueue()

        def forbidden_lease(*_args, **_kwargs):
            self.fail('read_results must not acquire a browser lease')

        browser = SimpleNamespace(queue=queue_, lease=forbidden_lease)
        operations = Operations(store, Events(), Logs(store.paths), browser, node=self.node,
                                entrypoint=WORKER, descriptors={tool: {'available': True, 'engine': 'python' if tool == 'business-center' else 'node'} for tool in TOOLS})
        self.addCleanup(operations.shutdown)
        for tool_id in TOOLS:
            task = store.create_task(tool_id, {})
            context = {**self.context(tool_id, root=store.paths.root), 'taskId': task['id'], 'attempt': task['attempt'],
                       'statePath': str(store.paths.resolve(f"tasks/{task['id']}/engine-state.json"))}
            self.seed(context)
            before = tree_snapshot(store.paths.root)
            with queue_.lease('owned-long-running-task'):
                holder = copy.deepcopy(queue_.state())
                for section, expected in self.fixtures[tool_id]['expected'].items():
                    result = operations.results(task['id'], offset=0, limit=1, section=section)
                    self.assertEqual(result['total'], len(expected))
                    self.assert_rows(result['items'], expected[:1], task['id'])
                self.assertEqual(queue_.state(), holder)
            self.assertEqual(tree_snapshot(store.paths.root), before)
            for section in ('unknown', 'unparseableItems') if tool_id != 'business-center' else ('unknown',):
                with self.assertRaises(ToolboxError) as caught:
                    operations.results(task['id'], section=section)
                self.assertEqual(caught.exception.code, 'INVALID_PARAMETERS')

    def test_invalid_run_parameters_are_rejected_before_state_or_browser_access(self):
        for index, tool_id in enumerate(TOOLS[:3], 1):
            context = self.context(tool_id, index)
            context['dataRoot'] = str(self.root / 'never-created')
            before = tree_snapshot(self.root)
            message = self.call(tool_id, 'run', {'categories': [], 'category': '', 'outputDirectory': 'outside'}, context)
            self.assertEqual(message['type'], 'error', message)
            self.assertEqual(message['data']['code'], 'INVALID_PARAMETERS')
            self.assertEqual(tree_snapshot(self.root), before)
        manual_context = self.context('manual-video', 4)
        message = self.call('manual-video', 'run', {}, manual_context, started=False)
        self.assertEqual(message['data']['code'], 'UNSUPPORTED_OPERATION')
        message = self.call('manual-video', 'download_item', {'item': {}, 'candidateId': ''}, manual_context)
        self.assertEqual(message['data']['code'], 'INVALID_PARAMETERS')
        self.assertEqual(tree_snapshot(self.root), [])

    def test_absent_state_is_read_only_for_all_four_real_adapters(self):
        for index, tool_id in enumerate(TOOLS, 1):
            message = self.call(tool_id, 'read_results', {'offset': 0, 'limit': 1}, self.context(tool_id, index))
            self.assertEqual(message['type'], 'result', message)
            self.assertEqual(message['data']['items'], [])
            self.assertEqual(message['data']['total'], 0)
        self.assertEqual(tree_snapshot(self.root), [])

    def test_invalid_pagination_and_cross_task_state_do_not_overwrite_checkpoints(self):
        error_codes = {'business-center': 'INVALID_PARAMETERS', 'top200': 'INVALID_STATE',
                       'video-ranking': 'STATE_CORRUPT', 'manual-video': 'STATE_CORRUPT'}
        for index, tool_id in enumerate(TOOLS, 1):
            context = self.context(tool_id, index)
            self.seed(context)
            original = Path(context['statePath']).read_bytes()
            message = self.call(tool_id, 'read_results', {'offset': -1, 'limit': 201}, context)
            self.assertEqual(message['type'], 'error', message)
            self.assertEqual(message['data']['code'], 'INVALID_PARAMETERS')
            self.assertEqual(Path(context['statePath']).read_bytes(), original)
            envelope = json.loads(original)
            envelope['taskId'] = 'f' * 32
            Path(context['statePath']).write_text(json.dumps(envelope, ensure_ascii=False), encoding='utf-8')
            corrupt = Path(context['statePath']).read_bytes()
            message = self.call(tool_id, 'read_results', {}, context)
            self.assertEqual(message['type'], 'error', message)
            self.assertEqual(message['data']['code'], error_codes[tool_id])
            self.assertEqual(Path(context['statePath']).read_bytes(), corrupt)

    def test_whitelisted_isolated_layout_cold_imports_and_runs_real_readers_with_one_shared_dependency_tree(self):
        self.assertTrue(validate_sources(REPO))
        layout = self.root / 'isolated-release'
        layout.mkdir()
        for relative in SOURCE_FILES:
            destination = layout / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / relative, destination)
        dependency_root = (REPO / 'toolbox/node_modules').resolve()
        junction = layout / 'node_modules'
        self.assertEqual(junction.parent.resolve(), layout.resolve())
        self.assertFalse(junction.exists())
        sentinel = dependency_root / 'playwright-core/package.json'
        dependency_before = sentinel.read_bytes()
        # Fixed script and structured arguments; only this newly created link is removed.
        script = "require('node:fs').symlinkSync(process.argv[1],process.argv[2],process.platform==='win32'?'junction':'dir')"
        subprocess.run([self.node, '-e', script, str(dependency_root), str(junction)], check=True,
                       capture_output=True, text=True, encoding='utf-8', timeout=15)
        try:
            self.assertTrue(junction.is_junction() if os.name == 'nt' else junction.is_symlink())
            self.assertEqual(junction.resolve(), dependency_root)
            environment = {key: value for key, value in os.environ.items() if key not in {'NODE_PATH', 'NODE_OPTIONS'}}
            cold = subprocess.run([self.node, str(HELPER), 'cold-import', str(layout), str(dependency_root)],
                                  capture_output=True, text=True, encoding='utf-8', timeout=30, env=environment)
            self.assertEqual(cold.returncode, 0, cold.stderr)
            observed = json.loads(cold.stdout)
            self.assertEqual(observed['toolIds'], list(TOOLS[1:]))
            for key in ('sharedPlaywright', 'sharedExcel'):
                self.assertTrue(Path(observed[key]).resolve().is_relative_to(dependency_root))
            copied_before = {relative: hashlib.sha256((layout / relative).read_bytes()).digest() for relative in SOURCE_FILES}
            data_root = self.root / 'isolated-data'
            for index, tool_id in enumerate(TOOLS[1:], 2):
                context = self.context(tool_id, index, data_root)
                self.seed(context)
                for section, expected in self.fixtures[tool_id]['expected'].items():
                    message = self.call(tool_id, 'read_results', {'offset': 0, 'limit': 1, **({'section': section} if section != 'results' else {})},
                                        context, entrypoint=layout / 'toolbox/node/worker.cjs')
                    self.assertEqual(message['type'], 'result', message)
                    self.assertEqual(message['data']['total'], len(expected))
                    self.assert_rows(message['data']['items'], expected[:1], context['taskId'])
            actual = set()
            for directory, names, files in os.walk(layout, followlinks=False):
                names[:] = [name for name in names if name != 'node_modules']
                actual.update((Path(directory) / file).relative_to(layout).as_posix() for file in files)
            self.assertEqual(actual, set(SOURCE_FILES))
            self.assertEqual({relative: hashlib.sha256((layout / relative).read_bytes()).digest() for relative in SOURCE_FILES}, copied_before)
        finally:
            # Never send the linked dependency tree to recursive cleanup.
            self.assertEqual(junction.parent.resolve(), layout.resolve())
            self.assertTrue(junction.is_junction() if os.name == 'nt' else junction.is_symlink())
            os.rmdir(junction) if os.name == 'nt' else junction.unlink()
        self.assertFalse(junction.exists())
        self.assertEqual(sentinel.read_bytes(), dependency_before)


if __name__ == '__main__':
    unittest.main()
