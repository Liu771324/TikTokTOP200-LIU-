from __future__ import annotations

import zipfile
from pathlib import Path


MAX_IMPORT_ROWS = 250_000
MAX_XLSX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_XLSX_ENTRIES = 2_048


def validate_xlsx_container(path_value: str | Path, label: str) -> None:
    path = Path(path_value).resolve()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_XLSX_ENTRIES:
            raise ValueError(f"{label}内部文件数量超过安全上限")
        expanded_bytes = sum(entry.file_size for entry in entries)
        if expanded_bytes > MAX_XLSX_EXPANDED_BYTES:
            raise ValueError(f"{label}解压后大小超过 256 MB 安全上限")
