"""Read the host's current Edge session and call fixed platform endpoints."""
from __future__ import annotations

import json
import time
from urllib.parse import urlsplit

import requests

from .parser import CollectorError, ImmediateStopError, parse_categories, parse_indicator, parse_list

BASE_URL = "https://fxg.jinritemai.com"
PAGE_PATH = "/ffa/bu/NewBusinessCenter"
CATEGORY_PATH = "/api/commop/business_chance_center/shop_full_category/list"
LIST_URL = BASE_URL + "/api/commop/business_chance_center/clue/common/real_time_list"
INDICATOR_URL = BASE_URL + "/api/commop/business_chance_center/clue/common/indicator"


def platform_url(value, path=None):
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https" and parsed.hostname == "fxg.jinritemai.com"
                and parsed.port in (None, 443) and not parsed.username and not parsed.password
                and (path is None or parsed.path == path))
    except (TypeError, ValueError):
        return False


class ManagedSession:
    """Only attaches to the endpoint granted by the host; never navigates Edge."""

    def __init__(self, context, api):
        self.api, self.playwright = api, None
        endpoint = (context.get("browser") or {}).get("endpoint")
        try:
            parsed = urlsplit(endpoint or "")
            valid = (parsed.scheme in ("http", "ws") and parsed.hostname in ("127.0.0.1", "localhost")
                     and parsed.port is not None and not parsed.username and not parsed.password)
        except ValueError:
            valid = False
        if not valid:
            error = CollectorError("需要宿主授予的受管浏览器会话")
            error.code = "BROWSER_DISCONNECTED"
            raise error
        try:
            from playwright.sync_api import sync_playwright

            api.boundary()
            self.playwright = sync_playwright().start()
            browser = self.playwright.chromium.connect_over_cdp(endpoint, timeout=5000)
            page_id = (context.get("browser") or {}).get("pageId")
            self.page = None
            for browser_context in browser.contexts:
                for page in browser_context.pages:
                    if not platform_url(page.url, PAGE_PATH):
                        continue
                    if page_id:
                        cdp = browser_context.new_cdp_session(page)
                        try:
                            if cdp.send("Target.getTargetInfo")["targetInfo"]["targetId"] != page_id:
                                continue
                        finally:
                            cdp.detach()
                    self.page, self.browser_context = page, browser_context
                    break
                if self.page is not None:
                    break
            if self.page is None:
                raise ImmediateStopError("请在受管 Edge 中登录抖店并打开商机中心后继续")
            api.boundary()
            cookies = self.browser_context.cookies([BASE_URL])
            cookie = "; ".join(f"{entry['name']}={entry['value']}" for entry in cookies if entry.get("name") and entry.get("value") is not None)
            if not cookie:
                raise ImmediateStopError("受管浏览器未提供抖店登录态，请登录后继续")
            self.client = ApiClient(cookie, str(self.page.evaluate("navigator.userAgent")))
        except BaseException as error:
            self.close()
            if isinstance(error, CollectorError) or getattr(error, "code", None) == "CANCELLED" or api.control.cancelled:
                raise
            raise CollectorError("受管浏览器连接失败，请重新打开抖店商机中心") from None

    def categories(self):
        self.api.boundary()
        try:
            urls = self.page.evaluate("performance.getEntriesByType('resource').map(x => x.name)")
            signed_url = next((url for url in reversed(urls) if platform_url(url, CATEGORY_PATH)), None)
            if signed_url is None:
                raise CollectorError("当前页面未加载官方类目接口，请刷新受管浏览器商机中心后重新读取")
            self.api.boundary()
            return parse_categories(self.client.request(signed_url, None))
        except CollectorError:
            raise
        except Exception as error:
            if getattr(error, "code", None) == "CANCELLED" or self.api.control.cancelled:
                raise
            raise CollectorError("读取受管浏览器类目数据失败，请刷新商机中心后重试") from None

    def close(self):
        if self.playwright is not None:
            try:
                self.playwright.stop()  # Disconnect only; do not close the host's browser.
            except Exception:
                pass  # A disconnected host must not prevent checkpoint/report saving.
            self.playwright = None


class ApiClient:
    def __init__(self, cookie, user_agent):
        self.headers = {"Cookie": cookie, "User-Agent": user_agent, "Referer": BASE_URL + PAGE_PATH,
                        "Origin": BASE_URL, "Accept": "application/json", "Content-Type": "application/json"}

    def request(self, url, payload, extra_headers=None):
        if url not in (LIST_URL, INDICATOR_URL) and not (payload is None and platform_url(url, CATEGORY_PATH)):
            raise CollectorError("拒绝请求不受支持的平台接口")
        deadline = time.monotonic() + 5
        try:
            # Each request owns its Session; no mutable Session is shared by threads.
            with requests.Session() as session:
                session.trust_env = False
                with session.request("GET" if payload is None else "POST", url,
                                     json=payload, headers={**self.headers, **(extra_headers or {})},
                                     timeout=(2, 2), allow_redirects=False, stream=True) as response:
                    if response.status_code in (301, 302, 303, 307, 308, 401, 403, 429):
                        raise ImmediateStopError("平台要求重新登录、完成验证或稍后重试；请在受管浏览器处理后继续")
                    if response.status_code != 200:
                        raise CollectorError("平台接口 HTTP 请求失败")
                    if "json" not in response.headers.get("content-type", "").lower():
                        raise ImmediateStopError("平台返回验证或登录页面，请在受管浏览器处理后继续")
                    chunks, size = [], 0
                    while True:
                        if time.monotonic() >= deadline:
                            raise CollectorError("平台接口读取超过时间限制")
                        # read1 does at most one socket read, so slow trickles cannot
                        # indefinitely reset a whole-body requests read timeout.
                        chunk = response.raw.read1(65536, decode_content=True)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > 8 * 1024 * 1024:
                            raise CollectorError("平台接口响应超过安全上限")
                        chunks.append(chunk)
                    try:
                        return json.loads(b"".join(chunks))
                    except (ValueError, UnicodeError):
                        raise ImmediateStopError("平台未返回有效 JSON，请检查登录或验证状态") from None
        except (CollectorError, ImmediateStopError):
            raise
        except Exception:
            # requests exceptions embed request URLs; do not leak signed query data.
            raise CollectorError("平台接口连接失败或超时") from None

    def fetch_list(self, category, page_number, page_size):
        ids = category["valuePath"]
        category_ids = dict(zip(("first_cid", "second_cid", "third_cid"), (int(cid) for cid in ids)))
        payload = {"condition": {"categories": [category_ids], "hit_clue_label_ext": True,
                                 "show_new_supply_link": True, "include_hot_sales_products": True,
                                 "sort": {"sort_direction": 1, "sort_field": "TRADING_AMOUNT"}},
                   "clue_type": "", "clue_type_new": 11, "page": {"current": page_number, "page_size": page_size},
                   "terminal_type": 0, "source": "business_center"}
        return parse_list(self.request(LIST_URL, payload), page_number)

    def fetch_indicator(self, clue_id):
        return parse_indicator(self.request(INDICATOR_URL, {"clue_id": int(clue_id), "recently_day_type": 1},
                                            {"agw-js-conv": "str"}), clue_id)
