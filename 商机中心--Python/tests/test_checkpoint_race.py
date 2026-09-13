from __future__ import annotations

import argparse
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import collect as collector
import web_app


class CheckpointStorageTests(unittest.TestCase):
    def test_atomic_write_retries_transient_permission_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            real_replace = collector.os.replace
            attempts = 0

            def flaky_replace(source: Path, target: Path) -> None:
                nonlocal attempts
                attempts += 1
                if attempts < 3:
                    raise PermissionError(5, "拒绝访问", str(target))
                real_replace(source, target)

            with mock.patch.object(collector.os, "replace", side_effect=flaky_replace), mock.patch.object(
                collector.time, "sleep"
            ):
                collector.atomic_write_json(path, {"saved": True})

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"saved": True})
            self.assertEqual(attempts, 3)
            self.assertEqual(list(path.parent.glob(f"{path.name}.*.tmp")), [])

    def test_atomic_write_classifies_exhausted_access_denied_and_cleans_temp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            with mock.patch.object(
                collector.os,
                "replace",
                side_effect=PermissionError(5, "拒绝访问", str(path)),
            ), mock.patch.object(collector.time, "sleep"):
                with self.assertRaisesRegex(collector.AtomicWriteError, "本地文件写入冲突"):
                    collector.atomic_write_json(path, {"saved": False})

            self.assertEqual(list(path.parent.glob(f"{path.name}.*.tmp")), [])

    def test_atomic_write_classifies_non_sharing_io_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            with mock.patch.object(Path, "write_text", side_effect=OSError(28, "磁盘空间不足")):
                with self.assertRaisesRegex(collector.AtomicWriteError, "本地文件写入失败"):
                    collector.atomic_write_json(path, {"saved": False})

    def test_save_state_pauses_until_user_retries_after_persistent_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            state = {"status": "running", "results": [], "failures": []}
            first_error = collector.CheckpointIOError("本地检查点写入冲突")
            collector.PAUSE_EVENT.clear()
            collector.STOP_EVENT.clear()

            with mock.patch.object(collector, "atomic_write_json", side_effect=[first_error, None]) as write:
                thread = threading.Thread(
                    target=collector.save_state,
                    args=(state, path),
                    kwargs={"pause_on_conflict": True},
                )
                thread.start()
                deadline = time.monotonic() + 2
                while not collector.PAUSE_EVENT.is_set() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(collector.PAUSE_EVENT.is_set())
                self.assertEqual(state["status"], "checkpoint_paused")
                collector.PAUSE_EVENT.clear()
                thread.join(timeout=2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(write.call_count, 2)
            self.assertEqual(state["status"], "running")
            self.assertIsNone(state["last_error"])

    def test_stop_during_checkpoint_pause_does_not_retry_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            state = {"status": "running", "results": [], "failures": []}
            errors: list[BaseException] = []
            collector.PAUSE_EVENT.clear()
            collector.STOP_EVENT.clear()

            def save() -> None:
                try:
                    collector.save_state(state, path, pause_on_conflict=True)
                except BaseException as error:
                    errors.append(error)

            with mock.patch.object(
                collector,
                "atomic_write_json",
                side_effect=collector.CheckpointIOError("本地检查点写入冲突"),
            ) as write:
                thread = threading.Thread(target=save)
                thread.start()
                deadline = time.monotonic() + 2
                while not collector.PAUSE_EVENT.is_set() and time.monotonic() < deadline:
                    time.sleep(0.01)
                collector.STOP_EVENT.set()
                collector.PAUSE_EVENT.clear()
                thread.join(timeout=2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(write.call_count, 1)
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], collector.CheckpointIOError)
            collector.STOP_EVENT.clear()

    def test_concurrent_checkpoint_reads_and_writes_leave_no_temporary_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            payload = {"revision": 0, "blob": "x" * (5 * 1024 * 1024)}
            collector.atomic_write_json(path, payload)
            failures: list[BaseException] = []
            stop = threading.Event()

            def reader() -> None:
                while not stop.is_set():
                    try:
                        collector.read_json(path)
                    except BaseException as error:  # captured and asserted in the main thread
                        failures.append(error)
                        stop.set()

            readers = [threading.Thread(target=reader) for _ in range(2)]
            for thread in readers:
                thread.start()
            try:
                for revision in range(1, 101):
                    payload["revision"] = revision
                    collector.atomic_write_json(path, payload)
            finally:
                stop.set()
                for thread in readers:
                    thread.join(timeout=5)

            self.assertEqual(failures, [])
            self.assertEqual(collector.read_json(path)["revision"], 100)
            self.assertEqual(list(path.parent.glob(f"{path.name}.*.tmp")), [])

    def test_recovery_discards_stale_temp_when_checkpoint_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            temporary = path.with_name(f"{path.name}.123.stale.tmp")
            path.write_text(json.dumps({"task_id": "formal"}), encoding="utf-8")
            temporary.write_text(json.dumps({"task_id": "stale"}), encoding="utf-8")

            state = collector.recover_checkpoint(path)

            self.assertEqual(state["task_id"], "formal")
            self.assertFalse(temporary.exists())

    def test_recovery_restores_newest_valid_temp_when_checkpoint_is_corrupt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            temporary = path.with_name(f"{path.name}.123.recover.tmp")
            path.write_text("{broken", encoding="utf-8")
            temporary.write_text(json.dumps({"task_id": "recovered"}), encoding="utf-8")

            state = collector.recover_checkpoint(path)

            self.assertEqual(state["task_id"], "recovered")
            self.assertEqual(state["checkpoint_recovery"]["source"], temporary.name)
            self.assertEqual(collector.read_json(path)["task_id"], "recovered")
            self.assertFalse(temporary.exists())

    @unittest.skipIf(collector.Workbook is None, "openpyxl is not installed")
    def test_excel_replace_failure_cleans_unique_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.xlsx"
            args = argparse.Namespace(
                category_name="测试类目",
                category_id=1,
                second_category_id=None,
                third_category_id=None,
                min_amount=0,
                page_size=18,
                page_interval=0,
                batch_size=1,
            )
            state = collector.new_state(args)
            collector.refresh_stats(state)

            with mock.patch.object(
                collector,
                "_replace_file",
                side_effect=collector.AtomicWriteError("Excel 文件被占用"),
            ):
                with self.assertRaises(collector.AtomicWriteError):
                    collector.generate_excel(state, output)

            self.assertEqual(list(output.parent.glob("report.*.tmp.xlsx")), [])


