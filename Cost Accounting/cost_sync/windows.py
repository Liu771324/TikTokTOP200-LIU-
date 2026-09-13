from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta


def iter_time_windows(
    start: datetime, end: datetime, *, window_days: int
) -> Iterator[tuple[datetime, datetime]]:
    """生成首尾均包含且互不重叠的查询窗口。"""
    if start > end:
        return
    if not 1 <= window_days <= 7:
        raise ValueError("window_days 必须在 1 到 7 之间")

    cursor = start
    maximum_span = timedelta(days=window_days) - timedelta(seconds=1)
    while cursor <= end:
        window_end = min(cursor + maximum_span, end)
        yield cursor, window_end
        cursor = window_end + timedelta(seconds=1)


def format_api_datetime(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")

