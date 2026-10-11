from __future__ import annotations

import argparse
import base64
import http.client
import json
import logging
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from contextlib import contextmanager
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

from cost_sync.locks import InterprocessMutex
from cost_sync.local_api import (
    EXTENSION_ORIGIN,
    MAX_CATALOG_FILE_BYTES,
    SHANGHAI,
    CatalogImportManager,
    MappingImportManager,
    create_management_lock,
    create_server,
    database_service_id,
)
from cost_sync.mapping_review import (
    read_mapping_review_candidates,
    resolve_mapping_review_candidate,
)
from cost_sync.official_service_fee import load_bundled_service_fee_catalog
from cost_sync.shipping import (
    apply_shipping_product_bindings,
    apply_shipping_template_update,
    list_shipping_product_bindings,
    list_shipping_templates,
    normalize_shipping_product_bindings,
    normalize_shipping_template,
)
from cost_sync.service_fee import (
    archive_legacy_service_fee_rates,
    apply_basic_service_fee_update,
    import_official_service_fee_catalog,
    list_basic_service_fee_coverage,
    list_basic_service_fee_rates,
    normalize_basic_service_fee_change,
    preview_legacy_service_fee_archive,
)


APP_NAME = "成本助手"
SERVICE_START_MUTEX_PREFIX = "Local\\CostAssistant.ServiceStart"
DESKTOP_WINDOW_MUTEX_NAME = "Local\\CostAssistant.DesktopWindow"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def installed_data_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent.parent / "data"
    return PROJECT_ROOT / "storage" / "test"


def probe_health(port: int, *, timeout: float = 1.0) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=timeout
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
        return None
    return payload if isinstance(payload, dict) else None


@contextmanager
def service_start_lock(port: int):
    with InterprocessMutex(
        f"{SERVICE_START_MUTEX_PREFIX}.{port}", timeout_ms=15_000
    ):
        yield


@contextmanager
def desktop_window_instance():
    if os.name != "nt":
        yield True
        return

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_mutex = kernel32.CreateMutexW
    create_mutex.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    create_mutex.restype = wintypes.HANDLE
    release_mutex = kernel32.ReleaseMutex
    release_mutex.argtypes = [wintypes.HANDLE]
    release_mutex.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL

    handle = create_mutex(None, True, DESKTOP_WINDOW_MUTEX_NAME)
    if not handle:
        raise RuntimeError("无法创建成本助手窗口锁")
    is_primary = ctypes.get_last_error() != 183
    try:
        yield is_primary
    finally:
        if is_primary:
            release_mutex(handle)
        close_handle(handle)


def activate_existing_desktop_window(*, timeout: float = 2.0) -> bool:
    if os.name != "nt":
        return False

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    find_window = user32.FindWindowW
    find_window.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    find_window.restype = wintypes.HWND
    is_iconic = user32.IsIconic
    is_iconic.argtypes = [wintypes.HWND]
    is_iconic.restype = wintypes.BOOL
    show_window = user32.ShowWindow
    show_window.argtypes = [wintypes.HWND, ctypes.c_int]
    show_window.restype = wintypes.BOOL
    set_foreground_window = user32.SetForegroundWindow
    set_foreground_window.argtypes = [wintypes.HWND]
    set_foreground_window.restype = wintypes.BOOL

    title = f"{APP_NAME} · 一体化管理台"
    deadline = time.monotonic() + timeout
    while True:
        handle = find_window(None, title)
        if handle:
            if is_iconic(handle):
                show_window(handle, 9)
            return bool(set_foreground_window(handle))
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


@dataclass(frozen=True)
class ServicePaths:
    database: Path
    output_excel: Path
    logs: Path

    @classmethod
    def from_data_directory(cls, data_directory: str | Path) -> "ServicePaths":
        data = Path(data_directory).resolve()
        return cls(
            database=data / "cost_accounting.sqlite3",
            output_excel=data / "enabled_product_costs.xlsx",
            logs=data.parent / "logs",
        )


