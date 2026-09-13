#!/usr/bin/env python3
"""抖店商机中心可视化采集控制台。"""

from __future__ import annotations

import argparse
import copy
import json
import math
import mimetypes
import os
import threading
import traceback
import webbrowser
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import collect as collector


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
MAX_BODY_BYTES = 1_000_000


def public_result(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "clueId": item.get("clue_id"),
        "categoryPath": item.get("category_path"),
        "productName": item.get("product_name"),
        "pay30dRange": item.get("pay_30d_range"),
        "today": item.get("today"),
        "growth": item.get("growth"),
        "classification": item.get("classification"),
    }


def public_state(state: dict[str, Any] | None) -> dict[str, Any] | None:
    if not state:
        return None
    return {
        "taskId": state.get("task_id"),
        "taskName": state.get("task_name"),
        "status": state.get("status"),
        "createdAt": state.get("created_at"),
        "updatedAt": state.get("updated_at"),
        "completedAt": state.get("completed_at"),
        "category": state.get("category"),
        "minAmount": state.get("min_amount"),
        "currentPage": state.get("current_page", 0),
        "nextPage": state.get("next_page", 1),
        "coverageComplete": state.get("coverage_complete", False),
        "stats": state.get("stats", {}),
        "authRoute": state.get("auth_route"),
        "lastError": state.get("last_error"),
        "reportFiles": state.get("report_files"),
        "latestResults": [public_result(item) for item in state.get("results", [])[-10:]],
    }


