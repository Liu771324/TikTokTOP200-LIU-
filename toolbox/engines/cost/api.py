from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from datetime import datetime
from typing import Any

import requests

from .models import Product
from .signing import calculate_sign
from .windows import format_api_datetime


class APIError(RuntimeError):
    pass


class JushuitanClient:
    def __init__(
        self,
        *,
        api_base_url: str,
        app_key: str,
        app_secret: str,
        access_token: str,
        timeout_seconds: float = 30,
        max_attempts: int = 3,
        session: requests.Session | None = None,
        timestamp: Callable[[], float] = time.time,
    ) -> None:
        self.api_base_url = api_base_url.rstrip("/")
        self.app_key = app_key
        self._app_secret = app_secret
        self._access_token = access_token
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max_attempts
        self._session = session or requests.Session()
        self._timestamp = timestamp

    def query_page(
        self,
        *,
        date_field: str,
        begin: datetime,
        end: datetime,
        page_index: int = 1,
        page_size: int = 100,
    ) -> dict[str, Any]:
        if date_field not in {"created", "modified"}:
            raise ValueError("date_field 必须是 created 或 modified")
        if not 1 <= page_size <= 100:
            raise ValueError("page_size 必须在 1 到 100 之间")

        biz = {
            "page_index": page_index,
            "page_size": page_size,
            # 接口固定使用 modified_begin/modified_end 作为时间边界；
            # date_field 决定这两个边界筛选 created 还是 modified。
            "modified_begin": format_api_datetime(begin),
            "modified_end": format_api_datetime(end),
            "date_field": date_field,
        }
        biz_json = json.dumps(biz, ensure_ascii=False, separators=(",", ":"))
        params: dict[str, str] = {
            "app_key": self.app_key,
            "access_token": self._access_token,
            "timestamp": str(int(self._timestamp())),
            "version": "2",
            "charset": "utf-8",
            "biz": biz_json,
        }
        params["sign"] = calculate_sign(self._app_secret, params)
        payload = self._post_with_retry(params)

        if payload.get("code") not in (0, "0"):
            request_id = payload.get("request_id") or payload.get("requestId")
            suffix = f"，request_id={request_id}" if request_id else ""
            raise APIError(
                f"聚水潭接口错误 code={payload.get('code')}，msg={payload.get('msg')}{suffix}"
            )
        data = payload.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("datas"), list):
            raise APIError("聚水潭响应缺少 data.datas 列表")
        self._validate_pagination(data, requested_page=page_index, requested_size=page_size)
        return data

    def iter_product_pages(
        self,
        *,
        date_field: str,
        begin: datetime,
        end: datetime,
        page_size: int = 100,
    ) -> Iterator[list[Product]]:
        page_index = 1
        while True:
            data = self.query_page(
                date_field=date_field,
                begin=begin,
                end=end,
                page_index=page_index,
                page_size=page_size,
            )
            yield [Product.from_api(item) for item in data["datas"]]
            if not data.get("has_next"):
                break
            page_index += 1
            if page_index > 100_000:
                raise APIError("分页数量异常，已停止同步")

    def _post_with_retry(self, params: dict[str, str]) -> dict[str, Any]:
        url = f"{self.api_base_url}/open/sku/query"
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                response = self._session.post(
                    url,
                    data=params,
                    timeout=self.timeout_seconds,
                    headers={"Content-Type": "application/x-www-form-urlencoded;charset=utf-8"},
                )
            except requests.RequestException as exc:
                last_error = exc
                if attempt == self.max_attempts:
                    break
                time.sleep(2 ** (attempt - 1))
                continue

            if response.status_code == 429 or response.status_code >= 500:
                last_error = APIError(f"HTTP {response.status_code}")
                if attempt == self.max_attempts:
                    break
                retry_after = response.headers.get("Retry-After", "")
                delay = int(retry_after) if retry_after.isdigit() else 2 ** (attempt - 1)
                time.sleep(min(delay, 30))
                continue
            if response.status_code >= 400:
                raise APIError(f"聚水潭请求失败：HTTP {response.status_code}")
            try:
                payload = response.json()
            except requests.exceptions.JSONDecodeError as exc:
                raise APIError("聚水潭返回了非 JSON 响应") from exc
            if not isinstance(payload, dict):
                raise APIError("聚水潭返回的 JSON 结构无效")
            return payload

        raise APIError(f"聚水潭请求在 {self.max_attempts} 次尝试后失败") from last_error

    @staticmethod
    def _validate_pagination(
        data: dict[str, Any], *, requested_page: int, requested_size: int
    ) -> None:
        integer_fields = ("page_index", "page_count", "data_count", "page_size")
        if any(
            isinstance(data.get(field), bool) or not isinstance(data.get(field), int)
            for field in integer_fields
        ):
            raise APIError("聚水潭分页元数据类型无效")
        if not isinstance(data.get("has_next"), bool):
            raise APIError("聚水潭分页字段 has_next 类型无效")
        if data["page_index"] != requested_page:
            raise APIError("聚水潭返回页码与请求页码不一致")
        if data["page_size"] < 1 or data["page_size"] > requested_size:
            raise APIError("聚水潭返回的 page_size 无效")
        if data["page_count"] < 0 or data["data_count"] < 0:
            raise APIError("聚水潭分页数量不能为负数")
        if len(data["datas"]) > data["page_size"]:
            raise APIError("聚水潭单页数据量超过 page_size")
        expected_has_next = data["page_index"] < data["page_count"]
        if data["has_next"] != expected_has_next:
            raise APIError("聚水潭 has_next 与 page_count 相互矛盾")
