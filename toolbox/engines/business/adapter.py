"""Synchronous business engine entry points for the unified worker protocol."""
from __future__ import annotations

import hashlib
import json
import math
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from .parser import CLASS_NAMES, CollectorError, ImmediateStopError, classify_indicator, official_id
from .transport import ManagedSession

ENGINE = "business-python-v1"
PAGE_SIZE = 18
BATCH_SIZE = 3
PAGE_INTERVAL = 1.0
RETRY_DELAYS = (0.5, 1.0)
MAX_PAGES = 10000
descriptor = {"toolId": "business-center", "parameterVersion": 1, "requiresBrowser": True,
              "supportsPause": True, "supportsResume": True, "supportsRetryFailed": True}


def invalid(message):
    error = CollectorError(message)
    error.code = "INVALID_PARAMETERS"
    return error


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def validate_parameters(parameters):
    def amount(value, label, optional=False):
        if optional and value in (None, ""):
            return None
        if isinstance(value, bool):
            raise invalid(label + "必须是非负有限金额")
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise invalid(label + "必须是非负有限金额") from None
        if not math.isfinite(value) or value < 0:
            raise invalid(label + "必须是非负有限金额")
        return value

    minimum = amount(parameters.get("minSales", 0), "最低金额")
    maximum = amount(parameters.get("maxSales"), "最高金额", True)
    if maximum is not None and minimum > maximum:
        raise invalid("最低金额不能高于最高金额")
    growth = parameters.get("only30dGrowth", False)
    if type(growth) is not bool:
        raise invalid("近30天增长筛选必须是布尔值")
    categories = parameters.get("categories")
    if not isinstance(categories, list) or not 1 <= len(categories) <= 10000:
        raise invalid("请至少选择一个有效官方类目")
    normalized, seen = [], set()
    for category in categories:
        if not isinstance(category, dict):
            raise invalid("类目缺少官方 ID，请重新读取类目后创建任务")
        segments, ids = category.get("segments"), category.get("valuePath")
        if (not isinstance(segments, list) or not isinstance(ids, list) or not 1 <= len(ids) <= 3
                or len(segments) != len(ids) or any(not isinstance(part, str) or not part.strip() for part in segments)
                or any(not isinstance(cid, str) for cid in ids)):
            raise invalid("类目必须携带完整名称路径及一至三级官方 ID")
        try:
            ids = [official_id(cid) for cid in ids]
        except CollectorError:
            raise invalid("类目官方 ID 格式无效，请重新读取类目") from None
        segments = [" ".join(part.split()) for part in segments]
        display = " / ".join(segments)
        if category.get("displayPath") != display or tuple(ids) in seen:
            raise invalid("类目路径不一致或重复选择")
        seen.add(tuple(ids))
        normalized.append({"displayPath": display, "segments": segments, "valuePath": ids})
    return {"categories": normalized, "minSales": minimum, "maxSales": maximum, "only30dGrowth": growth}