class TaskManager:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.thread: threading.Thread | None = None
        self.checkpoint: Path | None = None
        self.state: dict[str, Any] | None = None
        self.auth: tuple[str, str, str] | None = None
        self.categories_cache: list[dict[str, Any]] | None = None
        self.phase = "idle"
        self.logs: deque[dict[str, str]] = deque(maxlen=400)
        collector.log = self.log
        self.history_cache = self._load_history()

    def log(self, message: str) -> None:
        line = {"at": collector.now_iso(), "message": str(message)}
        with self.lock:
            self.logs.append(line)
        print(f"[WEB] {message}", flush=True)

    def _is_active(self) -> bool:
        return bool(self.thread and self.thread.is_alive())

    def _publish_state(self, state: dict[str, Any]) -> None:
        snapshot = copy.deepcopy(state)
        with self.lock:
            self.state = snapshot

    def _read_checkpoint(self) -> dict[str, Any] | None:
        with self.lock:
            checkpoint = self.checkpoint
            fallback = copy.deepcopy(self.state)
        if fallback is not None:
            return fallback
        if checkpoint and checkpoint.is_file():
            try:
                return collector.read_json(checkpoint)
            except (OSError, json.JSONDecodeError):
                pass
        return None

    def status(self) -> dict[str, Any]:
        with self.lock:
            state = copy.deepcopy(self.state)
            phase = self.phase
            active = self._is_active()
            logs = list(self.logs)
        if active and collector.PAUSE_EVENT.is_set():
            phase = "paused"
        return {
            "ok": True,
            "phase": phase,
            "active": active,
            "pauseRequested": collector.PAUSE_EVENT.is_set(),
            "stopRequested": collector.STOP_EVENT.is_set(),
            "task": public_state(state),
            "logs": logs,
        }

    def check_auth(self) -> dict[str, Any]:
        with self.lock:
            cached = self.auth
        if cached is not None:
            return {"ok": True, "route": cached[2], "message": "Edge 登录态已就绪"}
        args = argparse.Namespace(
            auth="auto",
            cdp_url=collector.CDP_URL,
            no_auto_launch_edge=False,
            cookie_file=str(ROOT / "cookie.txt"),
            user_agent=collector.DEFAULT_USER_AGENT,
        )
        cookie, user_agent, route = collector.resolve_auth(args)
        with self.lock:
            self.auth = (cookie, user_agent, route)
        return {"ok": True, "route": route, "message": "Edge 登录态可用"}

    def categories(self) -> list[dict[str, Any]]:
        with self.lock:
            cached = self.categories_cache
        if cached is not None:
            return cached
        categories = collector.read_edge_categories()
        with self.lock:
            self.categories_cache = categories
        return categories

    def _arguments(self, payload: dict[str, Any]) -> argparse.Namespace:
        try:
            category_id = int(payload.get("categoryId", 1000002718))
            second_category_id = int(payload.get("secondCategoryId") or 0) or None
            third_category_id = int(payload.get("thirdCategoryId") or 0) or None
            min_amount = float(payload.get("minAmount", 750000))
            max_pages = int(payload.get("maxPages", 1))
            page_interval = float(payload.get("pageInterval", 20))
            batch_size = int(payload.get("batchSize", 6))
        except (TypeError, ValueError) as error:
            raise collector.CollectorError("任务参数格式错误") from error
        category_name = str(payload.get("categoryName") or "传统滋补").strip()
        if category_id <= 0 or not category_name:
            raise collector.CollectorError("类目名称和类目 ID 不能为空")
        if third_category_id and not second_category_id:
            raise collector.CollectorError("选择三级类目前必须先选择二级类目")
        if not math.isfinite(min_amount) or min_amount < 0:
            raise collector.CollectorError("最低成交金额必须是大于或等于 0 的数字")
        if max_pages < 0:
            raise collector.CollectorError("采集页数不能小于 0")
        if not 0 <= page_interval <= 600:
            raise collector.CollectorError("页间等待必须在 0～600 秒之间")
        if not 1 <= batch_size <= 6:
            raise collector.CollectorError("指标并发必须在 1～6 之间")
        return argparse.Namespace(
            category_id=category_id,
            second_category_id=second_category_id,
            third_category_id=third_category_id,
            category_name=category_name,
            min_amount=min_amount,
            cookie_file=str(ROOT / "cookie.txt"),
            user_agent=collector.DEFAULT_USER_AGENT,
            page_size=18,
            page_interval=page_interval,
            batch_size=batch_size,
            max_pages=max_pages,
            checkpoint_dir=str(ROOT / "data" / "checkpoints"),
            output_dir=str(ROOT / "reports"),
            fresh=bool(payload.get("fresh", True)),
            retry_failures=False,
            auth="auto",
            cdp_url=collector.CDP_URL,
            no_auto_launch_edge=False,
            check_auth=False,
            self_test=False,
            pause_on_checkpoint_conflict=True,
            state_listener=self._publish_state,
        )

    def start(self, payload: dict[str, Any], retry_failures: bool = False) -> dict[str, Any]:
        with self.lock:
            if self._is_active():
                raise collector.CollectorError("已有采集任务正在运行")
            args = self._arguments(payload)
            args.retry_failures = retry_failures
            collector.STOP_EVENT.clear()
            collector.PAUSE_EVENT.clear()
            self.logs.clear()
            self.state = None
            self.checkpoint = None
            self.phase = "authenticating"
            self.thread = threading.Thread(
                target=self._run,
                args=(args,),
                name="business-collector",
                daemon=True,
            )
            self.thread.start()
        return {"ok": True, "message": "任务已创建"}

    def _run(self, args: argparse.Namespace) -> None:
        client: collector.ApiClient | None = None
        state: dict[str, Any] | None = None
        checkpoint: Path | None = None
        try:
            with self.lock:
                auth = self.auth
            if auth is None:
                self.log("正在自动检测 Edge 登录态")
                auth = collector.resolve_auth(args)
                with self.lock:
                    self.auth = auth
            else:
                self.log("使用已检测的 Edge 登录态")
            cookie, user_agent, auth_route = auth
            state, checkpoint = collector.load_or_create_state(args)
            state["auth_route"] = auth_route
            with self.lock:
                self.state = copy.deepcopy(state)
                self.checkpoint = checkpoint
                self.phase = "running"
            client = collector.ApiClient(cookie, user_agent)
            if args.retry_failures:
                state = collector.retry_failures(args, client, state, checkpoint)
            else:
                state = collector.collect(args, client, state, checkpoint)
        except collector.ImmediateStopError as error:
            if state is not None:
                state["status"], state["last_error"] = "stopped", str(error)
            self.log(str(error))
        except collector.CheckpointIOError as error:
            if state is not None:
                state["status"] = "stopped" if collector.STOP_EVENT.is_set() else "failed"
                state["last_error"] = str(error)
            self.log(f"本地检查点写入失败：{error}")
        except Exception as error:
            if state is not None:
                state["status"], state["last_error"] = "failed", str(error)
            self.log(f"任务失败：{error}")
            traceback.print_exc()
        finally:
            try:
                if client is not None:
                    try:
                        client.close()
                    except Exception as error:
                        self.log(f"关闭平台连接失败：{error}")
                if state is not None and checkpoint is not None:
                    try:
                        collector.save_state(state, checkpoint)
                    except collector.CheckpointIOError as error:
                        state["last_error"] = str(error)
                        self.log(f"本地检查点未能保存：{error}")
                    try:
                        files = collector.save_reports(state, Path(args.output_dir))
                        self.log(f"报告已生成：{files['xlsx']}")
                    except Exception as error:
                        state["status"], state["last_error"] = "failed", f"报告生成失败：{error}"
                        self.log(state["last_error"])
                    try:
                        collector.save_state(state, checkpoint)
                    except collector.CheckpointIOError as error:
                        state["last_error"] = str(error)
                        self.log(f"报告路径未能写回检查点：{error}")
            finally:
                try:
                    with self.lock:
                        self.state = copy.deepcopy(state)
                        self.phase = state.get("status", "failed") if state else "failed"
                        if state is not None:
                            self._cache_history_state(state)
                finally:
                    collector.PAUSE_EVENT.clear()
                    collector.STOP_EVENT.clear()

    def pause(self) -> dict[str, Any]:
        with self.lock:
            if not self._is_active():
                raise collector.CollectorError("当前没有可暂停的任务")
            collector.PAUSE_EVENT.set()
            self.phase = "paused"
        self.log("已请求暂停，将在当前指标批次结束后生效")
        return {"ok": True}

    def resume(self) -> dict[str, Any]:
        with self.lock:
            if not self._is_active():
                raise collector.CollectorError("当前没有可继续的任务")
            collector.PAUSE_EVENT.clear()
            self.phase = "running"
        self.log("任务已继续")
        return {"ok": True}

    def stop(self) -> dict[str, Any]:
        with self.lock:
            if not self._is_active():
                raise collector.CollectorError("当前没有可停止的任务")
            collector.STOP_EVENT.set()
            collector.PAUSE_EVENT.clear()
            self.phase = "stopping"
        self.log("已请求停止，将保存检查点和部分报告")
        return {"ok": True}

    def retry(self) -> dict[str, Any]:
        state = self._read_checkpoint()
        if not state or not state.get("failures"):
            raise collector.CollectorError("当前任务没有失败商品可重试")
        payload = {
            "categoryId": state["category"]["first_cid"],
            "secondCategoryId": state["category"].get("second_cid"),
            "thirdCategoryId": state["category"].get("third_cid"),
            "categoryName": state["category"]["name"],
            "minAmount": state["min_amount"],
            "maxPages": 0,
            "pageInterval": state.get("page_interval", 20),
            "batchSize": state.get("batch_size", 6),
            "fresh": False,
        }
        return self.start(payload, retry_failures=True)

    def _load_history(self, recover_temps: bool = False) -> list[dict[str, Any]]:
        directory = ROOT / "data" / "checkpoints"
        if not directory.is_dir():
            return []
        items = []
        checkpoint_paths = set(directory.glob("api-*.json"))
        if recover_temps:
            for temporary in directory.glob("api-*.json.*.tmp"):
                checkpoint_name = temporary.name.split(".json.", 1)[0] + ".json"
                checkpoint_paths.add(directory / checkpoint_name)
        for path in checkpoint_paths:
            try:
                state = collector.recover_checkpoint(path) if recover_temps else collector.read_json(path)
                if state is not None:
                    items.append(public_state(state))
            except (collector.CollectorError, OSError, json.JSONDecodeError):
                continue
        return sorted(items, key=lambda item: str(item.get("updatedAt") or ""), reverse=True)[:20]

    def refresh_history(self, recover_temps: bool = False) -> None:
        items = self._load_history(recover_temps)
        with self.lock:
            self.history_cache = items

    def _cache_history_state(self, state: dict[str, Any]) -> None:
        item = public_state(copy.deepcopy(state))
        if item is None:
            return
        task_id = item.get("taskId")
        self.history_cache = [cached for cached in self.history_cache if cached.get("taskId") != task_id]
        self.history_cache.append(item)
        self.history_cache.sort(key=lambda cached: str(cached.get("updatedAt") or ""), reverse=True)
        del self.history_cache[20:]

    def history(self) -> list[dict[str, Any]]:
        with self.lock:
            return copy.deepcopy(self.history_cache)

    def report_path(self, kind: str) -> Path:
        state = self._read_checkpoint()
        report_files = state.get("report_files") if state else None
        candidate = Path(str((report_files or {}).get(kind) or ""))
        reports_root = (ROOT / "reports").resolve()
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as error:
            raise collector.CollectorError("报告文件尚未生成") from error
        if reports_root not in resolved.parents:
            raise collector.CollectorError("报告路径无效")
        return resolved