class TaskManagerStateTests(unittest.TestCase):
    def tearDown(self) -> None:
        collector.PAUSE_EVENT.clear()
        collector.STOP_EVENT.clear()

    def test_stop_sets_stop_before_waking_paused_task(self) -> None:
        manager = web_app.TaskManager()
        release = threading.Event()
        manager.thread = threading.Thread(target=release.wait)
        manager.thread.start()
        collector.PAUSE_EVENT.set()
        real_set = collector.STOP_EVENT.set

        def set_stop() -> None:
            self.assertTrue(collector.PAUSE_EVENT.is_set())
            real_set()

        try:
            with mock.patch.object(collector.STOP_EVENT, "set", side_effect=set_stop):
                manager.stop()
            self.assertTrue(collector.STOP_EVENT.is_set())
            self.assertFalse(collector.PAUSE_EVENT.is_set())
        finally:
            release.set()
            manager.thread.join(timeout=2)

    def test_finalization_generates_report_after_checkpoint_save_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(web_app, "ROOT", root):
                manager = web_app.TaskManager()
                args = manager._arguments({
                    "categoryId": 1,
                    "categoryName": "测试类目",
                    "minAmount": 0,
                    "maxPages": 1,
                    "pageInterval": 0,
                    "batchSize": 1,
                })
            state = collector.new_state(args)
            checkpoint = Path(args.checkpoint_dir) / "checkpoint.json"
            manager.auth = ("cookie", "agent", "test")
            report_files = {
                "markdown": str(root / "report.md"),
                "json": str(root / "report.json"),
                "xlsx": str(root / "report.xlsx"),
            }

            class DummyClient:
                def __init__(self, *_args: object) -> None:
                    pass

                def close(self) -> None:
                    pass

            def save_report(current: dict[str, object], _root: Path) -> dict[str, str]:
                current["report_files"] = report_files
                return report_files

            with mock.patch.object(collector, "load_or_create_state", return_value=(state, checkpoint)), mock.patch.object(
                collector, "ApiClient", DummyClient
            ), mock.patch.object(
                collector, "collect", side_effect=collector.CheckpointIOError("检查点不可写")
            ), mock.patch.object(
                collector, "save_state", side_effect=collector.CheckpointIOError("磁盘空间不足")
            ), mock.patch.object(collector, "save_reports", side_effect=save_report) as save_reports:
                manager._run(args)

            save_reports.assert_called_once()
            self.assertEqual(manager.state["report_files"], report_files)
            self.assertEqual(manager.phase, "failed")
            self.assertFalse(collector.PAUSE_EVENT.is_set())
            self.assertFalse(collector.STOP_EVENT.is_set())

    def test_published_state_is_detached_from_collector_mutations(self) -> None:
        manager = web_app.TaskManager()
        source = {"task_id": "snapshot-task", "status": "running", "results": []}
        manager._publish_state(source)
        source["results"].append({"clue_id": "late-result"})

        status = manager.status()

        self.assertEqual(status["task"]["taskId"], "snapshot-task")
        self.assertEqual(status["task"]["latestResults"], [])

    def test_status_uses_memory_without_reading_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "checkpoint.json"
            checkpoint.write_text("{}", encoding="utf-8")
            manager = web_app.TaskManager()
            manager.checkpoint = checkpoint
            manager.state = {"task_id": "memory-task", "status": "running", "results": []}

            with mock.patch.object(Path, "read_text", side_effect=AssertionError("status read checkpoint")):
                status = manager.status()

            self.assertEqual(status["task"]["taskId"], "memory-task")

    def test_history_is_cached_between_requests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint_dir = root / "data" / "checkpoints"
            checkpoint_dir.mkdir(parents=True)
            checkpoint = checkpoint_dir / "api-test.json"
            checkpoint.write_text(
                json.dumps({"task_id": "cached-task", "status": "completed", "results": []}),
                encoding="utf-8",
            )

            with mock.patch.object(web_app, "ROOT", root):
                manager = web_app.TaskManager()
                with mock.patch.object(Path, "read_text", side_effect=AssertionError("history rescanned disk")):
                    first = manager.history()
                    second = manager.history()

            self.assertEqual(first, second)
            self.assertEqual(first[0]["taskId"], "cached-task")

    def test_startup_history_recovers_checkpoint_when_only_temp_exists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint_dir = root / "data" / "checkpoints"
            checkpoint_dir.mkdir(parents=True)
            formal = checkpoint_dir / "api-test.json"
            temporary = checkpoint_dir / "api-test.json.123.recover.tmp"
            temporary.write_text(
                json.dumps({"task_id": "recovered-task", "status": "running", "results": []}),
                encoding="utf-8",
            )

            with mock.patch.object(web_app, "ROOT", root):
                manager = web_app.TaskManager()
                manager.refresh_history(recover_temps=True)

            self.assertTrue(formal.is_file())
            self.assertFalse(temporary.exists())
            self.assertEqual(manager.history()[0]["taskId"], "recovered-task")


if __name__ == "__main__":
    unittest.main()
