from __future__ import annotations

import logging
import os
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit, urlunsplit

from cost_sync.desktop_app import APP_NAME, AssistantService, probe_health, read_log_tail
from cost_sync.update_history import read_update_history
from cost_sync.update_rollback import rollback_latest_update


WEBVIEW2_DOWNLOAD_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"
WEBVIEW2_RUNTIME_NAME = "Microsoft Edge WebView2 Runtime"
WEBVIEW2_REGISTRY_PATHS = (
    r"SOFTWARE\Microsoft\EdgeUpdate\Clients",
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
)
BRIDGE_ACTIONS = frozenset(
    {
        "get_state",
        "get_update_history",
        "get_mapping_reviews",
        "get_shipping_templates",
        "get_shipping_product_bindings",
        "get_basic_service_fee_rates",
        "get_basic_service_fee_coverage",
        "preview_legacy_service_fee_archive",
        "apply_legacy_service_fee_archive",
        "rollback_update",
        "start_service",
        "stop_service",
        "choose_file",
        "preview_catalog",
        "apply_catalog",
        "preview_mapping",
        "apply_mapping",
        "save_mapping_reviews",
        "resolve_mapping_review",
        "preview_shipping_template",
        "apply_shipping_template",
        "preview_shipping_product_bindings",
        "apply_shipping_product_bindings",
        "preview_basic_service_fee_change",
        "apply_basic_service_fee_change",
        "preview_official_service_fee_catalog",
        "apply_official_service_fee_catalog",
        "open_logs",
    }
)
SERIAL_ACTIONS = frozenset(
    {
        "start_service",
        "stop_service",
        "preview_catalog",
        "apply_catalog",
        "preview_mapping",
        "apply_mapping",
        "save_mapping_reviews",
        "resolve_mapping_review",
        "preview_shipping_template",
        "apply_shipping_template",
        "preview_shipping_product_bindings",
        "apply_shipping_product_bindings",
        "preview_basic_service_fee_change",
        "apply_basic_service_fee_change",
        "preview_official_service_fee_catalog",
        "apply_official_service_fee_catalog",
        "preview_legacy_service_fee_archive",
        "apply_legacy_service_fee_archive",
        "rollback_update",
    }
)


class BridgeBusyError(RuntimeError):
    pass


def webview_asset_directory() -> Path:
    return Path(__file__).resolve().with_name("webview_static")


def webview_entrypoint() -> Path:
    return webview_asset_directory() / "index.html"


def _normalized_page_url(value: str | None) -> str | None:
    if not value:
        return None
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"}:
        return None
    if parts.hostname not in {"127.0.0.1", "localhost"}:
        return None
    if not parts.path.endswith("/index.html"):
        return None
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def installed_webview2_version() -> str | None:
    if sys.platform != "win32":
        return None
    try:
        import winreg
    except ImportError:
        return None

    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for clients_path in WEBVIEW2_REGISTRY_PATHS:
            try:
                with winreg.OpenKey(hive, clients_path) as clients:
                    index = 0
                    while True:
                        try:
                            child_name = winreg.EnumKey(clients, index)
                        except OSError:
                            break
                        index += 1
                        try:
                            with winreg.OpenKey(clients, child_name) as child:
                                name = str(winreg.QueryValueEx(child, "name")[0])
                                version = str(winreg.QueryValueEx(child, "pv")[0])
                        except OSError:
                            continue
                        if name == WEBVIEW2_RUNTIME_NAME and version.strip("0."):
                            return version
            except OSError:
                continue
    return None