MANAGER = TaskManager()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "BusinessCollector/1.0"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def send_json(self, value: Any, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            raise collector.CollectorError("请求内容过大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise collector.CollectorError("请求 JSON 格式错误") from error
        if not isinstance(value, dict):
            raise collector.CollectorError("请求内容必须是对象")
        return value

    def do_GET(self) -> None:
        try:
            url = urlparse(self.path)
            if url.path == "/api/status":
                self.send_json(MANAGER.status())
                return
            if url.path == "/api/history":
                self.send_json({"ok": True, "tasks": MANAGER.history()})
                return
            if url.path == "/api/categories":
                self.send_json({"ok": True, "categories": MANAGER.categories()})
                return
            if url.path == "/api/download":
                kind = parse_qs(url.query).get("type", ["xlsx"])[0]
                if kind not in ("xlsx", "markdown", "json"):
                    raise collector.CollectorError("报告类型无效")
                self.send_file(MANAGER.report_path(kind))
                return
            self.send_static(url.path)
        except collector.CollectorError as error:
            self.send_json({"ok": False, "message": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self.send_json({"ok": False, "message": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        try:
            url = urlparse(self.path)
            payload = self.read_json()
            routes = {
                "/api/auth/check": lambda: MANAGER.check_auth(),
                "/api/task/start": lambda: MANAGER.start(payload),
                "/api/task/pause": MANAGER.pause,
                "/api/task/resume": MANAGER.resume,
                "/api/task/stop": MANAGER.stop,
                "/api/task/retry": MANAGER.retry,
            }
            action = routes.get(url.path)
            if action is None:
                self.send_json({"ok": False, "message": "接口不存在"}, HTTPStatus.NOT_FOUND)
                return
            self.send_json(action())
        except collector.CollectorError as error:
            self.send_json({"ok": False, "message": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self.send_json({"ok": False, "message": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def send_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        candidate = (PUBLIC_DIR / relative).resolve()
        if PUBLIC_DIR.resolve() not in candidate.parents and candidate != (PUBLIC_DIR / "index.html").resolve():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path) -> None:
        data = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(path.name)}")
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="抖店商机中心可视化采集控制台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    MANAGER.refresh_history(recover_temps=True)
    server = HTTPServer(("127.0.0.1", args.port), RequestHandler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"可视化采集控制台已启动：{url}", flush=True)
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        collector.STOP_EVENT.set()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
