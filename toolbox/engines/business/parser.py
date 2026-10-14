"""Business amount and daily trend rules migrated from the original Python collector."""
from __future__ import annotations

import math
import re
from typing import Any


class CollectorError(RuntimeError):
    code = "COLLECTION_FAILED"


class ImmediateStopError(CollectorError):
    code = "LOGIN_REQUIRED"


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

def parse_amount_number(value: Any) -> float | None:
    raw = str(value if value is not None else "").strip().replace("¥", "").replace("￥", "").replace(",", "")
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

def category_path_text(value: Any) -> str:
    if isinstance(value, list):
        return " / ".join(str(part).strip() for part in value if str(part).strip())
    return str(value or "").replace(">", " / ").strip()

def indicator_status_text(data: dict[str, Any]) -> str:
    keys = ("pay_amount_hb_desc", "pay_amount_hb_text", "pay_amount_trend_desc", "status_desc", "status_text")
    return " ".join(str(data.get(key) or "").strip() for key in keys).strip()

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
        if hb != 0:
            raise CollectorError("持平展示与原始环比值矛盾")
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


CLASS_NAMES = ("下跌", "上涨", "持平", "999.99%+", "增速快", "无法确认")
POSITIVE_CLASSES = {"上涨", "999.99%+", "增速快"}


def official_id(value: Any) -> str:
    if isinstance(value, bool) or not re.fullmatch(r"[1-9][0-9]*", str(value)):
        raise CollectorError("官方类目或商品 ID 缺失或格式无效")
    return str(value)


