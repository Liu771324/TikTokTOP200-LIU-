"""Local HTTP and process fixtures; never open a platform page or real browser."""

from __future__ import annotations

import importlib
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

import requests

import douyin_downloader_core as core


MEDIA = b"local-media-fixture" * 40000
PUBLIC_URL = "https://www.douyin.com/video/123456"


class MediaHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/error":
            self.send_error(503)
            return
        payload = b"" if self.path == "/empty" else MEDIA
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        if self.path != "/unknown":
            self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.path == "/truncated":
            self.wfile.write(payload[:100])
            self.close_connection = True
        else:
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def log_message(self, *_args):
        pass


class FakeProcess:
    def __init__(self, command, *, result=0, running=False, **kwargs):
        self.command = command
        self.running = running
        self.returncode = None if running else result
        self.terminated = False
        self.killed = False
        Path(command[-1]).write_bytes(b"mux-fixture")
        kwargs["stderr"].write(b"fixture ffmpeg failure\n")

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.running:
            raise subprocess.TimeoutExpired(self.command, timeout)
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.running = False
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.running = False
        self.returncode = -9


class DownloaderCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="downloader-core-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "候选 result"
        self.scratch = self.root / "scratch"
        self.context = core.DownloadContext(self.output, self.scratch, self.root / "shared ffmpeg.exe")

    def resolved(self, *, title="测试视频", audio=False):
        return PUBLIC_URL, title, self.origin + "/full", self.origin + "/full" if audio else None

    def test_share_text_preserves_order_and_rejects_fake_suffix(self):
        urls, rejected = core.extract_input_urls(
            "分享 https://v.douyin.com/abc/。 " + PUBLIC_URL + " " + PUBLIC_URL
            + " https://douyin.com.example.test/video/123"
        )
        self.assertEqual(urls, ["https://v.douyin.com/abc/", PUBLIC_URL])
        self.assertEqual(rejected, ["https://douyin.com.example.test/video/123"])

    def test_html_parser_keeps_existing_decoding_and_media_order(self):
        source = r'https:\/\/test.douyinvod.com\/video.mp4?x=1\u0026y=2'
        self.assertEqual(core.extract_urls_from_html(source),
                         ["https://test.douyinvod.com/video.mp4?x=1&y=2"])

    def test_http_download_bytes_and_progress(self):
        events = []
        target = self.root / "video.mp4"
        core.download_media(self.origin + "/full", PUBLIC_URL, target,
                            lambda total, written: events.append((total, written)))
        self.assertEqual(target.read_bytes(), MEDIA)
        self.assertEqual(events[-1], (len(MEDIA), len(MEDIA)))
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_http_unknown_length_reports_none(self):
        events = []
        core.download_media(self.origin + "/unknown", PUBLIC_URL, self.root / "video.mp4",
                            lambda total, written: events.append((total, written)))
        self.assertEqual(events[-1], (None, len(MEDIA)))

    def test_request_timeout_does_not_leave_output(self):
        target = self.root / "video.mp4"
        with patch.object(core.requests, "get", side_effect=requests.Timeout("fixture timeout")):
            with self.assertRaises(requests.Timeout):
                core.download_media(self.origin + "/full", PUBLIC_URL, target, lambda *_: None)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_http_errors_empty_and_truncated_remove_partial(self):
        for endpoint in ("/error", "/empty", "/truncated"):
            with self.subTest(endpoint=endpoint):
                target = self.root / "video.mp4"
                with self.assertRaises((requests.RequestException, RuntimeError)):
                    core.download_media(self.origin + endpoint, PUBLIC_URL, target, lambda *_: None)
                self.assertFalse(target.exists())
                self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_cancel_between_chunks_removes_partial(self):
        cancel = threading.Event()
        target = self.root / "video.mp4"
        with self.assertRaises(core.DownloadCancelled):
            core.download_media(self.origin + "/full", PUBLIC_URL, target,
                                lambda *_: cancel.set(), should_cancel=cancel.is_set)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_existing_partial_is_not_removed_or_overwritten(self):
        target = self.root / "video.mp4"
        partial = target.with_suffix(".mp4.part")
        partial.write_bytes(b"belongs to another transfer")
        with self.assertRaises(FileExistsError):
            core.download_media(self.origin + "/full", PUBLIC_URL, target, lambda *_: None)
        self.assertEqual(partial.read_bytes(), b"belongs to another transfer")

    def test_result_created_after_name_selection_is_not_overwritten_or_deleted(self):
        self.output.mkdir()
        target = self.output / "测试视频.mp4"

        def select(*_args):
            target.write_bytes(b"another instance result")
            return target

        with patch.object(core, "extract_media_with_browser", return_value=self.resolved()), \
             patch.object(core, "unique_output_path", side_effect=select):
            with self.assertRaises(FileExistsError):
                core.download_one(PUBLIC_URL, self.context, lambda *_: None, lambda *_: None)
        self.assertEqual(target.read_bytes(), b"another instance result")
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_concurrent_same_name_has_one_owner_and_preserves_winner(self):
        barrier = threading.Barrier(2, timeout=5)
        target = self.output / "shared.mp4"
        results = []
        errors = []

        def select(*_args):
            barrier.wait()
            return target

        def run():
            try:
                results.append(core.download_one(PUBLIC_URL, self.context, lambda *_: None, lambda *_: None))
            except Exception as error:
                errors.append(error)

        with patch.object(core, "extract_media_with_browser", return_value=self.resolved()), \
             patch.object(core, "unique_output_path", side_effect=select):
            threads = [threading.Thread(target=run) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
        self.assertEqual(len(results), 1)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], FileExistsError)
        self.assertEqual(target.read_bytes(), MEDIA)
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_download_one_injected_paths_metadata_progress_and_names(self):
        self.output.mkdir()
        existing = self.output / "测试视频.mp4"
        existing.write_bytes(b"old result")
        (self.output / "测试视频_1.mp4.part").write_bytes(b"active transfer")
        events = []
        with patch.object(core, "extract_media_with_browser", return_value=self.resolved()):
            candidate = core.download_one(PUBLIC_URL, self.context, events.append, lambda *_: None)
        self.assertEqual(candidate.path, self.output / "测试视频_2.mp4")
        self.assertEqual(candidate.path.read_bytes(), MEDIA)
        self.assertEqual(candidate.title, "测试视频")
        self.assertEqual(candidate.source_url, PUBLIC_URL)
        self.assertEqual(existing.read_bytes(), b"old result")
        self.assertEqual([event["phase"] for event in events][0], "resolving")
        self.assertEqual(events[-1]["phase"], "completed")
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_browser_failure_falls_back_without_logging_signed_error(self):
        logs = []
        with patch.object(core, "extract_media_with_browser", side_effect=RuntimeError("signed?token=secret")), \
             patch.object(core, "extract_media_with_requests", return_value=self.resolved()) as fallback:
            core.download_one(PUBLIC_URL, self.context, lambda *_: None, logs.append)
        fallback.assert_called_once()
        self.assertNotIn("secret", "\n".join(logs))

    def test_browser_cancellation_does_not_fallback(self):
        with patch.object(core, "extract_media_with_browser", side_effect=core.DownloadCancelled()), \
             patch.object(core, "extract_media_with_requests") as fallback:
            with self.assertRaises(core.DownloadCancelled):
                core.download_one(PUBLIC_URL, self.context, lambda *_: None, lambda *_: None)
        fallback.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_cancel_after_edge_launch_failure_does_not_launch_fallback_browser(self):
        from playwright.sync_api import Error as PlaywrightError

        cancel = threading.Event()
        playwright = Mock()

        def fail(**_kwargs):
            cancel.set()
            raise PlaywrightError("fixture Edge startup failed")

        playwright.chromium.launch.side_effect = fail
        manager = Mock()
        manager.__enter__ = Mock(return_value=playwright)
        manager.__exit__ = Mock(return_value=False)
        with patch("playwright.sync_api.sync_playwright", return_value=manager):
            with self.assertRaises(core.DownloadCancelled):
                core.extract_media_with_browser(PUBLIC_URL, lambda *_: None, should_cancel=cancel.is_set)
        playwright.chromium.launch.assert_called_once()

    def test_network_error_hides_signed_url_but_retains_error_kind_and_status(self):
        response = requests.Response()
        response.status_code = 503
        error = requests.HTTPError("failed https://test.douyinvod.com/video.mp4?token=secret", response=response)
        logs = []
        with patch.object(core, "extract_media_with_browser", return_value=self.resolved()), \
             patch.object(core.requests, "get", side_effect=error):
            with self.assertRaises(core.DownloadNetworkError) as caught:
                core.download_one(PUBLIC_URL, self.context, lambda *_: None, logs.append)
        self.assertEqual(caught.exception.error_type, "HTTPError")
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("secret", str(caught.exception) + "\n".join(logs))

    def test_invalid_source_is_rejected_before_io(self):
        with patch.object(core, "extract_media_with_browser") as browser:
            with self.assertRaises(ValueError):
                core.download_one("https://example.test/video/1", self.context,
                                  lambda *_: None, lambda *_: None)
        browser.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_requests_parser_closes_response_and_extracts_title(self):
        response = Mock()
        response.text = '<title>测试 &amp; 标题 - 抖音</title> https://test.douyinvod.com/video.mp4'
        response.url = PUBLIC_URL
        manager = Mock()
        manager.__enter__ = Mock(return_value=response)
        manager.__exit__ = Mock(return_value=False)
        with patch.object(core.requests, "get", return_value=manager):
            resolved = core.extract_media_with_requests(PUBLIC_URL)
        self.assertEqual(resolved, (PUBLIC_URL, "测试 & 标题", "https://test.douyinvod.com/video.mp4", None))
        manager.__exit__.assert_called_once()

    def test_cancel_after_parser_failure_does_not_fallback(self):
        cancel = threading.Event()

        def fail(*_args, **_kwargs):
            cancel.set()
            raise RuntimeError("browser failed after cancellation")

        with patch.object(core, "extract_media_with_browser", side_effect=fail), \
             patch.object(core, "extract_media_with_requests") as fallback:
            with self.assertRaises(core.DownloadCancelled):
                core.download_one(PUBLIC_URL, self.context, lambda *_: None, lambda *_: None, cancel.is_set)
        fallback.assert_not_called()

    def test_separate_tracks_use_scratch_and_shared_ffmpeg(self):
        processes = []

        def launch(command, **kwargs):
            processes.append(FakeProcess(command, **kwargs))
            return processes[-1]

        with patch.object(core, "extract_media_with_browser", return_value=self.resolved(audio=True)), \
             patch.object(core.subprocess, "Popen", side_effect=launch):
            candidate = core.download_one(PUBLIC_URL, self.context, lambda *_: None, lambda *_: None)
        command = processes[0].command
        self.assertEqual(command[0], str(self.context.ffmpeg_path))
        self.assertTrue(Path(command[command.index("-i") + 1]).is_relative_to(self.scratch))
        self.assertEqual(candidate.path.read_bytes(), b"mux-fixture")
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_ffmpeg_failure_removes_part_and_tracks(self):
        with patch.object(core, "extract_media_with_browser", return_value=self.resolved(audio=True)), \
             patch.object(core.subprocess, "Popen", side_effect=lambda command, **kw: FakeProcess(command, result=1, **kw)):
            with self.assertRaisesRegex(RuntimeError, "fixture ffmpeg failure"):
                core.download_one(PUBLIC_URL, self.context, lambda *_: None, lambda *_: None)
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_mux_existing_partial_is_not_overwritten_or_deleted(self):
        target = self.root / "video.mp4"
        partial = target.with_suffix(".mp4.part")
        partial.write_bytes(b"another mux owns this")
        with patch.object(core.subprocess, "Popen") as launch:
            with self.assertRaises(FileExistsError):
                core.mux_media(self.root / "v.mp4", self.root / "a.mp4", target,
                               ffmpeg_path=self.context.ffmpeg_path)
        launch.assert_not_called()
        self.assertEqual(partial.read_bytes(), b"another mux owns this")

    def test_mux_existing_final_is_not_overwritten(self):
        target = self.root / "video.mp4"
        target.write_bytes(b"existing final")
        with patch.object(core.subprocess, "Popen", side_effect=lambda command, **kw: FakeProcess(command, **kw)):
            with self.assertRaises(FileExistsError):
                core.mux_media(self.root / "v.mp4", self.root / "a.mp4", target,
                               ffmpeg_path=self.context.ffmpeg_path)
        self.assertEqual(target.read_bytes(), b"existing final")
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_ffmpeg_cancel_terminates_process_and_hides_window(self):
        processes = []

        def launch(command, **kwargs):
            self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NO_WINDOW if core.os.name == "nt" else 0)
            processes.append(FakeProcess(command, running=True, **kwargs))
            return processes[-1]

        cancellation = Mock(side_effect=[False, True])
        target = self.root / "video.mp4"
        with patch.object(core.subprocess, "Popen", side_effect=launch):
            with self.assertRaises(core.DownloadCancelled):
                core.mux_media(self.root / "v.mp4", self.root / "a.mp4", target,
                               ffmpeg_path=self.context.ffmpeg_path, should_cancel=cancellation)
        self.assertTrue(processes[0].terminated)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_ffmpeg_timeout_reaps_process(self):
        processes = []

        def launch(command, **kwargs):
            processes.append(FakeProcess(command, running=True, **kwargs))
            return processes[-1]

        target = self.root / "video.mp4"
        with patch.object(core.subprocess, "Popen", side_effect=launch), \
             patch.object(core.time, "monotonic", side_effect=[0, 181]):
            with self.assertRaisesRegex(RuntimeError, "超时"):
                core.mux_media(self.root / "v.mp4", self.root / "a.mp4", target,
                               ffmpeg_path=self.context.ffmpeg_path)
        self.assertTrue(processes[0].terminated)
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_host_process_factory_is_used_and_job_closed(self):
        job = Mock()
        processes = []

        def factory(command, **kwargs):
            processes.append(FakeProcess(command, **kwargs))
            return processes[-1], job

        context = core.DownloadContext(self.output, self.scratch, self.context.ffmpeg_path, factory)
        with patch.object(core, "extract_media_with_browser", return_value=self.resolved(audio=True)), \
             patch.object(core.subprocess, "Popen") as standalone:
            result = core.download_one(PUBLIC_URL, context, lambda *_: None, lambda *_: None)
        standalone.assert_not_called()
        job.close.assert_called_once()
        self.assertEqual(result.path.read_bytes(), b"mux-fixture")

    def test_host_job_closed_and_process_reaped_on_cancel(self):
        job = Mock()
        processes = []

        def factory(command, **kwargs):
            processes.append(FakeProcess(command, running=True, **kwargs))
            return processes[-1], job

        target = self.root / "host.mp4"
        with self.assertRaises(core.DownloadCancelled):
            core.mux_media(self.root / "v", self.root / "a", target,
                           ffmpeg_path=self.context.ffmpeg_path, process_factory=factory,
                           should_cancel=Mock(side_effect=[False, True]))
        job.close.assert_called_once()
        self.assertTrue(processes[0].terminated)
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_host_job_closed_on_ffmpeg_failure(self):
        job = Mock()

        def factory(command, **kwargs):
            return FakeProcess(command, result=1, **kwargs), job

        target = self.root / "host-failed.mp4"
        with self.assertRaisesRegex(RuntimeError, "fixture ffmpeg failure"):
            core.mux_media(self.root / "v", self.root / "a", target,
                           ffmpeg_path=self.context.ffmpeg_path, process_factory=factory)
        job.close.assert_called_once()
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".mp4.part").exists())

    def test_ffmpeg_kills_when_terminate_does_not_finish(self):
        processes = []

        def launch(command, **kwargs):
            process = FakeProcess(command, running=True, **kwargs)
            process.terminate = Mock()  # Does not change running state.
            processes.append(process)
            return process

        with patch.object(core.subprocess, "Popen", side_effect=launch):
            with self.assertRaises(core.DownloadCancelled):
                core.mux_media(self.root / "v.mp4", self.root / "a.mp4", self.root / "out.mp4",
                               ffmpeg_path=self.context.ffmpeg_path,
                               should_cancel=Mock(side_effect=[False, True]))
        processes[0].terminate.assert_called_once()
        self.assertTrue(processes[0].killed)

    def test_legacy_wrapper_returns_path_and_gui_uses_core(self):
        events = []
        with patch.object(core, "extract_media_with_browser", return_value=self.resolved()):
            target = core.download_from_link(PUBLIC_URL, self.output, lambda *_: None,
                                             lambda total, written: events.append((total, written)))
        self.assertIsInstance(target, Path)
        self.assertEqual(events[-1], (len(MEDIA), len(MEDIA)))
        gui = importlib.import_module("douyin_downloader_gui")
        self.assertIs(gui.download_from_link, core.download_from_link)


if __name__ == "__main__":
    unittest.main()
