import json
import os
import queue
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from toolbox.host.errors import ToolboxError
from toolbox.host.events import Events
from toolbox.host.paths import DataPaths, atomic_json, display_filename
from toolbox.host.resources import ResourceQueue
from toolbox.host.state import load_state, save_state
from toolbox.host.store import Store
from toolbox.host.worker import NodeWorker


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-test-')
        self.paths = DataPaths(Path(self.temp.name))
        self.store = Store(self.paths)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def task(self, tool='manual-video'):
        return self.store.create_task(tool, {'title': '中文条件'})

    def candidate(self, task, name='one', content=b'fixture video'):
        context = self.paths.task_context(task, '')
        target = Path(context['artifactStagingRoot']) / (name + '.mp4')
        target.write_bytes(content)
        return {'candidateId': name, 'kind': 'video', 'relpath': self.paths.relative(target),
                'role': 'video', 'displayName': '同标题', 'metadata': {'caption': '本任务文案'}}

    def register(self, task, candidate):
        return self.store.register(task['id'], task['attempt'], candidate, validate_video=lambda path: None)

    def test_tasks_paginate_and_parameters_remain_immutable(self):
        for _ in range(25):
            self.task()
        result = self.store.list_tasks(offset=20, limit=20)
        self.assertEqual(result['total'], 25)
        self.assertEqual(len(result['items']), 5)
        self.assertEqual(result['items'][0]['parameters'], {'title': '中文条件'})

    def test_recovery_attempt_and_stale_event(self):
        task = self.task()
        self.store.transition(task['id'], 'running')
        self.store.transition(task['id'], 'pausing')
        self.store.transition(task['id'], 'paused')
        self.assertEqual(self.store.recover(), [task['id']])
        self.assertEqual(self.store.task(task['id'])['state'], 'interrupted')
        self.store.transition(task['id'], 'queued')
        self.assertEqual(self.store.task(task['id'])['attempt'], 2)
        self.assertFalse(self.store.transition(task['id'], 'completed', attempt=1))
        self.assertEqual(self.store.task(task['id'])['state'], 'queued')

    def test_invalid_state_transition_rejected(self):
        task = self.task()
        with self.assertRaises(ToolboxError):
            self.store.transition(task['id'], 'completed')

    def test_shared_video_and_last_reference_deletion(self):
        first, second = self.task(), self.task()
        a = self.register(first, self.candidate(first))
        b = self.register(second, self.candidate(second))
        self.assertEqual(a['disposition'], 'created')
        self.assertEqual(b['disposition'], 'exact_reuse')
        self.assertEqual(a['artifactId'], b['artifactId'])
        video = self.store.artifact_path(a['artifactId'])
        for task in (first, second):
            self.store.transition(task['id'], 'cancelled')
        preview = self.store.preview_delete([first['id']])
        self.assertEqual(preview['releasableBytes'], 0)
        self.assertEqual(preview['sharedFiles'], 1)
        self.store.confirm_delete(preview['token'])
        self.assertTrue(video.exists())
        preview = self.store.preview_delete([second['id']])
        self.assertEqual(preview['releasableBytes'], len(b'fixture video'))
        result = self.store.confirm_delete(preview['token'])
        self.assertGreater(result['releasedBytes'], 0)
        self.assertFalse(video.exists())

    def test_candidate_retry_is_idempotent_across_attempts(self):
        task = self.task()
        candidate = self.candidate(task)
        first = self.register(task, candidate)
        self.store.transition(task['id'], 'cancelled')
        self.store.transition(task['id'], 'queued')
        resumed = self.store.task(task['id'])
        self.assertEqual(self.register(resumed, candidate), first)
        self.assertEqual(self.store.artifacts(task['id'])['total'], 1)

    def test_manual_never_calls_visual_match(self):
        task = self.task()
        calls = []
        self.store.register(task['id'], 1, self.candidate(task), validate_video=lambda p: None,
                            visual_match=lambda f: calls.append(f))
        self.assertEqual(calls, [])

    def test_visual_reuse_preserves_candidate_hash_and_caption(self):
        first, second = self.task('video-ranking'), self.task('video-ranking')
        saved = self.register(first, self.candidate(first))
        candidate = self.candidate(second, content=b'different visual candidate')
        reused = self.store.register(second['id'], 1, candidate, validate_video=lambda p: None,
                                    visual_match=lambda f: {'artifactId': saved['artifactId'], 'matchReason': 'opening', 'matchPercent': 90})
        self.assertEqual(reused['disposition'], 'visual_reuse')
        self.assertNotEqual(reused['candidateSha256'], reused['artifactSha256'])
        self.assertEqual(self.store.artifacts(second['id'])['items'][0]['metadata']['caption'], '本任务文案')

    def test_candidate_cannot_register_other_task_file(self):
        first, second = self.task(), self.task()
        with self.assertRaises(ToolboxError):
            self.register(second, self.candidate(first))

    def test_preview_revalidates_active_task(self):
        task = self.task()
        self.store.transition(task['id'], 'cancelled')
        preview = self.store.preview_delete([task['id']])
        self.store.transition(task['id'], 'queued')
        with self.assertRaises(ToolboxError):
            self.store.confirm_delete(preview['token'])
        self.assertEqual(self.store.task(task['id'])['state'], 'queued')

    def test_missing_video_repaired_without_losing_refs(self):
        first, second = self.task(), self.task()
        registered = self.register(first, self.candidate(first))
        self.store.artifact_path(registered['artifactId']).unlink()
        self.store.reconcile()
        self.assertEqual(self.store.artifacts(first['id'])['items'][0]['status'], 'missing')
        repaired = self.register(second, self.candidate(second))
        self.assertEqual(repaired['artifactId'], registered['artifactId'])
        self.assertTrue(self.store.artifact_path(registered['artifactId']).is_file())

    def test_video_requires_validator(self):
        task = self.task()
        with self.assertRaises(ToolboxError):
            self.store.register(task['id'], 1, self.candidate(task))

    def test_safe_paths_and_filenames(self):
        for relative in ('../escape', 'D:\\outside', '\\\\server\\share', 'file:stream', '/outside'):
            with self.subTest(relative=relative), self.assertRaises(ToolboxError):
                self.paths.resolve(relative)
        self.assertEqual(display_filename('CON'), '结果_CON')
        self.assertNotIn('/', display_filename('中文/标题?'))
        self.assertLessEqual(len(display_filename('中' * 300)), 120)

    def test_state_envelope_identity_and_corrupt_preservation(self):
        task = self.task()
        context = self.paths.task_context(task, '')
        path = Path(context['statePath'])
        save_state(path, context, {'中文': [1, 2]})
        self.assertEqual(load_state(path, task['id'], task['toolId'])['state'], {'中文': [1, 2]})
        path.write_text('broken', encoding='utf-8')
        with self.assertRaises(ToolboxError):
            load_state(path, task['id'], task['toolId'])
        self.assertEqual(path.read_text(encoding='utf-8'), 'broken')

    def test_nested_transaction_rollback(self):
        task = self.task()
        with self.assertRaises(RuntimeError):
            with self.store.transaction():
                self.store.transition(task['id'], 'running')
                raise RuntimeError('rollback outer')
        self.assertEqual(self.store.task(task['id'])['state'], 'queued')

    def test_unknown_schema_is_not_modified(self):
        root = self.paths.resolve('future-schema')
        root.mkdir()
        db = sqlite3.connect(root / 'toolbox.sqlite3')
        db.executescript('CREATE TABLE schema_meta(version INTEGER);INSERT INTO schema_meta VALUES(2);')
        db.close()
        with self.assertRaises(ToolboxError):
            Store(DataPaths(root))
        db = sqlite3.connect(root / 'toolbox.sqlite3')
        self.assertEqual(db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [('schema_meta',)])
        db.close()

    def test_failed_registration_preserves_candidate_and_reconciles_intent(self):
        task = self.task()
        candidate = self.candidate(task)
        original = self.paths.resolve(candidate['relpath'])
        with patch('toolbox.host.store.encode', side_effect=[json.dumps(candidate['metadata']), RuntimeError('simulated registration interruption')]):
            with self.assertRaises(RuntimeError):
                self.register(task, candidate)
        self.assertTrue(original.is_file())
        self.assertEqual(self.store.artifacts(task['id'])['total'], 0)
        self.assertEqual(len(list(self.paths.resolve('media').glob('*.mp4'))), 1)
        self.store.reconcile()
        self.assertTrue(original.is_file())
        self.assertEqual(len(list(self.paths.resolve('media').glob('*.mp4'))), 0)
        self.assertEqual(self.register(task, candidate)['disposition'], 'created')

    def test_excel_direct_retry_cleans_old_registration(self):
        task = self.task('top200')
        candidate = self.candidate(task)
        candidate['kind'] = 'excel'
        with patch('toolbox.host.store.encode', side_effect=[json.dumps(candidate['metadata']), RuntimeError('simulated interruption')]):
            with self.assertRaises(RuntimeError):
                self.store.register(task['id'], 1, candidate)
        self.store.register(task['id'], 1, candidate)
        results = self.paths.resolve(f"tasks/{task['id']}/results")
        self.assertEqual(len(list(results.glob('*.xlsx'))), 1)
        self.assertEqual(self.store.artifacts(task['id'])['total'], 1)

    def test_registration_and_deletion_cannot_run_inside_uncommitted_transaction(self):
        task = self.task()
        candidate = self.candidate(task)
        with self.store.transaction():
            with self.assertRaises(ToolboxError):
                self.register(task, candidate)
        self.assertTrue(self.paths.resolve(candidate['relpath']).exists())
        self.store.transition(task['id'], 'cancelled')
        preview = self.store.preview_delete([task['id']])
        with self.store.transaction():
            with self.assertRaises(ToolboxError):
                self.store.confirm_delete(preview['token'])
        self.assertEqual(self.store.task(task['id'])['state'], 'cancelled')

    def test_stale_intent_cannot_move_other_registered_shared_video(self):
        first, second = self.task(), self.task()
        candidate = self.candidate(first)
        saved = self.register(first, candidate)
        video = self.store.artifact_path(saved['artifactId'])
        context = self.paths.task_context(second, '')
        journal = Path(context['controlRoot']) / 'register-stale.json'
        atomic_json(journal, {'source': f"tasks/{second['id']}/staging/missing.mp4",
                             'destination': self.paths.relative(video), 'artifactId': 'uncommitted-old-id'})
        self.store.reconcile()
        self.assertTrue(video.is_file())
        self.assertEqual(self.store.artifacts(first['id'])['items'][0]['status'], 'ready')

    def test_reconcile_repairs_partial_registered_file_before_removing_candidate(self):
        task = self.task()
        candidate = self.candidate(task)
        source = self.paths.resolve(candidate['relpath'])
        saved = self.register(task, candidate)
        video = self.store.artifact_path(saved['artifactId'])
        source.write_bytes(b'fixture video')
        video.write_bytes(b'partial')
        journal = self.paths.resolve(f"tasks/{task['id']}/control/register-repair.json")
        atomic_json(journal, {'source': candidate['relpath'], 'destination': self.paths.relative(video), 'artifactId': saved['artifactId']})
        self.store.reconcile()
        self.assertEqual(video.read_bytes(), b'fixture video')
        self.assertFalse(source.exists())
        self.assertFalse(journal.exists())

    def test_private_delete_failure_keeps_intent_for_restart(self):
        task = self.task()
        context = self.paths.task_context(task, '')
        save_state(context['statePath'], context, {'count': 1})
        self.store.transition(task['id'], 'cancelled')
        preview = self.store.preview_delete([task['id']])
        with patch('toolbox.host.store.shutil.rmtree', side_effect=PermissionError('file in use')):
            result = self.store.confirm_delete(preview['token'])
        self.assertEqual(result['pendingDirectories'], 1)
        self.assertTrue(Path(context['taskRoot']).exists())
        self.store.reconcile()
        self.assertFalse(Path(context['taskRoot']).exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows junction boundary')
    def test_internal_junction_cannot_redirect_staging_or_delete_shared_video(self):
        first, second = self.task(), self.task()
        saved = self.register(first, self.candidate(first))
        video = self.store.artifact_path(saved['artifactId'])
        context = self.paths.task_context(second, '')
        staging = Path(context['artifactStagingRoot'])
        staging.rmdir()
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(staging), str(video.parent)], check=True, capture_output=True)
        try:
            with self.assertRaises(ToolboxError):
                self.paths.task_context(second, '')
            with self.assertRaises(ToolboxError):
                self.paths.resolve(f"tasks/{second['id']}/staging/{video.name}")
            self.assertTrue(video.exists())
        finally:
            staging.rmdir()