def check_payload(payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise CollectorError("平台响应格式无效")
    base = payload.get("base_resp") or {}
    if not isinstance(base, dict):
        raise CollectorError("平台响应状态格式无效")
    code = payload.get("code", base.get("status_code", 0))
    if code not in (None, 0):
        # Never persist platform messages: they may contain signed URLs or credentials.
        message = str(payload.get("message", payload.get("msg", ""))) + str(base.get("status_message", ""))
        if any(word in message.lower() for word in ("登录", "验证码", "频繁", "限流", "login", "captcha", "verify", "risk")):
            raise ImmediateStopError("平台要求重新登录、完成验证或稍后重试；请在受管浏览器处理后继续")
        raise CollectorError("平台接口返回失败状态")
    return payload


def parse_categories(payload: Any) -> list[dict]:
    rows = check_payload(payload).get("data")
    if not isinstance(rows, list) or not rows:
        raise CollectorError("官方类目接口未返回一级类目列表")
    result = []
    seen = set()

    def walk(items, segments, values):
        if items is None:
            return
        if not isinstance(items, list):
            raise CollectorError("官方类目树层级或结构无效")
        # The migrated API accepts first/second/third_cid; a third-level task
        # includes its descendants. The platform also returns deeper UI nodes.
        if len(values) >= 3:
            return
        siblings = set()
        for item in items:
            if not isinstance(item, dict):
                raise CollectorError("官方类目节点无效")
            cid = official_id(item.get("value"))
            name = " ".join(str(item.get("label") or "").split())
            if not name or cid in siblings:
                raise CollectorError("官方类目名称为空或同级 ID 重复")
            siblings.add(cid)
            path, ids = segments + [name], values + [cid]
            key = tuple(ids)
            if key in seen or len(result) >= 10000:
                raise CollectorError("官方类目重复或超过安全上限")
            seen.add(key)
            result.append({"displayPath": " / ".join(path), "segments": path, "valuePath": ids})
            walk(item.get("children"), path, ids)

    walk(rows, [], [])
    return result


def parse_list(payload: Any, page_number: int) -> dict:
    data = check_payload(payload).get("data")
    if not isinstance(data, (dict, list)):
        raise CollectorError("列表响应 data 缺失")
    rows = data if isinstance(data, list) else next((data[key] for key in ("list", "clue_list", "items", "rows", "data") if isinstance(data.get(key), list)), None)
    if rows is None:
        raise CollectorError("列表响应中未找到商品数组")
    items, seen = [], set()
    for raw in rows:
        if not isinstance(raw, dict) or not isinstance(raw.get("clue_detail"), dict) or not isinstance(raw.get("clue_indicator"), dict):
            raise CollectorError("列表商品结构无效")
        detail, indicator = raw["clue_detail"], raw["clue_indicator"]
        cid = official_id(detail.get("clue_id"))
        name = str(detail.get("name") or "").strip()
        amount = indicator.get("pay_amount_ind")
        if isinstance(amount, bool):
            raise CollectorError("近30天成交金额无效")
        try:
            amount = float(amount)
        except (TypeError, ValueError):
            raise CollectorError("近30天成交金额无效") from None
        text = str(indicator.get("pay_amount_ind_range") or "").strip()
        band = parse_amount_band(text)
        if not name or not math.isfinite(amount) or amount < 0:
            raise CollectorError("商品名称或近30天成交金额无效")
        if not band or not amount_fits_band(amount, band):
            raise CollectorError("近30天精确金额与档位不一致")
        if cid in seen:
            raise CollectorError("同一列表页中商品 ID 重复")
        seen.add(cid)
        labels = []
        for source in (raw, detail):
            for key in ("labels", "clue_labels", "clue_label_ext"):
                candidates = source.get(key)
                for label in candidates if isinstance(candidates, list) else []:
                    if isinstance(label, dict):
                        label = label.get("name") or label.get("label") or label.get("text")
                    if isinstance(label, str) and label.strip():
                        labels.append(label.strip())
        # Keep a whitelist of business fields; never retain raw platform responses.
        rate = indicator.get("pay_amount_ind_30d_rate")
        try:
            rate = None if isinstance(rate, bool) or rate is None else float(rate)
        except (TypeError, ValueError):
            rate = None
        if rate is not None and not math.isfinite(rate):
            rate = None
        items.append({"clue_id": cid, "name": name, "category_path": category_path_text(detail.get("category_path")),
                      "pay_30d": amount, "pay_30d_range": text,
                      "pay_30d_band": {"min": band["min"], "max": None if math.isinf(band["max"]) else band["max"]},
                      "labels": labels, "growth30dRate": rate, "page": page_number})
    if any(item["pay_30d"] > items[index - 1]["pay_30d"] for index, item in enumerate(items) if index):
        raise CollectorError("页内未按近30天成交金额降序返回")
    metadata = data if isinstance(data, dict) else payload
    total = metadata.get("total", metadata.get("total_count"))
    if total is not None and (type(total) is not int or total < 0):
        raise CollectorError("列表总条数无效")
    has_more = metadata.get("has_more")
    if has_more is not None and type(has_more) is not bool:
        if has_more not in (0, 1):
            raise CollectorError("列表分页标记无效")
        has_more = bool(has_more)
    return {"items": items, "total": total, "hasMore": has_more}


def parse_indicator(payload: Any, requested_id: str) -> dict:
    payload = check_payload(payload)
    data = payload.get("data")
    if not isinstance(data, dict):
        raise CollectorError("指标响应 data 缺失")
    returned = data.get("clue_id", payload.get("clue_id"))
    if returned is not None and official_id(returned) != requested_id:
        raise CollectorError("指标响应商品 ID 与请求不一致")
    keys = ("pay_amount", "pay_amount_range", "pay_amount_hb", "pay_amount_hb_direction", "trend_direction", "direction",
            "pay_amount_hb_desc", "pay_amount_hb_text", "pay_amount_trend_desc", "status_desc", "status_text")
    clean = {key: data[key] for key in keys if key in data and isinstance(data[key], (str, int, float, type(None))) and not isinstance(data[key], bool)}
    return {"requested_clue_id": requested_id, "data": clean,
            "idBinding": "response-id-verified" if returned is not None else "request-bound"}
