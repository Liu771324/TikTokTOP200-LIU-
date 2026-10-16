from __future__ import annotations

import hashlib
import json

from .tabular_source import iter_source_rows, source_sheets


ROLE_HEADERS = {
    "sku": ("商品编码", "SKU编码", "商家SKU编码", "sku_id", "货号"),
    "cost": ("成本价", "基础成本", "采购价", "进货价", "cost_price"),
    "name": ("商品名称", "商品名", "name"),
    "status": ("商品状态", "启用状态", "enabled"),
}


def header_text(cell) -> str:
    return "" if cell.value is None else str(cell.value).strip()


def inspect_layout(content: bytes, name: str, options: dict) -> dict:
    sheets = source_sheets(content, name)
    sheet = options.get("sheet") or sheets[0]
    rows = list(iter_source_rows(content, name, sheet=sheet, encoding=options.get("encoding", "utf-8-sig"), delimiter=options.get("delimiter"), limit=50))
    candidates = []
    for number, row in rows:
        headers = [header_text(cell) for cell in row]
        if any(value in ROLE_HEADERS["sku"] for value in headers) and any(value in ROLE_HEADERS["cost"] for value in headers):
            candidates.append(number)
    header_row = options.get("header_row") or (candidates[0] if len(candidates) == 1 else 1)
    if isinstance(header_row, bool) or not isinstance(header_row, int) or not 1 <= header_row <= 50:
        raise ValueError("表头行必须在前 50 行中选择")
    row = next((row for number, row in rows if number == header_row), ())
    if options.get("header_row") and any(cell.formula or cell.error for cell in row):
        raise ValueError("所选表头包含公式或 Excel 错误，请重新选择表头行")
    headers = [header_text(cell) for cell in row]
    proposed = {}
    for role, aliases in ROLE_HEADERS.items():
        matches = [index for index, value in enumerate(headers) if value in aliases]
        proposed[role] = matches[0] if len(matches) == 1 else None
    return {
        "sheets": sheets, "sheet": sheet, "header_row": header_row,
        "header_candidates": candidates, "headers": headers, "proposed_mapping": proposed,
        "structure": hashlib.sha256(json.dumps(headers, ensure_ascii=False).encode("utf-8")).hexdigest(),
        "sample": [{"row": number, "values": ["[公式无缓存]" if cell.formula and cell.value is None else "" if cell.value is None else str(cell.value) for cell in row]}
                   for number, row in rows if max(1, header_row - 2) <= number < header_row + 10],
        "preview_limit": 50,
    }


def locate_required_headers(content: bytes, name: str, required: tuple[str, ...]) -> tuple[str, int]:
    candidates = []
    for sheet in source_sheets(content, name):
        for number, row in iter_source_rows(content, name, sheet=sheet, limit=50):
            headers = [header_text(cell) for cell in row]
            if all(header in headers for header in required):
                candidates.append((sheet, number))
    if len(candidates) != 1:
        raise ValueError("无法唯一识别工作表和表头；请保留一个含完整必填列的表，或使用通用成本导入明确选择")
    return candidates[0]