class EventQueueTests(unittest.TestCase):
    def test_event_gap_and_bounded_pagination(self):
        events = Events(3)
        for i in range(5):
            events.emit('task.progress', {'current': i})
        self.assertTrue(events.read(0)['resetRequired'])
        result = events.read(2, 2)
        self.assertEqual([e['seq'] for e in result['events']], [3, 4])
        self.assertEqual(result['nextSeq'], 4)

    def test_events_are_snapshots(self):
        events = Events()
        data = {'count': [1]}
        sent = events.emit('task.progress', data)
        data['count'].append(2)
        sent['data']['count'].append(3)
        read = events.read()['events']
        self.assertEqual(read[0]['data']['count'], [1])
        read[0]['data']['count'].append(4)
        self.assertEqual(events.read()['events'][0]['data']['count'], [1])

    def test_fifo_lease_and_cancellation(self):
        resource = ResourceQueue()
        order = []
        cancel = threading.Event()
        def waiter(owner, cancelled=lambda: False):
            try:
                with resource.lease(owner, cancelled):
                    order.append(owner)
            except ToolboxError:
                order.append(owner + '-cancelled')
        with resource.lease('first'):
            a = threading.Thread(target=waiter, args=('second', cancel.is_set))
            b = threading.Thread(target=waiter, args=('third',))
            a.start()
            deadline = time.monotonic() + 2
            while len(resource.state()['waiting']) != 1 and time.monotonic() < deadline:
                time.sleep(.01)
            b.start()
            cancel.set()
            a.join(2)
            self.assertEqual(order, ['second-cancelled'])
            self.assertEqual(resource.state()['holder']['owner'], 'first')
        b.join(2)
        self.assertEqual(order, ['second-cancelled', 'third'])


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolbox-worker-')
        self.paths = DataPaths(Path(self.temp.name))
        self.paths.initialize()
        self.context = self.paths.task_context({'id': 'a' * 32, 'toolId': 'top200', 'attempt': 1, 'parameterVersion': 1}, '')
        self.worker = NodeWorker(shutil.which('node'), Path(__file__).parents[1] / 'node/worker.cjs', test_adapter=True)

    def tearDown(self):
        self.worker.close()
        self.temp.cleanup()

    def until(self, kind, predicate=lambda m: True):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                message = self.worker.receive(.2)
            except queue.Empty:
                continue
            if message['type'] == kind and predicate(message):
                return message
        self.fail(f'timed out waiting for {kind}')

    def test_chinese_protocol_checkpoint_and_read_only_results(self):
        self.worker.send('run', context=self.context, parameters={'count': 2})
        self.assertIn('中文', self.until('log')['data']['message'])
        result = self.until('result')
        self.assertEqual(result['taskId'], self.context['taskId'])
        state = load_state(self.context['statePath'], self.context['taskId'], 'top200')
        self.assertEqual(state['state']['count'], 2)
        before = Path(self.context['statePath']).stat().st_mtime_ns
        self.worker.send('read_results', context=self.context)
        self.assertEqual(self.until('result')['data']['total'], 1)
        self.assertEqual(Path(self.context['statePath']).stat().st_mtime_ns, before)

    def test_pause_ack_then_boundary_and_resume(self):
        self.worker.send('run', context=self.context, parameters={'count': 20, 'delay': 50})
        self.until('progress')
        self.worker.send('pause', task_id=self.context['taskId'], attempt=1)
        self.until('ack', lambda m: m['data']['command'] == 'pause')
        self.until('state', lambda m: m['data']['state'] == 'paused')
        self.worker.send('resume', task_id=self.context['taskId'], attempt=1)
        self.until('state', lambda m: m['data']['state'] == 'running')
        self.assertEqual(self.until('result')['data']['state'], 'completed')

    def test_cancel_propagates_and_stale_control_rejected(self):
        self.worker.send('run', context=self.context, parameters={'count': 100, 'delay': 20})
        self.until('progress')
        self.worker.send('cancel', task_id=self.context['taskId'], attempt=2)
        self.assertEqual(self.until('error')['data']['code'], 'UNSUPPORTED_OPERATION')
        self.worker.send('cancel', task_id=self.context['taskId'], attempt=1)
        self.assertEqual(self.until('error')['data']['code'], 'CANCELLED')

    def test_artifact_handshake(self):
        candidate = {'candidateId': 'stable-one', 'relpath': 'candidate.mp4', 'kind': 'video'}
        self.worker.send('run', context=self.context, parameters={'count': 1, 'candidate': candidate})
        self.assertEqual(self.until('artifact_candidate')['data'], candidate)
        self.worker.send('artifact_result', task_id=self.context['taskId'], attempt=1,
                         data={'candidateId': 'stable-one', 'artifactId': 'test-artifact', 'disposition': 'created'})
        self.assertEqual(self.until('result')['data']['state'], 'completed')

    def test_shutdown_has_finite_grace(self):
        self.worker.send('run', context=self.context, parameters={'count': 10000, 'delay': 100})
        self.until('progress')
        start = time.monotonic()
        self.worker.shutdown(grace_seconds=.5)
        self.assertIsNotNone(self.worker.process.poll())
        self.assertLess(time.monotonic() - start, 3)

    def test_independent_heartbeat_watchdog(self):
        self.worker.send('run', context=self.context, parameters={'count': 10000, 'delay': 10})
        self.until('progress')
        self.worker._last_heartbeat = time.monotonic() - 31
        deadline = time.monotonic() + 2
        while self.worker.process.poll() is None and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertIsNotNone(self.worker.process.poll())
        with self.assertRaises(ToolboxError):
            self.worker.receive()


if __name__ == '__main__':
    unittest.main()