class DesktopBridge:
    """Single-entry, page-bound allowlist for the embedded management UI."""

    def __init__(self, service: AssistantService, logger: logging.Logger) -> None:
        self.service = service
        self.logger = logger
        self._window = None
        self._trusted_url: str | None = None
        self._operation_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._log_signature: tuple[int, int] | None = None

    def _attach_window(self, window) -> None:
        self._window = window

    def _trust_current_page(self) -> str:
        if self._window is None:
            raise RuntimeError("桌面窗口尚未初始化")
        current = _normalized_page_url(self._window.get_current_url())
        if current is None:
            raise RuntimeError("成本助手未加载受信任的本地页面")
        self._trusted_url = current
        return current

    def _assert_trusted_page(self) -> None:
        if self._window is None or self._trusted_url is None:
            raise PermissionError("桌面桥接尚未就绪")
        if _normalized_page_url(self._window.get_current_url()) != self._trusted_url:
            raise PermissionError("当前页面无权调用成本助手管理桥接")

    @property
    def operation_in_progress(self) -> bool:
        return self._operation_lock.locked()

    def invoke(self, action: str, payload: dict[str, object] | None = None) -> dict[str, object]:
        """The only public method exposed to JavaScript."""

        try:
            self._assert_trusted_page()
            if action not in BRIDGE_ACTIONS:
                raise ValueError("不支持的桌面操作")
            if payload is None:
                payload = {}
            if not isinstance(payload, dict):
                raise ValueError("桌面操作参数必须是对象")

            acquired = False
            if action in SERIAL_ACTIONS:
                acquired = self._operation_lock.acquire(blocking=False)
                if not acquired:
                    raise BridgeBusyError("另一项资料操作仍在进行，请等待完成")
            try:
                handler = getattr(self, f"_action_{action}")
                return {"ok": True, "result": handler(payload)}
            finally:
                if acquired:
                    self._operation_lock.release()
        except Exception as exc:
            if action == "rollback_update":
                self.logger.error("更新回滚未完成：%s", exc)
            elif not isinstance(exc, (BridgeBusyError, PermissionError, ValueError)):
                self.logger.exception("WebView2 桌面操作失败：%s", action)
            return {"ok": False, "error": str(exc)}

    def _action_get_state(self, payload: dict[str, object]) -> dict[str, object]:
        force_log = payload.get("force_log") is True
        health = probe_health(self.service.port, timeout=0.5)
        expected = self.service.matches_running_service(health)
        with self._state_lock:
            known_signature = None if force_log else self._log_signature
            log_content, signature = read_log_tail(
                self.service.paths.logs / "cost-assistant.log",
                known_signature=known_signature,
            )
            self._log_signature = signature
        safe_health = None
        if health is not None:
            safe_health = {
                "status": health.get("status"),
                "environment": health.get("environment"),
                "enabled_count": health.get("enabled_count", 0),
                "verified_mapping_count": health.get("verified_mapping_count", 0),
                "last_successful_sync": health.get("last_successful_sync"),
                "mapping_shops": health.get("mapping_shops", []),
            }
        return {
            "expected": expected,
            "health_present": health is not None,
            "owns_service": self.service.owns_running_service,
            "port": self.service.port,
            "database_path": str(self.service.paths.database.resolve()),
            "health": safe_health,
            "log": log_content,
        }

    def _action_get_update_history(
        self, _payload: dict[str, object]
    ) -> list[dict[str, object]]:
        return read_update_history(self.service.paths.database)

    def _action_rollback_update(self, payload: dict[str, object]) -> dict[str, object]:
        if set(payload) != {"update_id"}:
            raise ValueError("回滚参数只允许包含更新标识")
        update_id = payload.get("update_id")
        if not isinstance(update_id, str) or not update_id:
            raise ValueError("回滚更新标识无效")
        eligible = next(
            (
                entry
                for entry in read_update_history(self.service.paths.database)
                if entry.get("update_id") == update_id
                and entry.get("can_rollback") is True
            ),
            None,
        )
        if eligible is None:
            raise ValueError("只允许回滚全局最新一次成功更新")
        result = rollback_latest_update(
            self.service.paths.database,
            self.service.paths.output_excel,
            update_id,
            rolled_back_at=datetime.now().astimezone().replace(microsecond=0).isoformat(),
        )
        response = {
            "update_id": result.update_key,
            "recovery_backup_file": result.recovery_backup_path.name,
            "rebuilt_excel": result.rebuilt_excel,
        }
        self.logger.info(
            "更新回滚完成：%s，恢复备份 %s，重建成本表 %s",
            result.update_key,
            result.recovery_backup_path.name,
            "是" if result.rebuilt_excel else "否",
        )
        return response

    def _action_get_mapping_reviews(
        self, _payload: dict[str, object]
    ) -> dict[str, object]:
        return self.service.admin.get_mapping_reviews()

    def _action_get_shipping_templates(
        self, _payload: dict[str, object]
    ) -> list[dict[str, object]]:
        return self.service.admin.get_shipping_templates()

    def _action_get_shipping_product_bindings(
        self, _payload: dict[str, object]
    ) -> dict[str, object]:
        return self.service.admin.get_shipping_product_bindings()

    def _action_get_basic_service_fee_rates(
        self, payload: dict[str, object]
    ) -> list[dict[str, object]]:
        if set(payload) - {"archived"}:
            raise ValueError("基础服务费查询参数无效")
        archived = payload.get("archived", False)
        if not isinstance(archived, bool):
            raise ValueError("归档筛选必须为布尔值")
        return self.service.admin.get_basic_service_fee_rates(archived=archived)

    def _action_get_basic_service_fee_coverage(
        self, payload: dict[str, object]
    ) -> list[dict[str, int]]:
        if payload:
            raise ValueError("基础服务费覆盖统计不接受参数")
        return self.service.admin.get_basic_service_fee_coverage()

    def _action_preview_legacy_service_fee_archive(
        self, _payload: dict[str, object]
    ) -> dict[str, object]:
        result = self.service.admin.preview_legacy_service_fee_archive()
        self.logger.info(
            "旧基础服务费归档预览：候选 %s 条，仍匹配商品 %s 个",
            result["archive_count"], result["referenced_product_count"],
        )
        return result

    def _action_apply_legacy_service_fee_archive(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        if set(payload) != {"preview_id"}:
            raise ValueError("确认参数只允许包含预览凭证")
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("旧基础服务费归档预览凭证无效")
        result = self.service.admin.apply_legacy_service_fee_archive(preview_id)
        self.logger.info(
            "旧基础服务费归档完成：%s 条，备份 %s",
            result["count"], result["backup_file"],
        )
        return result

    def _action_start_service(self, _payload: dict[str, object]) -> str:
        result = self.service.start()
        labels = {
            "started": "已启动唯一的本机服务",
            "already_running": "已接管正在运行的本机服务",
            "already_owned": "本窗口服务已经运行",
        }
        self.logger.info("%s", labels.get(result, "本机服务已就绪"))
        return result

    def _action_stop_service(self, _payload: dict[str, object]) -> bool:
        if not self.service.owns_running_service:
            raise RuntimeError("当前服务由另一个成本助手窗口管理，本窗口不会停止它")
        stopped = self.service.stop()
        self.logger.info("本窗口管理的成本服务已停止")
        return stopped

    def _action_choose_file(self, payload: dict[str, object]) -> dict[str, str] | None:
        if self._window is None:
            raise RuntimeError("桌面窗口尚未初始化")
        kind = str(payload.get("kind", ""))
        directories = {
            "ordinary": "聚水潭导出表",
            "combination": "聚水潭导出表",
            "mapping": "抖店商品导出表",
        }
        if kind not in directories:
            raise ValueError("不支持的文件槽位")
        import webview

        selected = self._window.create_file_dialog(
            webview.FileDialog.OPEN,
            directory=str(Path(__file__).resolve().parents[1] / directories[kind]),
            allow_multiple=False,
            file_types=("Excel 工作簿 (*.xlsx)",),
        )
        if not selected:
            return None
        path = Path(selected[0]).resolve()
        if path.suffix.lower() != ".xlsx" or not path.is_file():
            raise ValueError("请选择可读取的 XLSX 文件")
        return {"path": str(path), "name": path.name}

    def _require_path(self, payload: dict[str, object], name: str) -> str:
        value = payload.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ValueError("请先选择完整的 XLSX 文件")
        return value

    def _ensure_service(self) -> None:
        health = probe_health(self.service.port, timeout=0.5)
        if not self.service.matches_running_service(health):
            raise RuntimeError("成本服务尚未就绪，请先在“运行概览”启动服务")

    def _action_preview_catalog(self, payload: dict[str, object]) -> dict[str, object]:
        self._ensure_service()
        result = self.service.admin.preview_catalog(
            self._require_path(payload, "ordinary_path"),
            self._require_path(payload, "combination_path"),
        )
        self.logger.info(
            "商品双表预览完成：普通 %s，组合 %s，合并 %s，冲突 %s",
            result["ordinary_products"],
            result["combination_products"],
            result["merged_products"],
            len(result.get("conflicting_overlaps") or []),
        )
        return result

    def _action_apply_catalog(self, payload: dict[str, object]) -> dict[str, object]:
        self._ensure_service()
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("预览凭证无效，请重新预览")
        result = self.service.admin.apply_catalog(preview_id)
        self.logger.info(
            "商品双表更新完成：启用 %s，备份 %s",
            result["enabled_count"],
            result.get("backup_file") or "首次建立",
        )
        return result

    def _action_preview_mapping(self, payload: dict[str, object]) -> dict[str, object]:
        self._ensure_service()
        shop_name = payload.get("shop_name")
        if not isinstance(shop_name, str) or not shop_name.strip():
            raise ValueError("请明确填写或选择固定店铺名称")
        result = self.service.admin.preview_mapping(
            shop_name.strip(), self._require_path(payload, "mapping_path")
        )
        self.logger.info(
            "店铺映射预览完成：匹配 %s，待核验 %s，冲突 %s",
            result["matched_rows"],
            result["pending_rows"],
            result["conflict_count"],
        )
        return result

    def _action_apply_mapping(self, payload: dict[str, object]) -> dict[str, object]:
        self._ensure_service()
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("预览凭证无效，请重新预览")
        result = self.service.admin.apply_mapping(preview_id)
        self.logger.info(
            "店铺映射更新完成：新增 %s，更新 %s，移除 %s，备份 %s",
            result["inserted_rows"],
            result["updated_rows"],
            result["removed_rows"],
            result["backup_file"],
        )
        return result

    def _action_save_mapping_reviews(self, payload: dict[str, object]) -> dict[str, object]:
        self._ensure_service()
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("预览凭证无效，请重新预览")
        result = self.service.admin.save_mapping_reviews(preview_id)
        self.logger.info(
            "待处理映射已保存：店铺 %s，新增或更新 %s，未变化 %s",
            result["shop_name"],
            result["saved_rows"],
            result["unchanged_rows"],
        )
        return result

    def _action_resolve_mapping_review(self, payload: dict[str, object]) -> dict[str, object]:
        self._ensure_service()
        candidate_id = payload.get("candidate_id")
        target_sku = payload.get("jushuitan_sku_id")
        if not isinstance(candidate_id, int) or not isinstance(target_sku, str):
            raise ValueError("人工核验参数无效")
        result = self.service.admin.resolve_mapping_review(candidate_id, target_sku)
        self.logger.info(
            "人工映射完成：店铺 %s，抖店 SKUID %s，聚水潭编码 %s，备份 %s",
            result["shop_name"],
            result["douyin_sku_id"],
            result["jushuitan_sku_id"],
            result["backup_file"],
        )
        return result

    def _action_preview_shipping_template(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        result = self.service.admin.preview_shipping_template(payload)
        self.logger.info(
            "运费模板预览完成：店铺 %s，模板 %s，地区规则 %s",
            result["shop_name"],
            result["name"],
            len(result["region_rules"]),
        )
        return result

    def _action_apply_shipping_template(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        if set(payload) != {"preview_id"}:
            raise ValueError("确认参数只允许包含预览凭证")
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("运费模板预览凭证无效")
        result = self.service.admin.apply_shipping_template(preview_id)
        self.logger.info(
            "运费模板更新完成：模板 %s，备份 %s",
            result["template_id"],
            result["backup_file"],
        )
        return result

    def _action_preview_shipping_product_bindings(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        result = self.service.admin.preview_shipping_product_bindings(payload)
        self.logger.info(
            "商品运费模板绑定预览完成：店铺 %s，商品 %s 个，模板 %s",
            result["shop_name"], len(result["douyin_product_ids"]), result["template_id"],
        )
        return result

    def _action_apply_shipping_product_bindings(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        if set(payload) != {"preview_id"}:
            raise ValueError("确认参数只允许包含预览凭证")
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("商品运费模板绑定预览凭证无效")
        result = self.service.admin.apply_shipping_product_bindings(preview_id)
        self.logger.info(
            "商品运费模板绑定完成：店铺 %s，商品 %s 个，模板 %s，备份 %s",
            result["shop_name"], result["product_count"], result["template_id"],
            result["backup_file"],
        )
        return result

    def _action_preview_basic_service_fee_change(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        result = self.service.admin.preview_basic_service_fee_change(payload)
        self.logger.info(
            "基础服务费预览完成：操作 %s，费率版本 %s",
            result["operation"],
            result.get("rate_id", "new"),
        )
        return result

    def _action_apply_basic_service_fee_change(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        if set(payload) != {"preview_id"}:
            raise ValueError("确认参数只允许包含预览凭证")
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("基础服务费预览凭证无效")
        result = self.service.admin.apply_basic_service_fee_change(preview_id)
        self.logger.info(
            "基础服务费更新完成：操作 %s，版本 %s，备份 %s",
            result["operation"],
            result["rate_id"],
            result["backup_file"],
        )
        return result

    def _action_preview_official_service_fee_catalog(
        self, _payload: dict[str, object]
    ) -> dict[str, object]:
        result = self.service.admin.preview_official_service_fee_catalog()
        self.logger.info(
            "官方基础服务费目录预览完成：%s 条，官方更新时间 %s",
            result["rule_count"], result["source_updated_at"],
        )
        return result

    def _action_apply_official_service_fee_catalog(
        self, payload: dict[str, object]
    ) -> dict[str, object]:
        if set(payload) != {"preview_id"}:
            raise ValueError("确认参数只允许包含预览凭证")
        preview_id = payload.get("preview_id")
        if not isinstance(preview_id, str) or not preview_id:
            raise ValueError("官方费率目录预览凭证无效")
        result = self.service.admin.apply_official_service_fee_catalog(preview_id)
        self.logger.info(
            "官方基础服务费目录处理完成：状态 %s，规则 %s 条，备份 %s",
            result["status"], result["count"], result.get("backup_file") or "无需备份",
        )
        return result

    def _action_open_logs(self, _payload: dict[str, object]) -> bool:
        self.service.paths.logs.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            raise RuntimeError(f"日志目录：{self.service.paths.logs}")
        os.startfile(self.service.paths.logs)
        return True


class DesktopWindowController:
    def __init__(
        self,
        bridge: DesktopBridge,
        service: AssistantService,
        logger: logging.Logger,
        *,
        confirm_close: Callable[[str], bool] | None = None,
        notify: Callable[[str], None] | None = None,
    ) -> None:
        self.bridge = bridge
        self.service = service
        self.logger = logger
        self.confirm_close = confirm_close or _confirm_close
        self.notify = notify or _notify

    def on_closing(self) -> bool | None:
        if self.bridge.operation_in_progress:
            self.notify("资料仍在预览或确认中。请等待操作完成后再关闭成本助手。")
            return False
        if self.service.owns_running_service and not self.confirm_close(
            "关闭本窗口会同时停止由它管理的本机成本服务。确定关闭并停止服务吗？"
        ):
            return False
        return None

    def on_closed(self) -> None:
        if self.service.stop():
            self.logger.info("窗口关闭，本窗口管理的成本服务已停止")


def _message_box(message: str, flags: int) -> int:
    if os.name != "nt":
        return 1
    import ctypes

    return int(ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, flags))


def _confirm_close(message: str) -> bool:
    return _message_box(message, 0x00000004 | 0x00000020) == 6


def _notify(message: str) -> None:
    _message_box(message, 0x00000000 | 0x00000040)


def run_webview_app(
    service: AssistantService,
    logger: logging.Logger,
    *,
    auto_start: bool = True,
) -> int:
    entrypoint = webview_entrypoint()
    for required in (entrypoint, entrypoint.with_name("styles.css"), entrypoint.with_name("app.js")):
        if not required.is_file():
            raise FileNotFoundError(f"桌面页面资源缺失：{required.name}")

    if sys.platform == "win32" and installed_webview2_version() is None:
        raise RuntimeError(
            "未检测到 Microsoft Edge WebView2 Runtime。请先安装运行时后重试："
            f"{WEBVIEW2_DOWNLOAD_URL}"
        )

    import webview

    bridge = DesktopBridge(service, logger)
    window = webview.create_window(
        f"{APP_NAME} · 一体化管理台",
        url=str(entrypoint),
        js_api=bridge,
        width=1180,
        height=780,
        min_size=(900, 640),
        background_color="#f2f6f4",
        text_select=True,
        zoomable=False,
    )
    if window is None:
        raise RuntimeError("无法创建 WebView2 桌面窗口")
    bridge._attach_window(window)
    controller = DesktopWindowController(bridge, service, logger)
    window.events.closing += controller.on_closing
    window.events.closed += controller.on_closed

    def initialize() -> None:
        if not window.events.loaded.wait(30):
            logger.error("WebView2 本地页面在 30 秒内未完成加载")
            return
        try:
            bridge._trust_current_page()
            window.run_js(
                f"window.__desktopAutoStart = {str(auto_start).lower()};"
                "window.__desktopBridgeReady = true;"
                "window.dispatchEvent(new Event('desktop-bridge-ready'));"
            )
        except Exception:
            logger.exception("WebView2 本地页面可信绑定失败")

    webview.start(
        initialize,
        gui="edgechromium",
        debug=False,
        private_mode=True,
        user_agent="CostAssistant-Desktop/1.0",
    )
    return 0


def run_webview_smoke_test(service: AssistantService, logger: logging.Logger) -> int:
    """Load packaged assets in Edge Chromium and call one read-only bridge action."""

    entrypoint = webview_entrypoint()
    if not entrypoint.is_file():
        return 1
    if sys.platform == "win32" and installed_webview2_version() is None:
        return 1

    import webview

    outcome = {"ok": False}
    bridge = DesktopBridge(service, logger)
    window = webview.create_window(
        f"{APP_NAME} · WebView2 自检",
        url=str(entrypoint),
        js_api=bridge,
        hidden=False,
        focus=False,
        width=900,
        height=640,
    )
    if window is None:
        return 1
    bridge._attach_window(window)

    def verify() -> None:
        callback_finished = threading.Event()

        def checked(response: object) -> None:
            outcome["ok"] = bool(isinstance(response, dict) and response.get("ok"))
            callback_finished.set()

        try:
            if not window.events.loaded.wait(30):
                return
            bridge._trust_current_page()
            window.evaluate_js(
                "window.pywebview.api.invoke('get_state', {force_log: false})",
                callback=checked,
            )
            callback_finished.wait(5)
        except Exception:
            logger.exception("WebView2 样机自检失败")
        finally:
            window.destroy()

    webview.start(
        verify,
        gui="edgechromium",
        debug=False,
        private_mode=True,
        user_agent="CostAssistant-SmokeTest/1.0",
    )
    return 0 if outcome["ok"] else 1
