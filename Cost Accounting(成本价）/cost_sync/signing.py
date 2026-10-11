from __future__ import annotations

import hashlib
from collections.abc import Mapping


def calculate_sign(app_secret: str, params: Mapping[str, object]) -> str:
    """按聚水潭规则生成 32 位小写 MD5 签名。"""
    parts = [app_secret]
    for key in sorted(params):
        value = params[key]
        if key.lower() == "sign" or value is None or value == "":
            continue
        parts.extend((key, str(value)))
    return hashlib.md5("".join(parts).encode("utf-8")).hexdigest()