def read_state(context, legacy=False):
    path = Path(context["statePath"])
    if not path.exists():
        return None
    try:
        envelope = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise invalid("任务状态损坏，无法安全恢复") from None
    if (not isinstance(envelope, dict) or envelope.get("formatVersion") != 1
            or envelope.get("toolId") != "business-center" or envelope.get("taskId") != context["taskId"]
            or type(envelope.get("attempt")) is not int or not 1 <= envelope["attempt"] <= context["attempt"]
            or not isinstance(envelope.get("state"), dict)):
        raise invalid("检查点身份与当前任务不匹配")
    state = envelope["state"]
    if state.get("taskId") != context["taskId"] or any(not isinstance(state.get(key), list) for key in ("combinations", "results", "failures")):
        raise invalid("检查点业务数据或任务身份无效")
    if state.get("engine") != ENGINE:
        if legacy:
            return state
        raise invalid("此记录属于旧 DOM 商机引擎，只能预览结果；请使用相同条件新建 Python 任务，旧检查点不能继续或重试。")
    if not legacy:
        try:
            parameters = validate_parameters(state["parameters"])
            expected = ["/".join(item["valuePath"]) for item in parameters["categories"]]
            combinations = state["combinations"]
            if not isinstance(state.get("unparseableItems"), list) or [item["id"] for item in combinations] != expected:
                raise ValueError()
            for combination, category in zip(combinations, parameters["categories"]):
                if combination["category"] != category or type(combination["nextPage"]) is not int or combination["nextPage"] != len(combination["pages"]) + 1:
                    raise ValueError()
                for key in ("processedIds", "scannedIds", "qualifyingIds"):
                    values = combination[key]
                    if not isinstance(values, list) or len(values) != len(set(values)) or any(official_id(value) != value for value in values):
                        raise ValueError()
                if not set(combination["processedIds"]).issubset(combination["qualifyingIds"]):
                    raise ValueError()
                work = combination["currentPageWork"]
                if work is not None and (work["page"] != combination["nextPage"] or not isinstance(work["ids"], list) or not isinstance(work["fingerprint"], str)):
                    raise ValueError()
                if sum(item["itemCount"] for item in combination["pages"]) + len(work["ids"] if work else []) != len(combination["scannedIds"]):
                    raise ValueError()
            keys = [(item["combinationId"], official_id(item["clueId"])) for item in state["results"]]
            if len(keys) != len(set(keys)) or any(cid not in expected for cid, _ in keys) or any(item["classification"] not in CLASS_NAMES for item in state["results"]):
                raise ValueError()
        except (KeyError, TypeError, ValueError, CollectorError):
            raise invalid("Python 检查点业务进度损坏，无法安全恢复；原记录保留可供预览") from None
    return state


def new_state(parameters, context):
    return {"engine": ENGINE, "taskId": context["taskId"], "attempt": context["attempt"], "parameters": parameters,
            "status": "running", "createdAt": now(), "updatedAt": now(), "results": [], "failures": [],
            "unparseableItems": [], "combinations": [
                {"id": "/".join(category["valuePath"]), "category": category, "status": "pending", "nextPage": 1,
                 "coverageComplete": False, "pages": [], "processedIds": [], "scannedIds": [], "qualifyingIds": [],
                 "currentPageWork": None, "error": None} for category in parameters["categories"]], "stats": {}}


def refresh_stats(state):
    classes = Counter(item["classification"] for item in state["results"])
    combinations = state["combinations"]
    for combination in combinations:
        cid = combination["id"]
        combination["resultCount"] = sum(item["combinationId"] == cid for item in state["results"])
        combination["failureCount"] = sum(item["combinationId"] == cid for item in state["failures"])
        combination["qualifyingCount"] = len(combination["qualifyingIds"])
        combination["currentPage"] = (combination.get("currentPageWork") or {}).get("page", max(0, combination["nextPage"] - 1))
    list_coverage = all(item["coverageComplete"] for item in combinations)
    state["coverageComplete"] = list_coverage and not state["failures"] and not state["unparseableItems"]
    state["stats"] = {"totalCategories": len(combinations),
                      "completedCategories": sum(item["coverageComplete"] for item in combinations),
                      "failedCategories": sum(item["status"] == "failed" for item in combinations),
                      "scanned": sum(len(item["scannedIds"]) for item in combinations),
                      "qualifying": sum(len(item["qualifyingIds"]) for item in combinations),
                      "success": len(state["results"]), "failed": len(state["failures"]),
                      "growth": sum(classes[name] for name in ("上涨", "999.99%+", "增速快")),
                      "filteredBy30dGrowth": sum(record.get("growthSkipped", 0) for item in combinations for record in item["pages"]),
                      "invalid30dGrowth": len(state["unparseableItems"]), "listCoverageComplete": list_coverage,
                      "classifications": {name: classes[name] for name in CLASS_NAMES},
                      "checkedPages": sum(len(item["pages"]) for item in combinations),
                      "coverageComplete": state["coverageComplete"]}


def save(state, api):
    state["updatedAt"] = now()
    refresh_stats(state)
    api.checkpoint(state)


def controlled_wait(seconds, api):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        api.boundary()
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    api.boundary()


def retry(operation, api):
    for attempt in range(3):
        api.boundary()
        try:
            return operation(), attempt + 1
        except ImmediateStopError:
            raise
        except CollectorError as error:
            if attempt == 2:
                error.attempts = 3
                raise
            controlled_wait(RETRY_DELAYS[attempt], api)


