import ctypes
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from toolbox.host.browser import BrowserManager
from toolbox.host.errors import ToolboxError
from toolbox.host.events import Events
from toolbox.host.logs import Logs
from toolbox.host.media import VideoValidator
from toolbox.host.paths import DataPaths
from toolbox.host.resources import ResourceQueue
from toolbox.host.scheduler import TaskScheduler
from toolbox.host.store import Store
from toolbox.host.worker import NodeWorker


class FixtureBrowser:
    def __init__(self):
        self.queue = ResourceQueue()
        self.order = []

    @contextmanager
    def lease(self, owner, cancelled, reservation):
        with self.queue.lease(owner, cancelled, reservation) as ticket:
            self.order.append(owner)
            yield {'endpoint': 'http://127.0.0.1:1', 'leaseId': ticket['leaseId']}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-runtime-')
        self.paths = DataPaths(Path(self.temp.name))
        self.store = Store(self.paths)
        self.events = Events()
        self.logs = Logs(self.paths)
        self.browser = FixtureBrowser()
        self.scheduler = TaskScheduler(self.store, self.events, self.logs, self.browser,
            node=shutil.which('node'), entrypoint=Path(__file__).parents[1] / 'node/worker.cjs', ffmpeg='',
            descriptors={'top200': {'available': True, 'requiresBrowser': True, 'supportsPause': True,
                                    'supportsResume': True, 'supportsRetryFailed': True}},
            validate_video=lambda path: None, test_adapter=True)

    def tearDown(self):
        self.scheduler.shutdown()
        self.store.close()
        self.temp.cleanup()

    def until(self, predicate):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.02)
        self.fail('timed out waiting for runtime state')

    def test_task_runs_and_result_is_stored_without_browser_competition(self):
        first = self.scheduler.create('top200', {'categories': ['fixture'] * 5})
        second = self.scheduler.create('top200', {'categories': ['fixture']})
        self.until(lambda: self.store.task(second['id'])['state'] == 'completed')
        self.assertEqual(self.store.task(first['id'])['state'], 'completed')
        self.assertEqual(self.browser.order, [first['id'], second['id']])
        self.assertEqual(self.logs.read(first['id'])['items'][0]['message'], '中文、多行\n日志与 "引号"')

    def test_paused_task_keeps_browser_and_cancel_releases_for_next_task(self):
        first = self.scheduler.create('top200', {'categories': ['fixture'] * 1000})
        self.until(lambda: self.store.task(first['id'])['progress'].get('current', -1) >= 0)
        self.scheduler.control(first['id'], 'pause')
        self.until(lambda: self.store.task(first['id'])['state'] == 'paused')
        second = self.scheduler.create('top200', {'categories': ['fixture']})
        self.assertEqual(self.store.task(second['id'])['state'], 'queued')
        self.assertEqual(self.browser.queue.state()['holder']['owner'], first['id'])
        self.scheduler.control(first['id'], 'cancel')
        self.until(lambda: self.store.task(second['id'])['state'] == 'completed')
        self.assertEqual(self.store.task(first['id'])['state'], 'cancelled')

    def test_cancel_queued_task_never_starts_worker(self):
        first = self.scheduler.create('top200', {'categories': ['fixture'] * 1000})
        self.until(lambda: self.store.task(first['id'])['progress'].get('current', -1) >= 0)
        second = self.scheduler.create('top200', {'categories': ['fixture']})
        self.scheduler.control(second['id'], 'cancel')
        self.until(lambda: second['id'] not in self.scheduler._runs)
        self.assertEqual(self.store.task(second['id'])['state'], 'cancelled')
        self.assertEqual(self.browser.order, [first['id']])
        self.scheduler.control(first['id'], 'cancel')

    def test_resume_increments_attempt_and_preserves_parameters(self):
        task = self.scheduler.create('top200', {'categories': ['fixture'] * 1000})
        self.until(lambda: self.store.task(task['id'])['progress'].get('current', -1) >= 0)
        self.scheduler.control(task['id'], 'cancel')
        self.until(lambda: task['id'] not in self.scheduler._runs)
        self.scheduler.control(task['id'], 'resume')
        self.assertEqual(self.store.task(task['id'])['attempt'], 2)
        self.assertEqual(self.store.task(task['id'])['parameters'], task['parameters'])
        self.scheduler.control(task['id'], 'cancel')

    def test_worker_crash_only_interrupts_its_task(self):
        first = self.scheduler.create('top200', {'categories': ['fixture'] * 1000})
        self.until(lambda: self.store.task(first['id'])['progress'].get('current', -1) >= 0)
        second = self.scheduler.create('top200', {'categories': ['fixture']})
        self.scheduler._runs[first['id']]['worker'].process.kill()
        self.until(lambda: self.store.task(second['id'])['state'] == 'completed')
        self.assertEqual(self.store.task(first['id'])['state'], 'interrupted')

    def test_unsupported_tool_and_path_parameters_are_rejected(self):
        with self.assertRaises(ToolboxError):
            self.scheduler.create('manual-video', {})
        with self.assertRaises(ToolboxError):
            self.scheduler.create('top200', {'outputDirectory': 'D:\\outside'})
        self.assertEqual(self.store.list_tasks()['total'], 0)

    def test_logs_rotate_under_cap_and_hide_urls_and_tokens(self):
        logs = Logs(self.paths, chunk_bytes=500, files=3)
        for index in range(30):
            logs.write(f'{index} media https://example.test/video?signature=secret Cookie: private', 'task')
        size = sum(p.stat().st_size for p in self.paths.resolve('logs').glob('*.ndjson'))
        self.assertLessEqual(size, 1500)
        result = logs.read('task')
        self.assertTrue(result['rotated'])
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('private', json.dumps(result))
        reopened = Logs(self.paths, chunk_bytes=500, files=3)
        reopened.write('after restart', 'task')
        self.assertGreater(reopened.read('task')['items'][-1]['seq'], 30)

    def test_browser_rejects_unrelated_cdp_identity(self):
        manager = BrowserManager(self.paths, self.events)
        manager._endpoint = 'http://127.0.0.1:12345'
        manager._browser_path = '/devtools/browser/expected'
        with patch.object(manager, '_request', return_value={'webSocketDebuggerUrl': 'ws://127.0.0.1:12345/devtools/browser/another'}):
            with self.assertRaises(ToolboxError):
                manager._check_identity()

    def test_queued_tasks_recover_in_creation_order_and_unavailable_tool_fails(self):
        self.scheduler.shutdown()
        first = self.store.create_task('top200', {'categories': ['fixture'] * 5})
        second = self.store.create_task('top200', {'categories': ['fixture']})
        unknown = self.store.create_task('business-center', {})
        self.scheduler = TaskScheduler(self.store, self.events, self.logs, self.browser,
            node=shutil.which('node'), entrypoint=Path(__file__).parents[1] / 'node/worker.cjs', ffmpeg='',
            descriptors={'top200': {'available': True, 'requiresBrowser': True}},
            validate_video=lambda path: None, test_adapter=True)
        self.until(lambda: self.store.task(second['id'])['state'] == 'completed')
        self.assertEqual(self.browser.order, [first['id'], second['id']])
        self.assertEqual(self.store.task(unknown['id'])['state'], 'failed')

    def test_shutdown_blocks_new_work_and_resume(self):
        task = self.store.create_task('top200', {})
        self.scheduler.shutdown()
        with self.assertRaises(ToolboxError):
            self.scheduler.create('top200', {})
        with self.assertRaises(ToolboxError):
            self.scheduler.control(task['id'], 'resume')

    def test_thread_start_failure_withdraws_browser_reservation(self):
        with patch('toolbox.host.scheduler.threading.Thread.start', side_effect=RuntimeError('cannot start')):
            task = self.scheduler.create('top200', {})
        self.assertEqual(task['state'], 'failed')
        self.assertEqual(self.browser.queue.state()['waiting'], [])
        self.assertEqual(self.scheduler._runs, {})

    def test_logs_tolerate_truncated_utf8_and_redact_quoted_credentials(self):
        path = self.paths.resolve('logs/events.0.ndjson')
        path.write_bytes(b'[]\n{"seq":"bad"}\n\xff\n{"seq":9,"taskId":"task","message":"valid"}\n')
        logs = Logs(self.paths)
        logs.write('{"Authorization": "Bearer hidden", "Cookie": "private"}', 'task')
        result = logs.read('task')
        self.assertEqual(result['items'][0]['seq'], 9)
        self.assertNotIn('hidden', json.dumps(result))
        self.assertNotIn('private', json.dumps(result))

    @unittest.skipUnless(os.name == 'nt', 'Windows process job')
    def test_windows_job_stops_worker_descendants(self):
        task = self.store.create_task('top200', {})
        context = self.paths.task_context(task, '')
        worker = NodeWorker(shutil.which('node'), Path(__file__).parents[1] / 'node/worker.cjs', test_adapter=True)
        child_handle = None
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        try:
            worker.send('run', context=context, parameters={'spawnChild': True, 'count': 10000})
            while True:
                message = worker.receive(2)
                if message['type'] == 'progress' and 'childPid' in message['data']:
                    child_handle = kernel.OpenProcess(0x100000, False, message['data']['childPid'])
                    break
            self.assertTrue(child_handle)
            worker.close()
            self.assertEqual(kernel.WaitForSingleObject(child_handle, 2000), 0)
        finally:
            worker.close()
            if child_handle:
                kernel.CloseHandle(child_handle)

    def test_real_ffmpeg_rejects_text_and_reads_generated_video(self):
        ffmpeg = Path(__file__).parents[2] / '抖音视频下载器（免 Python 版）/ffmpeg.exe'
        if not ffmpeg.is_file():
            self.skipTest('development FFmpeg binary not present')
        invalid = self.paths.resolve('scratch/invalid.mp4')
        invalid.write_text('not a video', encoding='utf-8')
        validate = VideoValidator(ffmpeg, self.paths.resolve('scratch'))
        with self.assertRaises(ToolboxError):
            validate(invalid)
        sample = self.paths.resolve('scratch/sample.mp4')
        subprocess.run([str(ffmpeg), '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=0.2',
                        '-c:v', 'libx264', str(sample)], check=True, capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0, timeout=20)
        validate(sample)


if __name__ == '__main__':
    unittest.main()
