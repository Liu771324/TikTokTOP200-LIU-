#!/usr/bin/env python3
"""抖店商机中心单类目 API 采集器。

默认采集“传统滋补”（first_cid=1000002718），最低近 30 天成交金额 75 万。
Cookie 仅从本地 cookie.txt 读取，绝不会写入日志、检查点或报告。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests

try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError:
    sync_playwright = None

try:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
except ModuleNotFoundError:
    Workbook = None
    load_workbook = None


BASE_URL = "https://fxg.jinritemai.com"
CDP_URL = "http://127.0.0.1:9222"
PAGE_URL = f"{BASE_URL}/ffa/bu/NewBusinessCenter?clueChannel=all_word"
LIST_URL = f"{BASE_URL}/api/commop/business_chance_center/clue/common/real_time_list"
INDICATOR_URL = f"{BASE_URL}/api/commop/business_chance_center/clue/common/indicator"
CATEGORY_URL_FRAGMENT = "/api/commop/business_chance_center/shop_full_category/list"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"
)
RETRY_DELAYS = (3, 5, 8)
ATOMIC_REPLACE_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.8, 1.6)
SAFE_RESPONSE_HEADERS = {"content-type", "content-length", "x-tt-logid", "x-request-id", "trace-id"}
POSITIVE_CLASSES = {"上涨", "999.99%+", "增速快"}
CLASS_NAMES = ("下跌", "上涨", "持平", "999.99%+", "增速快", "无法确认")
STOP_EVENT = threading.Event()
PAUSE_EVENT = threading.Event()
CHECKPOINT_LOCK = threading.RLock()

BANDS = (
    (0, 50), (50, 100), (100, 250), (250, 500), (500, 750), (750, 1000),
    (1000, 2500), (2500, 5000), (5000, 7500), (7500, 10000),
    (10000, 15000), (15000, 20000), (20000, 25000), (25000, 30000),
    (30000, 35000), (35000, 40000), (40000, 45000), (45000, 50000),
    (50000, 60000), (60000, 65000), (65000, 70000), (70000, 75000),
    (75000, 80000), (80000, 90000), (90000, 95000), (95000, 100000),
    (100000, 250000), (250000, 500000), (500000, 750000), (750000, 1000000),
    (1000000, 2500000), (2500000, 5000000), (5000000, 7500000),
    (7500000, 10000000), (10000000, 25000000), (25000000, 50000000),
    (50000000, 75000000), (75000000, 100000000),
)


class CollectorError(RuntimeError):
    """可向用户展示的采集错误。"""


class ImmediateStopError(CollectorError):
    """登录失效、限流或验证页等必须立即停止的错误。"""


class AtomicWriteError(CollectorError):
    """本地文件无法可靠原子提交。"""


class CheckpointIOError(AtomicWriteError):
    """本地检查点无法可靠提交。"""


def cdp_ready(cdp_url: str = CDP_URL) -> bool:
    try:
        response = requests.get(f"{cdp_url.rstrip('/')}/json/version", timeout=2)
        return response.status_code == 200
    except requests.RequestException:
        return False


def find_edge_path() -> Path | None:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidates = (
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path(local_app_data) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
    )
    return next((path for path in candidates if path.is_file()), None)


def ensure_debug_edge(cdp_url: str = CDP_URL, auto_launch: bool = True) -> None:
    if cdp_ready(cdp_url):
        return
    if not auto_launch:
        raise CollectorError(f"未检测到 Edge 调试端口：{cdp_url}")
    edge_path = find_edge_path()
    if edge_path is None:
        raise CollectorError("未找到 Microsoft Edge，无法自动读取登录态")
    parsed_cdp_url = urlparse(cdp_url)
    if parsed_cdp_url.hostname not in ("127.0.0.1", "localhost"):
        raise CollectorError("只能自动启动本机 Edge 调试端口")
    debug_port = parsed_cdp_url.port or 9222
    profile_dir = Path(tempfile.gettempdir()) / "doudian-edge-debug"
    subprocess.Popen(
        [
            str(edge_path), f"--remote-debugging-port={debug_port}",
            f"--user-data-dir={profile_dir}", PAGE_URL,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if cdp_ready(cdp_url):
            return
        time.sleep(0.5)
    raise CollectorError("Edge 已启动，但调试端口 20 秒内未就绪")


def read_edge_auth(cdp_url: str = CDP_URL, auto_launch: bool = True) -> tuple[str, str]:
    if sync_playwright is None:
        raise CollectorError("缺少 playwright，请先运行：python -m pip install playwright==1.58.0")
    ensure_debug_edge(cdp_url, auto_launch)
    os.environ.setdefault("NODE_NO_WARNINGS", "1")
    playwright = sync_playwright().start()
    try:
        browser = playwright.chromium.connect_over_cdp(cdp_url)
        if not browser.contexts:
            raise CollectorError("Edge 调试会话中没有可用上下文")
        context = browser.contexts[0]
        page = next((candidate for candidate in context.pages if "NewBusinessCenter" in candidate.url), None)
        if page is None:
            page = context.new_page()
            page.goto(PAGE_URL, wait_until="domcontentloaded", timeout=30_000)
        if "/login" in page.url:
            raise CollectorError("已自动打开 Edge，请完成抖店登录后重新运行")
        cookies = context.cookies([BASE_URL, PAGE_URL])
        cookie_header = "; ".join(
            f"{cookie['name']}={cookie['value']}"
            for cookie in cookies
            if cookie.get("name") and cookie.get("value") is not None
        )
        if not cookie_header:
            raise CollectorError("Edge 中未检测到抖店登录 Cookie，请先登录抖店")
        user_agent = page.evaluate("navigator.userAgent") or DEFAULT_USER_AGENT
        return cookie_header, str(user_agent)
    finally:
        playwright.stop()


def parse_top_categories(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise CollectorError("官方类目接口未返回一级类目列表")
    def parse_level(items: Any, depth: int) -> list[dict[str, Any]]:
        if not isinstance(items, list) or depth > 3:
            return []
        parsed = []
        seen_ids = set()
        for item in items:
            if not isinstance(item, dict):
                continue
            category_id = item.get("value")
            name = str(item.get("label") or "").strip()
            try:
                category_id = int(category_id)
            except (TypeError, ValueError):
                continue
            if category_id <= 0 or not name or category_id in seen_ids:
                continue
            seen_ids.add(category_id)
            parsed.append({
                "id": category_id,
                "name": name,
                "children": parse_level(item.get("children"), depth + 1),
            })
        return parsed

    categories = parse_level(data, 1)
    if not categories:
        raise CollectorError("官方类目接口未返回有效一级类目")
    return categories


def read_edge_categories(cdp_url: str = CDP_URL, auto_launch: bool = True) -> list[dict[str, Any]]:
    """从已登录 Edge 页面读取官方一级类目；签名 URL 和登录态均不落盘。"""
    if sync_playwright is None:
        raise CollectorError("缺少 playwright，请先运行：python -m pip install playwright==1.58.0")
    ensure_debug_edge(cdp_url, auto_launch)
    os.environ.setdefault("NODE_NO_WARNINGS", "1")
    playwright = sync_playwright().start()
    try:
        browser = playwright.chromium.connect_over_cdp(cdp_url)
        if not browser.contexts:
            raise CollectorError("Edge 调试会话中没有可用上下文")
        context = browser.contexts[0]
        page = next((candidate for candidate in context.pages if "NewBusinessCenter" in candidate.url), None)
        if page is None:
            page = context.new_page()
            page.goto(PAGE_URL, wait_until="networkidle", timeout=60_000)
        if "/login" in page.url:
            raise CollectorError("请先在自动打开的 Edge 中登录抖店")

        urls = page.evaluate(
            "performance.getEntriesByType('resource').map(x => x.name)"
            f".filter(x => x.includes('{CATEGORY_URL_FRAGMENT}'))"
        )
        if not urls:
            page.reload(wait_until="networkidle", timeout=60_000)
            urls = page.evaluate(
                "performance.getEntriesByType('resource').map(x => x.name)"
                f".filter(x => x.includes('{CATEGORY_URL_FRAGMENT}'))"
            )
        if not urls:
            raise CollectorError("页面尚未加载官方类目列表，请刷新抖店商机中心后重试")

        last_error: Exception | None = None
        for signed_url in reversed(urls):
            try:
                response = context.request.get(signed_url, headers={"Referer": page.url}, timeout=30_000)
                if response.status != 200:
                    raise CollectorError(f"官方类目接口返回 HTTP {response.status}")
                return parse_top_categories(response.json())
            except Exception as error:
                last_error = error
        raise CollectorError(f"读取官方类目列表失败：{last_error}") from last_error
    finally:
        playwright.stop()


def read_cookie_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    value = path.read_text(encoding="utf-8").strip()
    return value or None


def resolve_auth(args: argparse.Namespace) -> tuple[str, str, str]:
    edge_error: Exception | None = None
    if args.auth in ("auto", "edge"):
        try:
            cookie, user_agent = read_edge_auth(args.cdp_url, not args.no_auto_launch_edge)
            log("已自动读取 Edge 登录态（仅保存在本次运行内存中）")
            return cookie, user_agent, "edge-auto"
        except Exception as error:
            edge_error = error
            if args.auth == "edge":
                raise
    if args.auth in ("auto", "cookie"):
        cookie = read_cookie_file(Path(args.cookie_file))
        if cookie:
            log("已读取本地 cookie.txt 登录态")
            return cookie, args.user_agent, "cookie-file"
    if edge_error is not None:
        raise CollectorError(f"自动认证失败：{edge_error}") from edge_error
    raise CollectorError(f"未找到有效认证：{Path(args.cookie_file).resolve()}")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


def wait_if_paused() -> None:
    announced = False
    while PAUSE_EVENT.is_set() and not STOP_EVENT.is_set():
        if not announced:
            log("任务已暂停，等待继续")
            announced = True
        STOP_EVENT.wait(0.25)


def controlled_wait(seconds: float) -> None:
    remaining = max(0.0, seconds)
    while remaining > 0 and not STOP_EVENT.is_set():
        wait_if_paused()
        started = time.monotonic()
        STOP_EVENT.wait(min(0.25, remaining))
        if not PAUSE_EVENT.is_set():
            remaining -= time.monotonic() - started


def _replace_file(temporary: Path, path: Path) -> None:
    for attempt in range(len(ATOMIC_REPLACE_DELAYS) + 1):
        try:
            os.replace(temporary, path)
            return
        except OSError as error:
            access_denied = isinstance(error, PermissionError) or getattr(error, "winerror", None) == 5
            if not access_denied or attempt == len(ATOMIC_REPLACE_DELAYS):
                reason = "写入冲突，重试后仍无法替换" if access_denied else "原子替换失败"
                raise AtomicWriteError(f"本地文件{reason}：{path}（{error}）") from error
            time.sleep(ATOMIC_REPLACE_DELAYS[attempt])


def _cleanup_temporary(temporary: Path) -> None:
    try:
        temporary.unlink(missing_ok=True)
    except OSError as error:
        log(f"临时文件清理失败：{temporary}（{error}）")


def _atomic_write_text(path: Path, value: str) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with CHECKPOINT_LOCK:
            temporary.write_text(value, encoding="utf-8")
            _replace_file(temporary, path)
    except AtomicWriteError:
        raise
    except OSError as error:
        raise AtomicWriteError(f"本地文件写入失败：{path}（{error}）") from error
    finally:
        _cleanup_temporary(temporary)


def atomic_write_json(path: Path, value: Any) -> None:
    serialized = json.dumps(value, ensure_ascii=False, indent=2)
    _atomic_write_text(path, serialized)


def atomic_write_text(path: Path, value: str) -> None:
    _atomic_write_text(path, value)


def read_json(path: Path) -> Any:
    with CHECKPOINT_LOCK:
        return json.loads(path.read_text(encoding="utf-8"))


def recover_checkpoint(path: Path) -> dict[str, Any] | None:
    with CHECKPOINT_LOCK:
        temporary_files = list(path.parent.glob(f"{path.name}.*.tmp"))
        if path.is_file():
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                state = None
            else:
                for temporary in temporary_files:
                    _cleanup_temporary(temporary)
                return state
        elif not temporary_files:
            return None

        valid_candidates: list[tuple[int, Path, dict[str, Any]]] = []
        for temporary in temporary_files:
            try:
                candidate = json.loads(temporary.read_text(encoding="utf-8"))
                modified = temporary.stat().st_mtime_ns
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(candidate, dict):
                valid_candidates.append((modified, temporary, candidate))
        if not valid_candidates:
            if path.exists():
                raise CollectorError(f"检查点损坏且没有可恢复的临时文件：{path}")
            return None

        _, recovered_from, state = max(valid_candidates, key=lambda item: item[0])
        state["checkpoint_recovery"] = {
            "source": recovered_from.name,
            "recovered_at": now_iso(),
        }
        atomic_write_json(path, state)
        for temporary in temporary_files:
            _cleanup_temporary(temporary)
        log(f"已从有效临时文件恢复检查点：{recovered_from.name}")
        return state


def parse_amount_number(value: Any) -> float | None:
    raw = str(value or "").strip().replace("¥", "").replace("￥", "").replace(",", "")
    multiplier = 1
    if raw.endswith("亿"):
        multiplier, raw = 100_000_000, raw[:-1]
    elif raw.endswith("万"):
        multiplier, raw = 10_000, raw[:-1]
    try:
        number = float(raw)
    except (TypeError, ValueError):
        return None
    return number * multiplier if math.isfinite(number) and number >= 0 else None


def parse_amount_band(value: Any) -> dict[str, Any] | None:
    raw = str(value or "").strip().replace(" ", "")
    if not raw or raw == "-":
        return None
    if raw.startswith("小于"):
        maximum = parse_amount_number(raw[2:])
        return None if maximum is None else {"min": 0.0, "max": maximum, "raw": raw}
    if raw.endswith(("以上", "+")):
        suffix = 2 if raw.endswith("以上") else 1
        minimum = parse_amount_number(raw[:-suffix])
        return None if minimum is None else {"min": minimum, "max": math.inf, "raw": raw}
    for separator in ("-", "–", "—"):
        if separator in raw:
            left, right = raw.split(separator, 1)
            minimum, maximum = parse_amount_number(left), parse_amount_number(right)
            if minimum is None or maximum is None or minimum > maximum:
                return None
            return {"min": minimum, "max": maximum, "raw": raw}
    exact = parse_amount_number(raw)
    return None if exact is None else {"min": exact, "max": exact, "raw": raw}


def amount_fits_band(amount: float, band: dict[str, Any]) -> bool:
    return band["min"] <= amount <= band["max"]


def format_amount(value: float) -> str:
    if value >= 100_000_000:
        return f"¥{value / 100_000_000:g}亿"
    if value >= 10_000:
        return f"¥{value / 10_000:g}万"
    return f"¥{value:g}"


def value_to_band(value: float) -> str:
    if not math.isfinite(value) or value < 0:
        return "-"
    if value < 50:
        return "小于¥50"
    for minimum, maximum in BANDS:
        if minimum <= value < maximum:
            return f"{format_amount(minimum)}-{format_amount(maximum)}"
    return "¥1亿+"


def find_array_by_shape(value: Any, predicate: Callable[[Any], bool], depth: int = 0) -> list[Any] | None:
    if depth > 7:
        return None
    if isinstance(value, list) and value and predicate(value[0]):
        return value
    if isinstance(value, dict):
        for child in value.values():
            found = find_array_by_shape(child, predicate, depth + 1)
            if found is not None:
                return found
    return None


def category_path_text(value: Any) -> str:
    if isinstance(value, list):
        return " / ".join(str(part).strip() for part in value if str(part).strip())
    return str(value or "").replace(">", " / ").strip()


def extract_labels(raw: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    candidates = (
        raw.get("labels"), raw.get("clue_labels"), raw.get("clue_detail", {}).get("labels"),
        raw.get("clue_detail", {}).get("clue_labels"), raw.get("clue_label_ext"),
    )
    for candidate in candidates:
        if not isinstance(candidate, list):
            continue
        for item in candidate:
            text = item if isinstance(item, str) else item.get("name") or item.get("label") or item.get("text")
            if text and str(text).strip() not in labels:
                labels.append(str(text).strip())
    return labels


def platform_error_message(payload: dict[str, Any], fallback: str) -> str:
    base_resp = payload.get("base_resp") if isinstance(payload.get("base_resp"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    return str(
        payload.get("message")
        or payload.get("msg")
        or base_resp.get("status_message")
        or base_resp.get("status_msg")
        or data.get("message")
        or data.get("msg")
        or fallback
    )


def response_shape(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return {"type": "dict", "keys": sorted(str(key) for key in value)}
    if isinstance(value, list):
        return {"type": "list", "length": len(value)}
    return {"type": type(value).__name__}


def list_failure_diagnostics(
    request_body: dict[str, Any],
    response_payload: dict[str, Any],
    transport: dict[str, Any],
) -> dict[str, Any]:
    return {
        "request_body": request_body,
        "http_status": transport.get("http_status"),
        "response_headers": transport.get("response_headers", {}),
        "top_level_keys": sorted(str(key) for key in response_payload),
        "code": response_payload.get("code"),
        "message": response_payload.get("message") or response_payload.get("msg"),
        "base_resp": response_payload.get("base_resp"),
        "data_shape": response_shape(response_payload.get("data")),
    }


def parse_list_response(payload: dict[str, Any], page_number: int) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CollectorError("列表响应为空")
    if payload.get("code") not in (None, 0):
        raise CollectorError(platform_error_message(payload, "列表接口返回失败"))
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    direct_candidates = [data.get(key) for key in ("list", "clue_list", "items", "rows", "data")]
    rows = next((candidate for candidate in direct_candidates if isinstance(candidate, list)), None)
    if rows is None:
        rows = find_array_by_shape(payload, lambda item: isinstance(item, dict) and "clue_detail" in item and "clue_indicator" in item)
    if rows is None:
        raise CollectorError("列表响应中未找到商品数组")
    parsed = []
    for raw in rows:
        detail, indicator = raw.get("clue_detail") or {}, raw.get("clue_indicator") or {}
        clue_id = detail.get("clue_id")
        name = str(detail.get("name") or "").strip()
        try:
            amount = float(indicator.get("pay_amount_ind"))
        except (TypeError, ValueError):
            amount = math.nan
        range_text = str(indicator.get("pay_amount_ind_range") or "").strip()
        band = parse_amount_band(range_text)
        if clue_id in (None, ""):
            raise CollectorError("列表商品 clue_id 为空")
        if not name:
            raise CollectorError(f"clue_id {clue_id} 的产品名称为空")
        if not math.isfinite(amount) or amount < 0:
            raise CollectorError(f"clue_id {clue_id} 的近30天成交金额无效")
        if not band or not amount_fits_band(amount, band):
            raise CollectorError(f"clue_id {clue_id} 的近30天精确金额与档位不一致")
        parsed.append({
            "clue_id": str(clue_id), "name": name,
            "category_path": category_path_text(detail.get("category_path")),
            "pay_30d": amount, "pay_30d_range": range_text, "pay_30d_band": band,
            "labels": extract_labels(raw), "page": page_number, "raw_list": raw,
        })
    if any(parsed[index]["pay_30d"] > parsed[index - 1]["pay_30d"] for index in range(1, len(parsed))):
        raise CollectorError("列表未按近30天成交金额降序返回")
    fingerprint = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return {"items": parsed, "raw": payload, "fingerprint": fingerprint}


def indicator_status_text(data: dict[str, Any]) -> str:
    keys = ("pay_amount_hb_desc", "pay_amount_hb_text", "pay_amount_trend_desc", "status_desc", "status_text")
    return " ".join(str(data.get(key) or "").strip() for key in keys).strip()


def parse_indicator_response(payload: dict[str, Any], requested_clue_id: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CollectorError("指标响应为空")
    if payload.get("code") not in (None, 0):
        raise CollectorError(platform_error_message(payload, "指标接口返回失败"))
    data = payload.get("data")
    if not isinstance(data, dict):
        raise CollectorError("指标响应 data 缺失")
    returned_id = data.get("clue_id", payload.get("clue_id"))
    if returned_id is not None and str(returned_id) != str(requested_clue_id):
        raise CollectorError(f"指标响应错位：请求 {requested_clue_id}，返回 {returned_id}")
    return {"requested_clue_id": str(requested_clue_id), "data": data, "raw": payload}


def classify_indicator(indicator: dict[str, Any], list_item: dict[str, Any]) -> dict[str, Any]:
    data = indicator["data"]
    status_text = indicator_status_text(data)
    labels_text = " ".join(list_item.get("labels", []))
    if "无数据" in status_text or "暂无数据" in status_text or "无法提供" in status_text or "无法确认" in status_text:
        return {"classification": "无法确认", "pay_1d": None, "today": "-", "yesterday": "-", "growth": "-", "raw_hb": None}
    try:
        amount = float(data.get("pay_amount"))
    except (TypeError, ValueError):
        amount = math.nan
    range_text = str(data.get("pay_amount_range") or "").strip()
    band = parse_amount_band(range_text)
    if not math.isfinite(amount) or amount < 0:
        raise CollectorError("今日成交精确值缺失或无效")
    if not band or not amount_fits_band(amount, band):
        raise CollectorError("今日成交精确值与金额档位不一致")
    if "增速快" in status_text or "增速快" in labels_text:
        return {"classification": "增速快", "pay_1d": amount, "today": range_text, "yesterday": "-", "growth": "增速快", "raw_hb": None}
    raw_hb = data.get("pay_amount_hb")
    raw_hb_text = str(raw_hb or "").strip()
    direction = " ".join(str(data.get(key) or "") for key in ("pay_amount_hb_direction", "trend_direction", "direction")).lower()
    down_hint = any(word in f"{direction} {raw_hb_text}" for word in ("down", "decrease", "下降", "下跌", "▼"))
    up_hint = any(word in f"{direction} {raw_hb_text}" for word in ("up", "increase", "上涨", "增长", "▲"))
    if "999.99%+" in raw_hb_text:
        if down_hint and up_hint:
            raise CollectorError("增长方向与环比展示值矛盾")
        if down_hint:
            return {
                "classification": "下跌", "pay_1d": amount, "today": range_text,
                "yesterday": "-", "growth": "极端下降", "raw_hb": raw_hb,
            }
        return {
            "classification": "999.99%+", "pay_1d": amount, "today": range_text,
            "yesterday": "-", "growth": ">999.99%", "raw_hb": raw_hb,
        }
    try:
        hb = float(raw_hb)
    except (TypeError, ValueError):
        hb = math.nan
    if not math.isfinite(hb):
        raise CollectorError("环比值缺失或单位异常")
    if ((any(word in direction for word in ("down", "decrease", "下降", "下跌")) and hb >= 0)
            or (any(word in direction for word in ("up", "increase", "上涨", "增长")) and hb <= 0)):
        raise CollectorError("增长方向与原始环比值矛盾")
    if hb == 0 or "持平" in status_text:
        return {"classification": "持平", "pay_1d": amount, "today": range_text, "yesterday": range_text, "growth": "0.00%", "raw_hb": hb}
    if hb <= -1:
        return {
            "classification": "下跌", "pay_1d": amount, "today": range_text,
            "yesterday": "-", "growth": "极端下降", "raw_hb": hb,
        }
    yesterday_value = amount / (1 + hb)
    if not math.isfinite(yesterday_value) or yesterday_value < 0:
        raise CollectorError("昨日成交反推结果无效")
    if hb < 0:
        classification, growth = "下跌", f"{hb * 100:.2f}%"
    elif hb >= 9.9999:
        classification, growth = "999.99%+", ">999.99%"
    else:
        classification, growth = "上涨", f"{hb * 100:.2f}%"
    return {
        "classification": classification, "pay_1d": amount, "today": range_text,
        "yesterday": value_to_band(yesterday_value), "growth": growth, "raw_hb": hb,
    }


def retry(operation: Callable[[], Any], description: str) -> tuple[Any, int]:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        wait_if_paused()
        if STOP_EVENT.is_set():
            raise CollectorError("用户停止")
        try:
            return operation(), attempt
        except ImmediateStopError:
            raise
        except Exception as error:  # 单次接口和解析失败都进入同一重试口径
            last_error = error
            if attempt < 3:
                delay = RETRY_DELAYS[attempt - 1]
                log(f"{description}失败（{attempt}/3）：{error}；{delay} 秒后重试")
                controlled_wait(delay)
    assert last_error is not None
    setattr(last_error, "attempts", 3)
    raise last_error


class ApiClient:
    def __init__(self, cookie: str, user_agent: str = DEFAULT_USER_AGENT, timeout: int = 30):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Cookie": cookie,
            "User-Agent": user_agent,
            "Referer": PAGE_URL,
            "Origin": BASE_URL,
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
        })

    def _post(
        self,
        url: str,
        payload: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
        response_diagnostics: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = self.session.post(url, json=payload, headers=extra_headers or {}, timeout=self.timeout)
        if response_diagnostics is not None:
            response_diagnostics["http_status"] = response.status_code
            response_diagnostics["response_headers"] = {
                str(name).lower(): str(value)
                for name, value in response.headers.items()
                if str(name).lower() in SAFE_RESPONSE_HEADERS
            }
        if response.status_code in (401, 403, 429):
            raise ImmediateStopError(f"平台返回 HTTP {response.status_code}，请检查登录态或限流")
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "json" not in content_type.lower():
            raise ImmediateStopError("平台返回非 JSON，Cookie 可能已过期或出现验证页")
        try:
            return response.json()
        except requests.JSONDecodeError as error:
            raise ImmediateStopError("平台响应不是有效 JSON") from error

    def fetch_list(
        self,
        category_id: int,
        page_number: int,
        page_size: int,
        second_category_id: int | None = None,
        third_category_id: int | None = None,
    ) -> dict[str, Any]:
        category = {"first_cid": category_id}
        if second_category_id:
            category["second_cid"] = second_category_id
        if third_category_id:
            category["third_cid"] = third_category_id
        payload = {
            "condition": {
                "categories": [category],
                "hit_clue_label_ext": True,
                "show_new_supply_link": True,
                "include_hot_sales_products": True,
                "sort": {"sort_direction": 1, "sort_field": "TRADING_AMOUNT"},
            },
            "clue_type": "", "clue_type_new": 11,
            "page": {"current": page_number, "page_size": page_size},
            "terminal_type": 0, "source": "business_center",
        }
        transport: dict[str, Any] = {}
        raw = self._post(LIST_URL, payload, response_diagnostics=transport)
        try:
            return parse_list_response(raw, page_number)
        except CollectorError as error:
            error.diagnostics = list_failure_diagnostics(payload, raw, transport)
            raise

    def fetch_indicator(self, clue_id: str) -> dict[str, Any]:
        payload = {"clue_id": int(clue_id) if clue_id.isdigit() else clue_id, "recently_day_type": 1}
        raw = self._post(INDICATOR_URL, payload, {"agw-js-conv": "str"})
        return parse_indicator_response(raw, clue_id)

    def close(self) -> None:
        self.session.close()


def new_state(args: argparse.Namespace) -> dict[str, Any]:
    task_id = f"business-{datetime.now():%Y%m%d%H%M%S}-{uuid.uuid4().hex[:8]}"
    return {
        "task_id": task_id, "task_name": f"{args.category_name}｜最低 ¥{args.min_amount:,.0f}",
        "status": "pending", "created_at": now_iso(), "updated_at": now_iso(),
        "completed_at": None, "category": {
            "name": args.category_name,
            "first_cid": args.category_id,
            "second_cid": getattr(args, "second_category_id", None),
            "third_cid": getattr(args, "third_category_id", None),
        },
        "min_amount": args.min_amount, "page_size": args.page_size,
        "page_interval": args.page_interval, "batch_size": args.batch_size,
        "current_page": 0, "next_page": 1, "coverage_complete": False,
        "processed_ids": [], "results": [], "failures": [], "page_checkpoints": [],
        "stats": {}, "report_files": None, "last_error": None, "last_list_failure": None,
    }


def state_checkpoint_path(args: argparse.Namespace) -> Path:
    category_ids = [args.category_id]
    category_ids.extend(
        value for value in (
            getattr(args, "second_category_id", None),
            getattr(args, "third_category_id", None),
        ) if value
    )
    scope = "-".join(str(value) for value in category_ids)
    return Path(args.checkpoint_dir) / f"api-{scope}-{int(args.min_amount)}.json"


def load_or_create_state(args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    checkpoint = state_checkpoint_path(args)
    if not args.fresh:
        state = recover_checkpoint(checkpoint)
    else:
        state = None
    if state is not None:
        expected = (
            args.category_id,
            getattr(args, "second_category_id", None),
            getattr(args, "third_category_id", None),
            args.min_amount,
            args.page_size,
        )
        actual = (
            state["category"]["first_cid"],
            state["category"].get("second_cid"),
            state["category"].get("third_cid"),
            state["min_amount"],
            state["page_size"],
        )
        if actual != expected:
            raise CollectorError("检查点的类目、阈值或分页口径与本次任务不一致")
        log(f"从检查点继续：第 {state['next_page']} 页，已成功 {len(state['results'])} 条")
        return state, checkpoint
    return new_state(args), checkpoint


def refresh_stats(state: dict[str, Any]) -> None:
    classes = Counter(item["classification"] for item in state["results"])
    state["stats"] = {
        "qualifying": len(state["results"]) + len(state["failures"]),
        "success": len(state["results"]), "failed": len(state["failures"]),
        "growth": sum(item["classification"] in POSITIVE_CLASSES for item in state["results"]),
        "classifications": {name: classes.get(name, 0) for name in CLASS_NAMES},
    }
    state["updated_at"] = now_iso()


def save_state(
    state: dict[str, Any],
    checkpoint: Path,
    *,
    pause_on_conflict: bool = False,
    state_listener: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    previous_status = state.get("status", "running")
    while True:
        refresh_stats(state)
        try:
            atomic_write_json(checkpoint, state)
            if state.get("status") == "checkpoint_paused":
                state["status"], state["last_error"] = previous_status, None
            if state_listener is not None:
                state_listener(state)
            return
        except AtomicWriteError as error:
            checkpoint_error = CheckpointIOError(f"本地检查点写入失败：{checkpoint}（{error}）")
            if not pause_on_conflict:
                raise checkpoint_error from error
            state["status"], state["last_error"] = "checkpoint_paused", str(checkpoint_error)
            if state_listener is not None:
                state_listener(state)
            PAUSE_EVENT.set()
            log(f"{checkpoint_error}；任务已暂停，请释放文件占用后点击继续以重试保存")
            wait_if_paused()
            if STOP_EVENT.is_set():
                raise checkpoint_error from error
            state["status"], state["last_error"] = previous_status, None


def success_record(item: dict[str, Any], indicator: dict[str, Any], classified: dict[str, Any], attempts: int) -> dict[str, Any]:
    return {
        "clue_id": item["clue_id"], "category_path": item["category_path"], "product_name": item["name"],
        "pay_30d": item["pay_30d"], "pay_30d_range": item["pay_30d_range"],
        "yesterday": classified["yesterday"], "today": classified["today"], "growth": classified["growth"],
        "classification": classified["classification"], "pay_1d": classified["pay_1d"],
        "raw_hb": classified["raw_hb"], "page": item["page"], "retry_count": attempts - 1,
        "raw_list": item["raw_list"], "raw_indicator": indicator["raw"],
    }


def failure_record(item: dict[str, Any], error: Exception) -> dict[str, Any]:
    record = {
        "clue_id": item["clue_id"], "category_path": item["category_path"], "product_name": item["name"],
        "pay_30d": item["pay_30d"], "pay_30d_range": item["pay_30d_range"], "page": item["page"],
        "stage": "指标采集/校验", "reason": str(error), "retry_count": max(0, getattr(error, "attempts", 1) - 1),
        "raw_list": item["raw_list"],
    }
    raw_indicator = getattr(error, "raw_indicator", None)
    if isinstance(raw_indicator, dict):
        data = raw_indicator.get("data") if isinstance(raw_indicator.get("data"), dict) else {}
        record["raw_indicator"] = raw_indicator
        record["raw_indicator_types"] = {str(key): type(value).__name__ for key, value in data.items()}
    return record


def collect_one(client: ApiClient, item: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    def fetch_and_classify() -> tuple[dict[str, Any], dict[str, Any]]:
        indicator = client.fetch_indicator(item["clue_id"])
        try:
            return indicator, classify_indicator(indicator, item)
        except Exception as error:
            error.raw_indicator = indicator.get("raw")
            raise

    try:
        (indicator, classified), attempts = retry(
            fetch_and_classify,
            f"{item['name']} 指标",
        )
        if indicator["requested_clue_id"] != item["clue_id"]:
            raise CollectorError("指标结果与列表 clue_id 未绑定")
        return "success", success_record(item, indicator, classified, attempts)
    except ImmediateStopError:
        raise
    except Exception as error:
        return "failure", failure_record(item, error)


def process_page_items(
    client: ApiClient,
    items: list[dict[str, Any]],
    state: dict[str, Any],
    checkpoint: Path,
    batch_size: int,
    pause_on_checkpoint_conflict: bool = False,
    state_listener: Callable[[dict[str, Any]], None] | None = None,
) -> None:
    processed = set(state["processed_ids"])
    eligible = [item for item in items if item["clue_id"] not in processed]
    for offset in range(0, len(eligible), batch_size):
        wait_if_paused()
        if STOP_EVENT.is_set():
            return
        batch = eligible[offset:offset + batch_size]
        with concurrent.futures.ThreadPoolExecutor(max_workers=batch_size) as pool:
            future_map = {pool.submit(collect_one, client, item): item for item in batch}
            for future in concurrent.futures.as_completed(future_map):
                item = future_map[future]
                try:
                    kind, record = future.result()
                except ImmediateStopError:
                    STOP_EVENT.set()
                    raise
                state["results" if kind == "success" else "failures"].append(record)
                processed.add(item["clue_id"])
        state["processed_ids"] = sorted(processed)
        save_state(
            state,
            checkpoint,
            pause_on_conflict=pause_on_checkpoint_conflict,
            state_listener=state_listener,
        )


def collect(args: argparse.Namespace, client: ApiClient, state: dict[str, Any], checkpoint: Path) -> dict[str, Any]:
    pause_on_checkpoint_conflict = bool(getattr(args, "pause_on_checkpoint_conflict", False))
    state_listener = getattr(args, "state_listener", None)
    state["status"], state["last_error"] = "running", None
    save_state(
        state,
        checkpoint,
        pause_on_conflict=pause_on_checkpoint_conflict,
        state_listener=state_listener,
    )
    page_number = max(1, int(state["next_page"]))
    last_checkpoint = state["page_checkpoints"][-1] if state["page_checkpoints"] else None
    previous_last_amount = (
        last_checkpoint["last_amount"]
        if last_checkpoint and last_checkpoint["page"] < page_number
        else math.inf
    )
    while not STOP_EVENT.is_set():
        wait_if_paused()
        if args.max_pages and page_number > args.max_pages:
            state["status"] = "sample_completed"
            break
        log(f"读取第 {page_number} 页列表")
        try:
            page, list_attempts = retry(
                lambda: client.fetch_list(
                    args.category_id,
                    page_number,
                    args.page_size,
                    getattr(args, "second_category_id", None),
                    getattr(args, "third_category_id", None),
                ),
                f"第 {page_number} 页列表",
            )
        except Exception as error:
            diagnostics = getattr(error, "diagnostics", None)
            if isinstance(diagnostics, dict):
                state["last_list_failure"] = diagnostics
            raise
        items = page["items"]
        if not items:
            state["coverage_complete"] = True
            state["current_page"] = page_number
            state["next_page"] = page_number
            break
        if items[0]["pay_30d"] > previous_last_amount:
            raise CollectorError(f"第 {page_number} 页首条金额高于上一页末条，跨页排序校验失败")
        qualifying = [item for item in items if item["pay_30d_band"]["min"] >= args.min_amount]
        all_below = all(item["pay_30d_band"]["min"] < args.min_amount for item in items)
        process_page_items(
            client,
            qualifying,
            state,
            checkpoint,
            args.batch_size,
            pause_on_checkpoint_conflict,
            state_listener,
        )
        stopped_inside_page = STOP_EVENT.is_set()
        state["current_page"] = page_number
        state["next_page"] = page_number if stopped_inside_page else page_number + 1
        state["page_checkpoints"].append({
            "page": page_number, "fingerprint": page["fingerprint"], "item_count": len(items),
            "qualifying_count": len(qualifying), "first_amount": items[0]["pay_30d"],
            "last_amount": items[-1]["pay_30d"], "list_retry_count": list_attempts - 1,
            "page_complete": not stopped_inside_page,
            "saved_at": now_iso(), "raw_list_response": page["raw"],
        })
        save_state(
            state,
            checkpoint,
            pause_on_conflict=pause_on_checkpoint_conflict,
            state_listener=state_listener,
        )
        log(f"第 {page_number} 页完成：达标 {len(qualifying)}，累计成功 {state['stats']['success']}，失败 {state['stats']['failed']}")
        if stopped_inside_page:
            state["status"] = "stopped"
            break
        if all_below or len(items) < args.page_size:
            state["coverage_complete"] = True
            break
        if args.max_pages and page_number >= args.max_pages:
            state["status"] = "sample_completed"
            break
        previous_last_amount = items[-1]["pay_30d"]
        page_number += 1
        log(f"等待 {args.page_interval:g} 秒后继续")
        controlled_wait(args.page_interval)
    if state["coverage_complete"]:
        state["status"], state["completed_at"] = "completed", now_iso()
    elif STOP_EVENT.is_set() and state["status"] == "running":
        state["status"] = "stopped"
    save_state(
        state,
        checkpoint,
        pause_on_conflict=pause_on_checkpoint_conflict,
        state_listener=state_listener,
    )
    return state


def retry_failures(args: argparse.Namespace, client: ApiClient, state: dict[str, Any], checkpoint: Path) -> dict[str, Any]:
    pause_on_checkpoint_conflict = bool(getattr(args, "pause_on_checkpoint_conflict", False))
    state_listener = getattr(args, "state_listener", None)
    pending = list(state["failures"])
    state["failures"] = []
    for failure in pending:
        wait_if_paused()
        if STOP_EVENT.is_set():
            state["failures"].append(failure)
            continue
        item = {
            "clue_id": failure["clue_id"], "category_path": failure["category_path"],
            "name": failure["product_name"], "pay_30d": failure["pay_30d"],
            "pay_30d_range": failure["pay_30d_range"], "page": failure["page"],
            "raw_list": failure["raw_list"], "labels": extract_labels(failure["raw_list"]),
        }
        kind, record = collect_one(client, item)
        state["results" if kind == "success" else "failures"].append(record)
        save_state(
            state,
            checkpoint,
            pause_on_conflict=pause_on_checkpoint_conflict,
            state_listener=state_listener,
        )
    return state


def build_markdown(state: dict[str, Any]) -> str:
    stats, category = state["stats"], state["category"]
    category_ids = " / ".join(
        str(category[key]) for key in ("first_cid", "second_cid", "third_cid") if category.get(key)
    )
    lines = [
        f"# {state['task_name']} — 商机采集报告{'（部分）' if not state['coverage_complete'] else ''}", "",
        f"> 任务编号：{state['task_id']}", f"> 类目：{category['name']}（{category_ids}）",
        f"> 最低成交金额：¥{state['min_amount']:,.0f}", f"> 任务状态：{state['status']}",
        f"> 区间覆盖：{'已完成' if state['coverage_complete'] else '未完成'}",
        f"> 达标：{stats['qualifying']}｜成功：{stats['success']}｜增长：{stats['growth']}｜失败：{stats['failed']}",
        "", "## 全部数据", "",
        "| # | 类目 | 产品名称 | 近30天总成交 | 昨日成交 | 今日成交 | 较昨日增长 | 分类 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    clean = lambda value: str(value or "").replace("|", "\\|").replace("\n", " ")
    for index, item in enumerate(state["results"], 1):
        lines.append(f"| {index} | {clean(item['category_path'])} | {clean(item['product_name'])} | {clean(item['pay_30d_range'])} | {clean(item['yesterday'])} | {clean(item['today'])} | {clean(item['growth'])} | {clean(item['classification'])} |")
    lines.extend(["", "## 失败记录", "", "| 类目 | 页码 | 产品名称 | 采集阶段 | 失败原因 | 重试次数 |", "|---|---:|---|---|---|---:|"])
    for item in state["failures"]:
        lines.append(f"| {clean(item['category_path'])} | {item['page']} | {clean(item['product_name'])} | {clean(item['stage'])} | {clean(item['reason'])} | {item['retry_count']} |")
    return "\n".join(lines) + "\n"


def style_sheet(sheet: Any, widths: list[int], header_color: str) -> None:
    header_fill = PatternFill("solid", fgColor=header_color)
    header_font = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFF")
    body_font = Font(name="Microsoft YaHei", size=10, color="17263B")
    line = Side(style="hair", color="D8E0E8")
    for cell in sheet[1]:
        cell.fill, cell.font = header_fill, header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
    sheet.row_dimensions[1].height = 26
    for row in sheet.iter_rows(min_row=2):
        for index, cell in enumerate(row, 1):
            cell.font = body_font
            cell.alignment = Alignment(horizontal="left" if index <= 3 else "center", vertical="center", wrap_text=index == 3)
            cell.border = Border(bottom=line)
    for index, width in enumerate(widths, 1):
        sheet.column_dimensions[chr(64 + index)].width = width
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    sheet.sheet_view.showGridLines = False


def generate_excel(state: dict[str, Any], output_path: Path) -> None:
    if Workbook is None:
        raise CollectorError("缺少 openpyxl，请先运行：python -m pip install openpyxl")
    workbook = Workbook()
    summary = workbook.active
    summary.title = "采集汇总"
    stats, classes = state["stats"], state["stats"]["classifications"]
    category_ids = " / ".join(
        str(state["category"][key]) for key in ("first_cid", "second_cid", "third_cid") if state["category"].get(key)
    )
    summary.append(["任务名称", "任务编号", "采集状态", "区间覆盖", "类目", "类目 ID", "最低金额", "当前页", "达标数量", "失败数量"])
    summary.append([state["task_name"], state["task_id"], state["status"], "已完成" if state["coverage_complete"] else "未完成", state["category"]["name"], category_ids, state["min_amount"], state["current_page"], stats["qualifying"], stats["failed"]])
    summary.append([])
    summary.append(["分类", "上涨", "下跌", "持平", "999.99%+", "增速快", "无法确认", "增长合计", "成功合计", "生成时间"])
    summary.append(["数量", classes["上涨"], classes["下跌"], classes["持平"], classes["999.99%+"], classes["增速快"], classes["无法确认"], stats["growth"], stats["success"], datetime.now()])
    for row_number, color in ((1, "17263B"), (4, "147D76")):
        for cell in summary[row_number]:
            cell.fill = PatternFill("solid", fgColor=color)
            cell.font = Font(name="Microsoft YaHei", size=10, bold=True, color="FFFFFF")
            cell.alignment = Alignment(horizontal="center", vertical="center")
    for index, width in enumerate((38, 34, 20, 14, 24, 18, 16, 12, 14, 22), 1):
        summary.column_dimensions[chr(64 + index)].width = width
    for row_number in (2, 5):
        for cell in summary[row_number]:
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    summary.row_dimensions[2].height = 34
    summary.row_dimensions[5].height = 24
    summary["G2"].number_format = '¥#,##0'
    summary["J5"].number_format = "yyyy-mm-dd hh:mm:ss"
    summary.freeze_panes, summary.sheet_view.showGridLines = "A5", False

    all_sheet = workbook.create_sheet("全部数据")
    all_sheet.append(["#", "类目", "产品名称", "近30天总成交", "昨日成交", "今日成交", "较昨日增长", "分类"])
    for index, item in enumerate(state["results"], 1):
        all_sheet.append([index, item["category_path"], item["product_name"], item["pay_30d_range"], item["yesterday"], item["today"], item["growth"], item["classification"]])
    style_sheet(all_sheet, [7, 46, 34, 19, 19, 19, 18, 14], "17263B")

    growth_sheet = workbook.create_sheet("成交增长")
    growth_sheet.append(["#", "类目", "产品名称", "近30天总成交", "昨日成交", "今日成交", "较昨日增长"])
    growth_items = [item for item in state["results"] if item["classification"] in POSITIVE_CLASSES]
    for index, item in enumerate(growth_items, 1):
        growth_sheet.append([index, item["category_path"], item["product_name"], item["pay_30d_range"], item["yesterday"], item["today"], item["growth"]])
    style_sheet(growth_sheet, [7, 46, 34, 19, 19, 19, 18], "147D76")

    failure_sheet = workbook.create_sheet("失败记录")
    failure_sheet.append(["类目", "页码", "产品名称", "采集阶段", "失败原因", "重试次数"])
    for item in state["failures"]:
        failure_sheet.append([item["category_path"], item["page"], item["product_name"], item["stage"], item["reason"], item["retry_count"]])
    style_sheet(failure_sheet, [46, 10, 34, 20, 54, 14], "A84B4B")
    temporary = output_path.with_name(
        f"{output_path.stem}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp{output_path.suffix}"
    )
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(temporary)
        with CHECKPOINT_LOCK:
            _replace_file(temporary, output_path)
    except AtomicWriteError:
        raise
    except OSError as error:
        raise AtomicWriteError(f"Excel 报告写入失败：{output_path}（{error}）") from error
    finally:
        workbook.close()
        _cleanup_temporary(temporary)


def save_reports(state: dict[str, Any], output_root: Path) -> dict[str, str]:
    refresh_stats(state)
    report_dir = output_root / state["task_id"]
    report_dir.mkdir(parents=True, exist_ok=True)
    partial = not state["coverage_complete"]
    stem = f"选品报告-成交增长-{stamp()}{'-部分' if partial else ''}"
    markdown_path, json_path, xlsx_path = report_dir / f"{stem}.md", report_dir / f"{stem}.json", report_dir / f"{stem}.xlsx"
    paths = (markdown_path, json_path, xlsx_path)
    existed_before = {path: path.exists() for path in paths}
    try:
        atomic_write_text(markdown_path, build_markdown(state))
        atomic_write_json(json_path, state)
        generate_excel(state, xlsx_path)
    except Exception:
        for path in paths:
            if not existed_before[path]:
                _cleanup_temporary(path)
        raise
    files = {"markdown": str(markdown_path.resolve()), "json": str(json_path.resolve()), "xlsx": str(xlsx_path.resolve())}
    state["report_files"] = files
    return files


def self_test() -> None:
    assert parse_amount_band("¥10万-¥25万") == {"min": 100000.0, "max": 250000.0, "raw": "¥10万-¥25万"}
    category_tree = parse_top_categories({"data": [{
        "value": 1, "label": "一级", "children": [{
            "value": 2, "label": "二级", "children": [{"value": 3, "label": "三级", "children": None}],
        }],
    }]})
    assert category_tree[0]["children"][0]["children"][0] == {"id": 3, "name": "三级", "children": []}
    captured_payload: dict[str, Any] = {}
    test_client = ApiClient("test=value")
    test_client._post = lambda _url, payload, _headers=None, response_diagnostics=None: captured_payload.update(payload) or {"code": 0, "data": {"list": []}}
    test_client.fetch_list(1, 1, 18, 2, 3)
    test_client.close()
    assert captured_payload["condition"]["categories"] == [{"first_cid": 1, "second_cid": 2, "third_cid": 3}]
    raw_item = {
        "clue_detail": {"clue_id": 123, "name": "测试商品", "category_path": ["传统滋补", "测试"]},
        "clue_indicator": {"pay_amount_ind": 120000, "pay_amount_ind_range": "¥10万-¥25万"},
    }
    page = parse_list_response({"code": 0, "data": {"list": [raw_item]}}, 1)
    item = page["items"][0]
    cases = ((-0.1, "下跌"), (0, "持平"), (0.25, "上涨"), (10.5, "999.99%+"))
    records = []
    for index, (hb, expected) in enumerate(cases, 1):
        indicator = parse_indicator_response({"code": 0, "data": {"clue_id": 123, "pay_amount": 1200, "pay_amount_range": "¥1000-¥2500", "pay_amount_hb": hb}}, "123")
        classified = classify_indicator(indicator, item)
        assert classified["classification"] == expected
        records.append(success_record(item, indicator, classified, 1) | {"clue_id": str(120 + index)})
    special_cases = (
        ({"clue_id": 123, "pay_amount": 1200, "pay_amount_range": "¥1000-¥2500", "status_desc": "增速快"}, "增速快"),
        ({"clue_id": 123, "status_desc": "暂无数据"}, "无法确认"),
    )
    for index, (data, expected) in enumerate(special_cases, len(records) + 1):
        indicator = parse_indicator_response({"code": 0, "data": data}, "123")
        classified = classify_indicator(indicator, item)
        assert classified["classification"] == expected
        records.append(success_record(item, indicator, classified, 1) | {"clue_id": str(120 + index)})
    try:
        parse_indicator_response({"code": 0, "data": {"clue_id": 999}}, "123")
        raise AssertionError("错位响应未被拒绝")
    except CollectorError:
        pass
    args = argparse.Namespace(category_name="传统滋补", category_id=1000002718, second_category_id=None, third_category_id=None, min_amount=750000, page_size=18, page_interval=20, batch_size=6)
    state = new_state(args)
    state.update({"status": "sample_completed", "current_page": 1, "next_page": 2, "results": records, "failures": [], "processed_ids": [record["clue_id"] for record in records]})
    refresh_stats(state)
    with tempfile.TemporaryDirectory(prefix="doudian-self-test-") as temporary:
        def list_row(clue_id: int, amount: int, amount_range: str) -> dict[str, Any]:
            return {
                "clue_detail": {"clue_id": clue_id, "name": f"测试商品{clue_id}", "category_path": ["传统滋补", "测试"]},
                "clue_indicator": {"pay_amount_ind": amount, "pay_amount_ind_range": amount_range},
            }

        class FakeClient:
            def fetch_list(self, _category_id: int, page_number: int, _page_size: int, _second_id: int | None = None, _third_id: int | None = None) -> dict[str, Any]:
                rows_by_page = {
                    1: [list_row(1, 900000, "¥75万-¥100万"), list_row(2, 800000, "¥75万-¥100万")],
                    2: [list_row(3, 700000, "¥50万-¥75万"), list_row(4, 400000, "¥25万-¥50万")],
                }
                return parse_list_response({"code": 0, "data": {"list": rows_by_page.get(page_number, [])}}, page_number)

            def fetch_indicator(self, clue_id: str) -> dict[str, Any]:
                return parse_indicator_response({
                    "code": 0,
                    "data": {"clue_id": int(clue_id), "pay_amount": 1200, "pay_amount_range": "¥1000-¥2500", "pay_amount_hb": 0.2},
                }, clue_id)

        run_args = argparse.Namespace(
            category_name="传统滋补", category_id=1000002718, second_category_id=None, third_category_id=None, min_amount=750000,
            page_size=2, page_interval=0, batch_size=2, max_pages=0,
        )
        run_state = new_state(run_args)
        run_checkpoint = Path(temporary) / "checkpoint.json"
        STOP_EVENT.clear()
        collected = collect(run_args, FakeClient(), run_state, run_checkpoint)
        assert collected["status"] == "completed"
        assert collected["coverage_complete"] is True
        assert collected["stats"]["success"] == 2
        assert [page["page"] for page in collected["page_checkpoints"]] == [1, 2]

        files = save_reports(state, Path(temporary))
        workbook = load_workbook(files["xlsx"], read_only=True)
        assert workbook.sheetnames == ["采集汇总", "全部数据", "成交增长", "失败记录"]
        assert [cell.value for cell in next(workbook["全部数据"].iter_rows(max_row=1))] == ["#", "类目", "产品名称", "近30天总成交", "昨日成交", "今日成交", "较昨日增长", "分类"]
        workbook.close()
    print("自检通过：金额、排序、clue_id 绑定、6 类分类和四表报告均正常")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="抖店商机中心单类目 API 采集器")
    parser.add_argument("--category-id", type=int, default=1000002718, help="一级类目 first_cid")
    parser.add_argument("--second-category-id", type=int, help="可选二级类目 second_cid")
    parser.add_argument("--third-category-id", type=int, help="可选三级类目 third_cid")
    parser.add_argument("--category-name", default="传统滋补", help="报告中的类目名称")
    parser.add_argument("--min-amount", type=float, default=750000, help="最低近30天成交金额（元）")
    parser.add_argument("--auth", choices=("auto", "edge", "cookie"), default="auto", help="认证方式，默认自动检测 Edge")
    parser.add_argument("--cookie-file", default="cookie.txt", help="Cookie 文件路径")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="浏览器 User-Agent")
    parser.add_argument("--cdp-url", default=CDP_URL, help="Edge 调试端口地址")
    parser.add_argument("--no-auto-launch-edge", action="store_true", help="未检测到调试端口时不自动启动 Edge")
    parser.add_argument("--check-auth", action="store_true", help="只检测认证，不启动采集")
    parser.add_argument("--page-size", type=int, default=18)
    parser.add_argument("--page-interval", type=float, default=20)
    parser.add_argument("--batch-size", type=int, default=6)
    parser.add_argument("--max-pages", type=int, default=0, help="0 为按阈值采完；1～3 用于小样本")
    parser.add_argument("--checkpoint-dir", default="data/checkpoints")
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument("--fresh", action="store_true", help="忽略同口径旧检查点并新建任务")
    parser.add_argument("--retry-failures", action="store_true", help="重试检查点中的失败商品")
    parser.add_argument("--self-test", action="store_true", help="运行离线自检，不访问平台")
    args = parser.parse_args()
    if args.min_amount < 0 or not math.isfinite(args.min_amount):
        parser.error("--min-amount 必须是大于或等于 0 的有限数字")
    if not 1 <= args.batch_size <= 6:
        parser.error("--batch-size 必须在 1～6 之间")
    if args.page_size < 1 or args.page_interval < 0 or args.max_pages < 0:
        parser.error("分页与等待参数无效")
    if args.third_category_id and not args.second_category_id:
        parser.error("--third-category-id 必须与 --second-category-id 一起使用")
    if any(value is not None and value <= 0 for value in (args.second_category_id, args.third_category_id)):
        parser.error("二级和三级类目 ID 必须是正整数")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        self_test()
        return 0
    if Workbook is None:
        raise CollectorError("缺少 openpyxl，请先运行：python -m pip install openpyxl")
    cookie, user_agent, auth_route = resolve_auth(args)
    if args.check_auth:
        print(f"认证检测通过：{auth_route}（认证信息未写入磁盘）")
        return 0
    state, checkpoint = load_or_create_state(args)
    state["auth_route"] = auth_route
    client = ApiClient(cookie, user_agent)
    try:
        if args.retry_failures:
            state = retry_failures(args, client, state, checkpoint)
        else:
            state = collect(args, client, state, checkpoint)
    except KeyboardInterrupt:
        STOP_EVENT.set()
        state["status"], state["last_error"] = "stopped", "用户中断"
    except ImmediateStopError as error:
        state["status"], state["last_error"] = "stopped", str(error)
        log(str(error))
    except Exception as error:
        state["status"], state["last_error"] = "failed", str(error)
        log(f"任务失败：{error}")
    finally:
        client.close()
        save_state(state, checkpoint)
    files = save_reports(state, Path(args.output_dir))
    save_state(state, checkpoint)
    log(f"报告已生成：{files['xlsx']}")
    return 0 if state["status"] in ("completed", "sample_completed", "stopped") else 1


def handle_signal(_signum: int, _frame: Any) -> None:
    if not STOP_EVENT.is_set():
        log("收到停止请求，将在当前请求批次结束后保存检查点")
        STOP_EVENT.set()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, handle_signal)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, handle_signal)
    try:
        raise SystemExit(main())
    except CollectorError as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(2)