class DesktopAdmin:
    """Desktop-only bridge that reuses the existing guarded import managers."""

    def __init__(
        self,
        catalog_manager: CatalogImportManager,
        mapping_manager: MappingImportManager,
    ) -> None:
        self.catalog_manager = catalog_manager
        self.mapping_manager = mapping_manager
        self._shipping_preview: dict[str, object] | None = None
        self._shipping_binding_preview: dict[str, object] | None = None
        self._service_fee_preview: dict[str, object] | None = None

    @staticmethod
    def _upload(path_value: str | Path, label: str) -> dict[str, str]:
        path = Path(path_value).resolve()
        if path.suffix.lower() != ".xlsx" or not path.is_file():
            raise ValueError(f"{label}必须是可读取的 XLSX 文件")
        content = path.read_bytes()
        if len(content) > MAX_CATALOG_FILE_BYTES:
            raise ValueError(f"{label}超过 16 MB 安全上限")
        return {
            "name": path.name,
            "content_base64": base64.b64encode(content).decode("ascii"),
        }

    def preview_catalog(
        self, ordinary_path: str | Path, combination_path: str | Path
    ) -> dict[str, object]:
        return self.catalog_manager.preview(
            {
                "ordinary": self._upload(ordinary_path, "普通商品表"),
                "combination": self._upload(combination_path, "组合商品表"),
            }
        )

    def apply_catalog(self, preview_id: str) -> dict[str, object]:
        return self.catalog_manager.apply({"preview_id": preview_id})

    def preview_mapping(
        self, shop_name: str, mapping_path: str | Path
    ) -> dict[str, object]:
        return self.mapping_manager.preview(
            {
                "shop_name": shop_name,
                "mapping": self._upload(mapping_path, "抖店商品表"),
            }
        )

    def apply_mapping(self, preview_id: str) -> dict[str, object]:
        return self.mapping_manager.apply({"preview_id": preview_id})

    def save_mapping_reviews(self, preview_id: str) -> dict[str, object]:
        return self.mapping_manager.save_reviews({"preview_id": preview_id})

    def get_mapping_reviews(self) -> dict[str, object]:
        return read_mapping_review_candidates(self.mapping_manager.database_path)

    def resolve_mapping_review(
        self, candidate_id: int, jushuitan_sku_id: str
    ) -> dict[str, object]:
        result = resolve_mapping_review_candidate(
            self.mapping_manager.database_path,
            candidate_id,
            jushuitan_sku_id,
            resolved_at=datetime.now(SHANGHAI).replace(microsecond=0).isoformat(),
        )
        return {
            "candidate_id": result.candidate_id,
            "batch_id": result.batch_id,
            "shop_name": result.shop_name,
            "douyin_sku_id": result.douyin_sku_id,
            "jushuitan_sku_id": result.jushuitan_sku_id,
            "previous_shop_name": result.previous_shop_name,
            "backup_file": result.backup_path.name,
        }

    def get_shipping_templates(self) -> list[dict[str, object]]:
        return list_shipping_templates(self.mapping_manager.database_path)

    def get_shipping_product_bindings(self) -> dict[str, object]:
        return list_shipping_product_bindings(self.mapping_manager.database_path)

    def preview_shipping_product_bindings(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        normalized = normalize_shipping_product_bindings(payload)
        preview_id = secrets.token_urlsafe(24)
        self._shipping_binding_preview = {
            "preview_id": preview_id,
            "database_revision": _database_revision(self.mapping_manager.database_path),
            "bindings": normalized,
        }
        return {"preview_id": preview_id, **normalized}

    def apply_shipping_product_bindings(self, preview_id: str) -> dict[str, object]:
        session = self._shipping_binding_preview
        if (
            session is None
            or not isinstance(session.get("preview_id"), str)
            or not secrets.compare_digest(str(session["preview_id"]), preview_id)
        ):
            raise ValueError("商品运费模板绑定预览已失效，请重新预览")
        database = self.mapping_manager.database_path
        if _database_revision(database) != session["database_revision"]:
            self._shipping_binding_preview = None
            raise ValueError("成本库在预览后已更新，请重新预览商品绑定")
        bindings = session["bindings"]
        if not isinstance(bindings, dict):
            raise ValueError("商品运费模板绑定预览无效")
        result = apply_shipping_product_bindings(
            database, bindings,
            changed_at=datetime.now(SHANGHAI).replace(microsecond=0).isoformat(),
        )
        self._shipping_binding_preview = None
        return result

    def preview_shipping_template(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        normalized = normalize_shipping_template(payload)
        preview_id = secrets.token_urlsafe(24)
        self._shipping_preview = {
            "preview_id": preview_id,
            "database_revision": _database_revision(self.mapping_manager.database_path),
            "template": normalized,
        }
        return {
            "preview_id": preview_id,
            "mode": "create" if normalized["template_id"] is None else "update",
            **normalized,
        }

    def apply_shipping_template(self, preview_id: str) -> dict[str, object]:
        session = self._shipping_preview
        if (
            session is None
            or not isinstance(session.get("preview_id"), str)
            or not secrets.compare_digest(str(session["preview_id"]), preview_id)
        ):
            raise ValueError("运费模板预览已失效，请重新预览")
        database = self.mapping_manager.database_path
        if _database_revision(database) != session["database_revision"]:
            self._shipping_preview = None
            raise ValueError("成本库在预览后已更新，请重新预览运费模板")
        template = session["template"]
        if not isinstance(template, dict):
            raise ValueError("运费模板预览无效")
        result = apply_shipping_template_update(
            database,
            template,
            changed_at=datetime.now(SHANGHAI).replace(microsecond=0).isoformat(),
        )
        self._shipping_preview = None
        return result

    def get_basic_service_fee_rates(
        self, *, archived: bool = False
    ) -> list[dict[str, object]]:
        return list_basic_service_fee_rates(
            self.mapping_manager.database_path, archived=archived
        )

    def get_basic_service_fee_coverage(self) -> list[dict[str, int]]:
        coverage = list_basic_service_fee_coverage(self.mapping_manager.database_path)
        return [
            {"rate_id": rate_id, "product_coverage_count": count}
            for rate_id, count in coverage.items()
        ]

    def preview_legacy_service_fee_archive(self) -> dict[str, object]:
        database = self.mapping_manager.database_path
        preview = preview_legacy_service_fee_archive(database)
        preview_id = secrets.token_urlsafe(24)
        self._service_fee_preview = {
            "preview_id": preview_id,
            "database_revision": _database_revision(database),
            "legacy_archive": preview,
        }
        return {"preview_id": preview_id, **preview}

    def apply_legacy_service_fee_archive(self, preview_id: str) -> dict[str, object]:
        session = self._service_fee_preview
        if (
            session is None
            or not isinstance(session.get("preview_id"), str)
            or not secrets.compare_digest(str(session["preview_id"]), preview_id)
            or "legacy_archive" not in session
        ):
            raise ValueError("旧基础服务费归档预览已失效，请重新预览")
        database = self.mapping_manager.database_path
        if _database_revision(database) != session["database_revision"]:
            self._service_fee_preview = None
            raise ValueError("成本库在预览后已更新，请重新预览旧费率归档")
        result = archive_legacy_service_fee_rates(
            database,
            changed_at=datetime.now(SHANGHAI).replace(microsecond=0).isoformat(),
        )
        self._service_fee_preview = None
        return result

    def preview_official_service_fee_catalog(self) -> dict[str, object]:
        catalog = load_bundled_service_fee_catalog()
        preview_id = secrets.token_urlsafe(24)
        self._service_fee_preview = {
            "preview_id": preview_id,
            "database_revision": _database_revision(self.mapping_manager.database_path),
            "official_catalog": catalog,
        }
        return {
            "preview_id": preview_id,
            "source_article_id": catalog["source_article_id"],
            "source_name": catalog.get("source_name", "抖店官方基础服务费率"),
            "source_url": catalog.get("source_url", ""),
            "source_updated_at": catalog["source_updated_at"],
            "effective_from": catalog["effective_from"],
            "rule_count": len(catalog["rules"]),
        }

    def apply_official_service_fee_catalog(self, preview_id: str) -> dict[str, object]:
        session = self._service_fee_preview
        if (
            session is None
            or not isinstance(session.get("preview_id"), str)
            or not secrets.compare_digest(str(session["preview_id"]), preview_id)
        ):
            raise ValueError("官方费率目录预览已失效，请重新预览")
        database = self.mapping_manager.database_path
        if _database_revision(database) != session["database_revision"]:
            self._service_fee_preview = None
            raise ValueError("成本库在预览后已更新，请重新预览官方费率目录")
        catalog = session.get("official_catalog")
        if not isinstance(catalog, dict) or not isinstance(catalog.get("rules"), list):
            raise ValueError("官方费率目录预览无效")
        result = import_official_service_fee_catalog(
            database,
            catalog["rules"],
            source_article_id=str(catalog["source_article_id"]),
            source_updated_at=str(catalog["source_updated_at"]),
            effective_from=str(catalog["effective_from"]),
            imported_at=datetime.now(SHANGHAI).replace(microsecond=0).isoformat(),
        )
        self._service_fee_preview = None
        return result

    def preview_basic_service_fee_change(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        normalized = normalize_basic_service_fee_change(payload)
        preview_id = secrets.token_urlsafe(24)
        self._service_fee_preview = {
            "preview_id": preview_id,
            "database_revision": _database_revision(self.mapping_manager.database_path),
            "change": normalized,
        }
        return {"preview_id": preview_id, **normalized}

    def apply_basic_service_fee_change(self, preview_id: str) -> dict[str, object]:
        session = self._service_fee_preview
        if (
            session is None
            or not isinstance(session.get("preview_id"), str)
            or not secrets.compare_digest(str(session["preview_id"]), preview_id)
        ):
            raise ValueError("基础服务费预览已失效，请重新预览")
        database = self.mapping_manager.database_path
        if _database_revision(database) != session["database_revision"]:
            self._service_fee_preview = None
            raise ValueError("成本库在预览后已更新，请重新预览基础服务费")
        change = session["change"]
        if not isinstance(change, dict):
            raise ValueError("基础服务费预览无效")
        result = apply_basic_service_fee_update(
            database,
            change,
            changed_at=datetime.now(SHANGHAI).isoformat(),
        )
        self._service_fee_preview = None
        return result


def _database_revision(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


class AssistantService:
    def __init__(
        self,
        paths: ServicePaths,
        *,
        environment: str = "test",
        port: int = 8765,
    ) -> None:
        self.paths = paths
        self.environment = environment
        self.port = port
        self._server = None
        self._thread: threading.Thread | None = None
        management_lock = create_management_lock(paths.database)
        self.catalog_manager = CatalogImportManager(
            paths.database, paths.output_excel, lock=management_lock
        )
        self.mapping_manager = MappingImportManager(
            paths.database, lock=management_lock
        )
        self.admin = DesktopAdmin(self.catalog_manager, self.mapping_manager)

    @property
    def owns_running_service(self) -> bool:
        return self._server is not None and self._thread is not None and self._thread.is_alive()

    def matches_running_service(self, health: dict[str, object] | None) -> bool:
        if not health or health.get("status") != "ok":
            return False
        if health.get("environment") != self.environment:
            return False
        return health.get("service_id") == database_service_id(self.paths.database)

    def start(self) -> str:
        with service_start_lock(self.port):
            if self.owns_running_service:
                return "already_owned"
            health = probe_health(self.port)
            if health is not None:
                if self.matches_running_service(health):
                    return "already_running"
                raise RuntimeError(
                    f"本机端口 {self.port} 已被其它环境或数据目录的服务占用"
                )
            if not self.paths.database.is_file():
                raise FileNotFoundError("成本数据库不存在；请确认成本助手数据目录完整")
            self.paths.logs.mkdir(parents=True, exist_ok=True)
            self._server = create_server(
                self.paths.database,
                port=self.port,
                allowed_origins=(EXTENSION_ORIGIN,),
                environment=self.environment,
                output_excel_path=self.paths.output_excel,
                catalog_manager=self.catalog_manager,
                mapping_manager=self.mapping_manager,
            )
            self._thread = threading.Thread(
                target=self._server.serve_forever,
                kwargs={"poll_interval": 0.2},
                name="cost-assistant-local-api",
                daemon=True,
            )
            self._thread.start()
            return "started"

    def stop(self) -> bool:
        if not self.owns_running_service:
            return False
        server = self._server
        thread = self._thread
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        self._server = None
        self._thread = None
        return True


def configure_logging(log_directory: Path) -> logging.Logger:
    log_directory.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("cost-assistant")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        handler = RotatingFileHandler(
            log_directory / "cost-assistant.log",
            maxBytes=1_000_000,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logger.addHandler(handler)
    return logger


def read_log_tail(
    log_path: Path,
    *,
    known_signature: tuple[int, int] | None = None,
    max_bytes: int = 128 * 1024,
    max_lines: int = 300,
) -> tuple[str | None, tuple[int, int]]:
    """Read only the end of the log and skip decoding when it has not changed."""

    try:
        stat = log_path.stat()
    except FileNotFoundError:
        signature = (-1, -1)
        content = "尚无日志。服务启动或执行预览后会在这里显示记录。"
        return (None if known_signature == signature else content), signature
    except OSError as exc:
        return f"日志暂时无法读取：{exc}", (-2, -2)

    signature = (stat.st_size, stat.st_mtime_ns)
    if known_signature == signature:
        return None, signature
    try:
        with log_path.open("rb") as stream:
            start = max(0, stat.st_size - max_bytes)
            stream.seek(start)
            payload = stream.read(max_bytes)
        if start:
            newline = payload.find(b"\n")
            payload = payload[newline + 1 :] if newline >= 0 else b""
        lines = payload.decode("utf-8", errors="replace").splitlines()
        return "\n".join(lines[-max_lines:]) or "尚无日志。", signature
    except OSError as exc:
        return f"日志暂时无法读取：{exc}", signature


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="成本助手 Windows 客户端")
    parser.add_argument("--data-dir", default=str(installed_data_directory()))
    parser.add_argument("--environment", choices=("test", "production"), default="test")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--start", dest="auto_start", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--no-start", dest="auto_start", action="store_false", help=argparse.SUPPRESS)
    parser.set_defaults(auto_start=True)
    parser.add_argument("--self-test", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--webview-smoke-test", action="store_true", help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    args = build_parser().parse_args(arguments)
    paths = ServicePaths.from_data_directory(args.data_dir)
    logger = configure_logging(paths.logs)
    logger.info("当前成本数据库：%s", paths.database.resolve())
    service = AssistantService(paths, environment=args.environment, port=args.port)
    if args.self_test:
        try:
            result = service.start()
            health = probe_health(args.port, timeout=2)
            return 0 if result == "started" and health and health.get("status") == "ok" else 1
        finally:
            service.stop()
    if args.webview_smoke_test:
        from cost_sync.webview_app import run_webview_smoke_test

        return run_webview_smoke_test(service, logger)
    from cost_sync.webview_app import _notify, run_webview_app

    with desktop_window_instance() as is_primary:
        if not is_primary:
            if activate_existing_desktop_window():
                logger.info("重复启动已切换到现有成本助手窗口")
            else:
                logger.warning("检测到现有成本助手窗口，但未能将其置于前台")
            return 0
        try:
            return run_webview_app(service, logger, auto_start=args.auto_start)
        except Exception as exc:
            logger.exception("WebView2 桌面窗口启动失败")
            _notify(
                "成本助手无法启动 WebView2 桌面界面。\n\n"
                f"{exc}\n\n"
                "请按安装包说明安装 Microsoft Edge WebView2 Runtime 后重试。"
            )
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
