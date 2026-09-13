from __future__ import annotations

import json
from pathlib import Path


CATALOG_FILE = Path(__file__).resolve().with_name("data") / "douyin_service_fee_2026.json"


def load_bundled_service_fee_catalog(
    path: str | Path | None = None,
) -> dict[str, object]:
    source = CATALOG_FILE if path is None else Path(path).resolve()
    payload = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("rules"), list):
        raise ValueError("内置抖店基础服务费目录格式无效")
    required = {
        "source_article_id",
        "source_updated_at",
        "effective_from",
        "rules",
    }
    if not required.issubset(payload):
        raise ValueError("内置抖店基础服务费目录缺少来源信息")
    return payload