def failure(combination, stage, reason, page, item=None, attempts=1):
    result = {"combinationId": combination["id"], "categoryPath": combination["category"]["displayPath"],
              "stage": stage, "reason": reason, "page": page, "attempts": attempts}
    if item is not None:
        result.update({"clueId": item["clue_id"], "productName": item["name"], "item": item})
    return result


def outcome(client, item):
    indicator = client.fetch_indicator(item["clue_id"])
    if indicator.get("requested_clue_id") != item["clue_id"]:
        raise CollectorError("指标请求 ID 与列表商品 ID 不一致")
    return {**classify_indicator(indicator, item), "indicatorIdBinding": indicator["idBinding"]}


def store_outcome(state, combination, item, classified, error, attempts):
    key = (combination["id"], item["clue_id"])
    state["failures"] = [record for record in state["failures"] if (record["combinationId"], record.get("clueId")) != key]
    if error is not None:
        state["failures"].append(failure(combination, "指标采集/校验", str(error), item["page"], item, attempts))
    else:
        # daily hb may contain a platform presentation string; retain only a
        # normalized numerical value or a controlled display label.
        raw_hb = classified["raw_hb"]
        if not isinstance(raw_hb, (int, float)):
            raw_hb = None
        record = {"combinationId": key[0], "clueId": key[1], "productName": item["name"],
                  "categoryPath": combination["category"]["displayPath"], "sourceCategoryPath": item["category_path"],
                  "totalSales": item["pay_30d_range"], "pay30d": item["pay_30d"], "pay30dBand": item["pay_30d_band"],
                  "yesterday": classified["yesterday"], "today": classified["today"], "growth": classified["growth"],
                  "classification": classified["classification"], "pay1d": classified["pay_1d"], "dailyHb": raw_hb,
                  "growth30dRate": item.get("growth30dRate"),
                  "indicatorIdBinding": classified["indicatorIdBinding"],
                  "yesterdaySource": "由今日精确金额与今日环比反推档位，非平台昨日原值", "page": item["page"], "attempts": attempts}
        state["results"] = [record for record in state["results"] if (record["combinationId"], record["clueId"]) != key] + [record]
    if item["clue_id"] not in combination["processedIds"]:
        combination["processedIds"].append(item["clue_id"])


def process_items(client, items, state, combination, api):
    for offset in range(0, len(items), BATCH_SIZE):
        pending = items[offset:offset + BATCH_SIZE]
        for attempt in range(1, 4):
            api.boundary()
            next_pending, immediate = [], None
            # A whole admitted batch is drained and committed before responding
            # to cancellation. No retry or next batch starts after a boundary.
            with ThreadPoolExecutor(max_workers=BATCH_SIZE) as pool:
                futures = {}
                try:
                    for item in pending:
                        api.boundary()
                        futures[pool.submit(outcome, client, item)] = item
                except BaseException as error:
                    immediate = error
                for future in as_completed(futures):
                    item = futures[future]
                    try:
                        classified = future.result()
                    except ImmediateStopError as error:
                        immediate = immediate or error
                    except CollectorError as error:
                        if attempt < 3:
                            next_pending.append(item)
                        else:
                            store_outcome(state, combination, item, None, error, attempt)
                    else:
                        store_outcome(state, combination, item, classified, None, attempt)
                save(state, api)
            if immediate is not None:
                raise immediate
            api.boundary()
            if not next_pending:
                break
            pending = next_pending
            controlled_wait(RETRY_DELAYS[attempt - 1], api)


def fingerprint(items):
    return hashlib.sha256(json.dumps(items, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()).hexdigest()


def collect_category(client, state, combination, api):
    parameters = state["parameters"]
    combination["status"], combination["error"] = "running", None
    state["failures"] = [item for item in state["failures"] if not (item["combinationId"] == combination["id"] and item["stage"] == "类目采集/检查")]
    save(state, api)
    while not combination["coverageComplete"]:
        number = combination["nextPage"]
        if number > MAX_PAGES:
            raise CollectorError("类目超过分页安全上限，覆盖未完成")
        page, attempts = retry(lambda: client.fetch_list(combination["category"], number, PAGE_SIZE), api)
        items = page["items"]
        ids = [item["clue_id"] for item in items]
        identity = fingerprint(ids)
        current = combination["currentPageWork"]
        content = fingerprint(items)
        if current is not None and (current["page"] != number or current["fingerprint"] != content):
            raise CollectorError("未完成页的数据已变化，不能安全合并检查点；请新建任务")
        if items and any(record["identity"] == identity for record in combination["pages"]):
            raise CollectorError("平台重复返回已完成列表页，分页覆盖未完成")
        completed_ids = set(combination["scannedIds"]) - set(current["ids"] if current else [])
        if completed_ids.intersection(ids):
            raise CollectorError("商品 ID 跨页重复，分页覆盖未完成")
        previous = combination["pages"][-1] if combination["pages"] else None
        if items and previous and items[0]["pay_30d"] > previous["lastAmount"]:
            raise CollectorError("跨页降序检查失败：本页首条金额高于上一页末条")
        total, has_more = page.get("total"), page.get("hasMore")
        if previous and total is not None and previous.get("total") is not None and total != previous["total"]:
            raise CollectorError("分页总条数发生变化，无法确认完整覆盖")
        if not items and has_more is True:
            raise CollectorError("平台返回空页但仍标记有下一页")
        qualifying = [item for item in items if item["pay_30d_band"]["min"] >= parameters["minSales"]
                      and (parameters["maxSales"] is None or (item["pay_30d_band"]["max"] is not None
                           and item["pay_30d_band"]["max"] <= parameters["maxSales"]))]
        amount_qualifying = qualifying
        growth_skipped = 0
        if parameters["only30dGrowth"]:
            for item in amount_qualifying:
                if item.get("growth30dRate") is None:
                    key = (combination["id"], item["clue_id"])
                    if not any((record["combinationId"], record.get("clueId")) == key for record in state["unparseableItems"]):
                        state["unparseableItems"].append(failure(combination, "近30天增长检查", "官方列表近30天增长字段缺失或无效，未采用今日环比代替", number, item))
                elif item["growth30dRate"] <= 0:
                    growth_skipped += 1
            qualifying = [item for item in amount_qualifying if item.get("growth30dRate") is not None and item["growth30dRate"] > 0]
        if current is None:
            combination["currentPageWork"] = {"page": number, "fingerprint": content, "ids": ids}
            combination["scannedIds"].extend(ids)
            combination["qualifyingIds"].extend(item["clue_id"] for item in qualifying)
            save(state, api)
        done = set(combination["processedIds"])
        process_items(client, [item for item in qualifying if item["clue_id"] not in done], state, combination, api)
        api.boundary()
        threshold_end = bool(items) and items[-1]["pay_30d"] < parameters["minSales"]
        # Some platform replies have no total/has_more. A short page alone is
        # not proof of completion: confirm the following empty page instead.
        terminal = not items or has_more is False
        if total is not None and len(combination["scannedIds"]) > total:
            raise CollectorError("已扫描条数超过官方总条数，分页覆盖不可信")
        if has_more is True and total is not None and len(combination["scannedIds"]) >= total:
            raise CollectorError("官方总条数与下一页标记矛盾，分页覆盖不可信")
        if terminal and not threshold_end and total is not None and len(combination["scannedIds"]) != total:
            raise CollectorError("列表结束条数与官方总条数不一致，覆盖未完成")
        combination["pages"].append({"page": number, "identity": identity, "itemCount": len(items),
                                     "qualifyingCount": len(qualifying), "amountQualifyingCount": len(amount_qualifying),
                                     "growthSkipped": growth_skipped, "firstAmount": items[0]["pay_30d"] if items else None,
                                     "lastAmount": items[-1]["pay_30d"] if items else (previous["lastAmount"] if previous else None),
                                     "total": total, "listAttempts": attempts, "checks": "ID、金额档位、页内/跨页降序、重复页通过"})
        combination["nextPage"], combination["currentPageWork"] = number + 1, None
        if terminal or threshold_end:
            combination["coverageComplete"], combination["status"] = True, "completed"
            combination["completionReason"] = "below-minimum" if threshold_end else "official-list-ended"
        save(state, api)
        api.emit("progress", {"current": state["stats"]["completedCategories"], "total": len(state["combinations"]),
                              "message": f"{combination['category']['displayPath']} · 第{number}页 · {combination['resultCount']}条成功"})
        if not combination["coverageComplete"]:
            controlled_wait(PAGE_INTERVAL, api)


def connect(context, api, state=None):
    while True:
        api.boundary()
        session = None
        try:
            session = ManagedSession(context, api)
            categories = session.categories()
            return session, categories
        except ImmediateStopError as error:
            if session is not None:
                session.close()
            if state is not None:
                save(state, api)
            api.wait_for_user(str(error))
        except BaseException:
            if session is not None:
                session.close()
            raise


def discover(parameters, context, api):
    session, categories = connect(context, api)
    try:
        if len(json.dumps(categories, ensure_ascii=False).encode()) > 800 * 1024:
            for offset in range(0, len(categories), 50):
                api.boundary()
                api.emit("options_chunk", {"field": "categories", "items": categories[offset:offset + 50]})
            return {"categories": [], "source": "official-api"}
        return {"categories": categories, "source": "official-api"}
    finally:
        session.close()


def verify_categories(state, available):
    official = {tuple(item["valuePath"]): item["segments"] for item in available}
    for category in state["parameters"]["categories"]:
        if official.get(tuple(category["valuePath"])) != category["segments"]:
            raise invalid("所选官方类目 ID 或名称路径已变化，请重新读取类目后创建任务")


def retry_unparseable(client, state, combination, api):
    pending = [item for item in state["unparseableItems"] if item["combinationId"] == combination["id"]]
    for number in sorted({item["page"] for item in pending}):
        try:
            page, attempts = retry(lambda: client.fetch_list(combination["category"], number, PAGE_SIZE), api)
        except ImmediateStopError:
            raise
        except CollectorError as error:
            for record in pending:
                if record["page"] == number:
                    record["reason"], record["attempts"] = str(error), getattr(error, "attempts", 1)
            save(state, api)
            continue
        refreshed = {item["clue_id"]: item for item in page["items"]}
        for record in pending:
            if record["page"] != number:
                continue
            item = refreshed.get(record["clueId"])
            if item is None or item.get("growth30dRate") is None:
                record["reason"] = "重试页未找到原商品或近30天增长字段仍无效，未改用其他商品"
                record["attempts"] = attempts
                continue
            original = record["item"]
            if any(item[key] != original[key] for key in ("name", "pay_30d", "pay_30d_range")):
                record["reason"] = "原失败商品的名称或金额已变化，无法安全混合旧快照，请新建任务"
                continue
            key = (combination["id"], item["clue_id"])
            state["unparseableItems"] = [row for row in state["unparseableItems"] if (row["combinationId"], row.get("clueId")) != key]
            if item["growth30dRate"] > 0:
                if item["clue_id"] not in combination["qualifyingIds"]:
                    combination["qualifyingIds"].append(item["clue_id"])
                # Retain a retryable pending record before the next control boundary.
                state["failures"].append(failure(combination, "指标采集/校验", "近30天增长字段已确认，等待指标重试", number, item, 0))
            else:
                for checked in combination["pages"]:
                    if checked["page"] == number:
                        checked["growthSkipped"] = checked.get("growthSkipped", 0) + 1
            save(state, api)
        save(state, api)


def run(parameters, context, api):
    parameters = validate_parameters(parameters)
    state = read_state(context) or new_state(parameters, context)
    if validate_parameters(state.get("parameters") or {}) != parameters:
        raise invalid("恢复时不能更改原任务参数")
    retry_mode = bool(context.get('retryFailed') or state.get('retryingFailures'))
    state['retryingFailures'] = retry_mode
    state.update({"attempt": context["attempt"], "status": "running", "lastError": None, "completedAt": None})
    session = None
    save(state, api)
    try:
        selected = [item for item in state["combinations"] if not item["coverageComplete"] or (
            retry_mode and any(record["combinationId"] == item["id"] for record in state["failures"] + state["unparseableItems"]))]
        if selected:
            session, available = connect(context, api, state)
            verify_categories(state, available)
            state["failures"] = [record for record in state["failures"] if record["stage"] != "任务初始化/检查"]
        for combination in selected:
            while True:
                try:
                    api.boundary()
                    if retry_mode:
                        retry_unparseable(session.client, state, combination, api)
                        items = [record["item"] for record in state["failures"] if record["combinationId"] == combination["id"] and record.get("item")]
                        process_items(session.client, items, state, combination, api)
                    if not combination["coverageComplete"]:
                        collect_category(session.client, state, combination, api)
                    break
                except ImmediateStopError as error:
                    save(state, api)
                    session.close()
                    session = None
                    api.wait_for_user(str(error))
                    session, available = connect(context, api, state)
                    verify_categories(state, available)
                except CollectorError as error:
                    if getattr(error, "code", None) == "CANCELLED" or api.control.cancelled:
                        raise
                    combination.update({"status": "failed", "error": str(error), "coverageComplete": False})
                    state["failures"].append(failure(combination, "类目采集/检查", str(error), combination["nextPage"], attempts=getattr(error, "attempts", 1)))
                    save(state, api)
                    break
        api.boundary()
        state['retryingFailures'] = False
        state["status"] = "completed_with_errors" if state["failures"] or state["unparseableItems"] or not all(item["coverageComplete"] for item in state["combinations"]) else "completed"
    except Exception as error:
        if getattr(error, "code", None) == "CANCELLED" or api.control.cancelled:
            state["status"] = "cancelled"
            for combination in state["combinations"]:
                if not combination["coverageComplete"] and combination["status"] == "running":
                    combination["status"] = "stopped"
        elif isinstance(error, CollectorError):
            state["status"], state["lastError"] = "completed_with_errors", str(error)
            state["failures"].append({"combinationId": "", "categoryPath": "全部类目", "stage": "任务初始化/检查", "reason": str(error), "page": 0, "attempts": 1})
        else:
            save(state, api)
            raise
    finally:
        if session is not None:
            session.close()
    state["completedAt"] = now()
    state["current"] = None
    save(state, api)
    from .report import save_reports

    registrations = save_reports(state, context, api)
    state["reportRegistrations"] = registrations
    save(state, api)
    coverage = {"complete": state["coverageComplete"], "listComplete": state["stats"]["listCoverageComplete"],
                "pendingCategories": state["stats"]["totalCategories"] - state["stats"]["completedCategories"],
                "failed": len(state["failures"]), "unparseable": len(state["unparseableItems"]),
                "pendingProducts": sum(len(set(item["qualifyingIds"]) - set(item["processedIds"])) for item in state["combinations"])}
    checks = {"checkedPages": state["stats"]["checkedPages"], "failedCategories": state["stats"]["failedCategories"],
              "invalid30dGrowth": state["stats"]["invalid30dGrowth"],
              "responseIdVerified": sum(item["indicatorIdBinding"] == "response-id-verified" for item in state["results"]),
              "requestBound": sum(item["indicatorIdBinding"] == "request-bound" for item in state["results"]),
              "rules": ["商品ID及指标绑定", "金额与档位", "页内/跨页降序", "重复页与跨页ID", "分页覆盖", "近30天增长字段"]}
    api.emit("progress", {"current": state["stats"]["completedCategories"], "total": state["stats"]["totalCategories"],
                          "message": "采集结束，报告已保存" if state["status"] != "cancelled" else "已停止，检查点和部分报告已保存",
                          "coverage": coverage, "checks": checks})
    return {"state": state["status"], "stats": state["stats"], "coverageComplete": state["coverageComplete"], "coverage": coverage, "checks": checks}


def read_results(parameters, context, api=None):
    offset, limit, section = parameters.get("offset", 0), parameters.get("limit", 50), parameters.get("section", "results")
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
        raise invalid("结果分页参数无效")
    if section not in ("results", "failures", "unparseableItems"):
        raise invalid("结果分区无效")
    state = read_state(context, legacy=True)
    rows = (state or {}).get(section, [])
    visible = []
    for item in rows[offset:offset + limit]:
        row = {key: value for key, value in item.items() if key not in ("item", "raw_list", "raw_indicator")}
        if section == "results":
            row.setdefault("productName", item.get("keyword", item.get("product_name", "")))
            row.setdefault("totalSales", item.get("salesAmount", item.get("pay_30d_range", "")))
        visible.append(row)
    return {"items": visible, "total": len(rows), "offset": offset, "limit": limit, "stats": (state or {}).get("stats", {}),
            "failures": len((state or {}).get("failures", [])), "unparseable": len((state or {}).get("unparseableItems", [])),
            "engine": (state or {}).get("engine", "legacy-dom"), "readOnly": bool(state and state.get("engine") != ENGINE),
            "coverageComplete": (state or {}).get("coverageComplete", False)}
