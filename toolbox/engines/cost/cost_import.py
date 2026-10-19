from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .database import connect_database, count_products, set_sync_state, upsert_products
from .excel import export_enabled_products, validate_excel
from .locks import create_management_lock
from .models import Product, normalize_decimal
from .publication import cleanup_staged_files, publish_files, require_no_pending_publication
from .sync import _create_temporary_file
from .table_layout import inspect_layout
from .tabular_source import MAX_SOURCE_BYTES, iter_source_rows
from .xlsx_safety import MAX_IMPORT_ROWS
from .update_rollback import backup_database, record_system_update


SHANGHAI = ZoneInfo("Asia/Shanghai")


def _revision(path: Path) -> tuple[int, int]:
    require_no_pending_publication(path)
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def _cost(value: object, number_format: str, sku: str) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        patterns = {
            "plain": r"-?\d+(?:\.\d+)?",
            "grouped": r"-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?",
            "decimal_comma": r"-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?",
        }
        if value and (len(value) > 64 or not re.fullmatch(patterns[number_format], value)):
            raise ValueError("成本不是所选数字格式，请核对小数点、千位符及货币符号")
        if number_format == "grouped":
            value = value.replace(",", "")
        elif number_format == "decimal_comma":
            value = value.replace(".", "").replace(",", ".")
    result = normalize_decimal(value, sku_id=sku)
    if result is not None and len(result) > 64:
        raise ValueError("成本金额位数超过支持范围")
    return result


class CostImportManager:
    """One active catalogue, immutable source bytes and one-use preview tokens."""

    def __init__(self, database: Path, output_excel: Path, *, lock=None):
        self.database = database
        self.output_excel = output_excel
        self.lock = lock or create_management_lock(database)
        self.source: tuple[str, bytes] | None = None
        self.session: dict | None = None

    def inspect(self, path: str | None, options: dict) -> dict:
        with self.lock:
            require_no_pending_publication(self.database)
            self.session = None
            if path is not None:
                self.source = None
                file = Path(path).resolve()
                if not file.is_file() or file.stat().st_size > MAX_SOURCE_BYTES:
                    raise ValueError("请选择 16 MiB 以内的成本表")
                with file.open("rb") as stream:
                    content = stream.read(MAX_SOURCE_BYTES + 1)
                if len(content) > MAX_SOURCE_BYTES:
                    raise ValueError("读取期间文件超过大小上限，请重新选择")
                # Validate before accepting a new source; failed selection cannot
                # accidentally keep the previous file available for confirmation.
                layout = inspect_layout(content, file.name, options)
                self.source = file.name, content
            elif self.source is not None:
                layout = inspect_layout(self.source[1], self.source[0], options)
            else:
                raise ValueError("请先选择成本表")
            with closing(sqlite3.connect(f"{self.database.as_uri()}?mode=ro", uri=True)) as connection:
                row = connection.execute("SELECT value FROM sync_state WHERE key='catalog_scope'").fetchone()
            return {**layout, "file_name": self.source[0], "scope": row[0] if row else "当前成本目录", "profiles": self._profiles()}

    def _profiles(self) -> list[dict]:
        result = []
        directory = self.database.parent / "import-profiles"
        for path in sorted(directory.glob("*.json"))[:30]:
            try:
                if path.stat().st_size > 32 * 1024:
                    continue
                value = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(value, dict) and value.get("version") == 1 and isinstance(value.get("mapping_headers"), dict):
                    result.append(value)
            except (OSError, ValueError):
                continue
        return result

    def preview(self, options: dict) -> dict:
        with self.lock:
            self.session = None
            if self.source is None:
                raise ValueError("请先选择并读取成本表")
            revision = _revision(self.database)
            name, content = self.source
            layout = inspect_layout(content, name, options)
            mapping = options.get("mapping")
            if not isinstance(mapping, dict) or set(mapping) != {"sku", "cost", "name", "status"}:
                raise ValueError("请明确对应商品编码、成本、名称和状态列")
            selected = []
            for role in ("sku", "cost", "name", "status"):
                column = mapping[role]
                if column is None and role in {"name", "status"}:
                    continue
                if isinstance(column, bool) or not isinstance(column, int) or not 0 <= column < len(layout["headers"]):
                    raise ValueError(f"字段 {role} 没有有效来源列")
                selected.append(column)
            if len(set(selected)) != len(selected):
                raise ValueError("不同字段不能重复使用同一列")
            mode = options.get("mode", "merge")
            if mode not in {"merge", "replace"}:
                raise ValueError("请选择增量更新或全量替换")
            if options.get("same_catalog") is not True or options.get("confirmed_basis") is not True:
                raise ValueError("请确认与当前目录使用同一套 SKU，且金额为人民币单个销售 SKU 的基础商品成本")
            if mode == "replace" and options.get("complete_snapshot") is not True:
                raise ValueError("全量替换必须确认所选文件和行范围代表整个成本目录")
            scope = options.get("scope")
            source_label = options.get("source_label")
            if not isinstance(scope, str) or not scope.strip() or len(scope) > 80:
                raise ValueError("请填写 80 字以内的成本目录名称")
            if not isinstance(source_label, str) or not source_label.strip() or len(source_label) > 80:
                raise ValueError("请填写本次表格来源，便于更新历史追溯")
            number_format = options.get("number_format", "plain")
            if number_format not in {"plain", "grouped", "decimal_comma"}:
                raise ValueError("请选择支持的金额数字格式")
            last_row = options.get("last_row")
            if last_row is not None and (isinstance(last_row, bool) or not isinstance(last_row, int) or last_row <= layout["header_row"]):
                raise ValueError("结束行必须在表头之后，留空表示读到文件末尾")
            with closing(sqlite3.connect(f"{self.database.as_uri()}?mode=ro", uri=True)) as connection:
                connection.row_factory = sqlite3.Row
                current = {row["sku_id"]: dict(row) for row in connection.execute("SELECT * FROM products")}
                existing_scope = connection.execute("SELECT value FROM sync_state WHERE key='catalog_scope'").fetchone()
                mapping_counts = dict(connection.execute("SELECT jushuitan_sku_id, COUNT(*) FROM douyin_sku_mappings GROUP BY jushuitan_sku_id"))
            if existing_scope and existing_scope[0] != scope.strip():
                raise ValueError("目录身份与当前生效目录不同；不能按相同编码直接覆盖，请保持原目录名称并核对来源范围")
            products = {}
            errors = []
            total = 0
            for row_number, row in iter_source_rows(content, name, sheet=layout["sheet"], encoding=options.get("encoding", "utf-8-sig"), delimiter=options.get("delimiter"), limit=last_row):
                if row_number <= layout["header_row"] or not any(cell.value not in (None, "") or cell.formula for cell in row):
                    continue
                total += 1
                if total > MAX_IMPORT_ROWS:
                    raise ValueError("商品数据行超过安全上限")
                try:
                    def value(role):
                        index = mapping[role]
                        if index is None or index >= len(row):
                            return None
                        cell = row[index]
                        if cell.error:
                            raise ValueError("字段包含 Excel 错误值，请先修正源表")
                        if cell.formula:
                            if role == "sku" or options.get("allow_cached_formulas") is not True or cell.value is None:
                                raise ValueError("编码不接受公式；其他字段公式需明确接受且必须有缓存值")
                        return cell.value
                    sku = value("sku")
                    if not isinstance(sku, str) or not sku.strip() or len(sku) > 256:
                        raise ValueError("商品编码必须为非空文本，不能猜测数字型编码或前导零")
                    if sku != sku.strip():
                        raise ValueError("商品编码含首尾空白，请先明确修正源表，系统不自动改码")
                    if sku in products:
                        raise ValueError("商品编码重复，请整理成一行一个 SKU")
                    old = current.get(sku)
                    status = old["enabled"] if old else 1
                    if mapping["status"] is not None:
                        status_value = str(value("status")).strip()
                        statuses = {"启用": 1, "1": 1, "禁用": -1, "停用": -1, "-1": -1, "0": 0}
                        if status_value not in statuses:
                            raise ValueError("状态仅支持启用/禁用/停用、1/0/-1")
                        status = statuses[status_value]
                    product_name = value("name") if mapping["name"] is not None else (old["name"] if old else "")
                    products[sku] = Product(
                        sku_id=sku, autoid=old["autoid"] if old else None,
                        name="" if product_name is None else str(product_name),
                        cost_price=_cost(value("cost"), number_format, sku), enabled=status,
                        created=old["created"] if old else None, modified=old["modified"] if old else None,
                    )
                except ValueError as exc:
                    if len(errors) < 20:
                        errors.append(f"第 {row_number} 行：{exc}")
            if not total:
                errors.append("所选行范围没有商品数据")
            if _revision(self.database) != revision:
                raise ValueError("读取期间成本库已更新，请重新预览")
            removed = sorted(current.keys() - products.keys()) if mode == "replace" else []
            changed = [sku for sku, product in products.items() if sku in current and
                       (product.cost_price, product.name, product.enabled) != (current[sku]["cost_price"], current[sku]["name"], current[sku]["enabled"])]
            manifest = {
                "version": 1, "source_label": source_label.strip(), "scope": scope.strip(), "file_name": name,
                "sha256": hashlib.sha256(content).hexdigest(), "sheet": layout["sheet"], "header_row": layout["header_row"],
                "last_row": last_row, "mapping": mapping, "mapping_headers": {role: None if index is None else layout["headers"][index] for role, index in mapping.items()},
                "encoding": options.get("encoding", "utf-8-sig"), "delimiter": options.get("delimiter"),
                "mode": mode, "currency": "CNY", "basis": "base_cost_per_sales_sku", "number_format": number_format,
                "allow_cached_formulas": options.get("allow_cached_formulas") is True,
            }
            token = secrets.token_urlsafe(24)
            if not errors:
                self.session = {"preview_id": token, "revision": revision, "products": tuple(products.values()), "manifest": manifest,
                                "profile_name": str(options.get("profile_name") or "")[:80], "removed": removed}
            return {
                "preview_id": token if not errors else None, "ready_to_import": not errors, "errors": errors,
                "total_rows": total, "added": len(products.keys() - current.keys()), "changed": len(changed),
                "removed": len(removed), "removed_sample": removed[:20], "affected_mappings": sum(mapping_counts.get(sku, 0) for sku in removed),
                "empty_cost": sum(product.cost_price is None for product in products.values()),
                "result_count": len(products) if mode == "replace" else len(current.keys() | products.keys()), "manifest": manifest,
            }

    def apply(self, preview_id: str) -> dict:
        with self.lock:
            session = self.session
            if session is None or not isinstance(preview_id, str) or not secrets.compare_digest(preview_id, session["preview_id"]):
                raise ValueError("成本预览已失效，请重新读取和预览")
            if _revision(self.database) != session["revision"]:
                self.session = None
                raise ValueError("预览后数据已更新，请重新预览")
            name, content = self.source
            manifest = session["manifest"]
            if hashlib.sha256(content).hexdigest() != manifest["sha256"]:
                raise ValueError("预览文件快照校验失败")
            completed = datetime.now(SHANGHAI).isoformat()
            backup = self.database.with_name(f"{self.database.stem}.before-generic-cost-{datetime.now(SHANGHAI).strftime('%Y%m%d-%H%M%S-%f')}{self.database.suffix}.bak")
            backup_hash = backup_database(self.database, backup)
            staged_db = _create_temporary_file(self.database.parent, prefix=f".{self.database.name}.", suffix=".staged.sqlite3")
            staged_excel = _create_temporary_file(self.output_excel.parent, prefix=f".{self.output_excel.name}.", suffix=".staged.xlsx")
            try:
                shutil.copy2(backup, staged_db)
                with connect_database(staged_db) as connection:
                    if manifest["mode"] == "replace":
                        connection.execute("DELETE FROM products")
                    upsert_products(connection, session["products"], synced_at=completed)
                    total_count, enabled_count = count_products(connection), count_products(connection, enabled_only=True)
                    set_sync_state(connection, {
                        "last_successful_sync": completed, "last_mode": "generic_cost_import",
                        "last_fetched_count": str(len(session["products"])), "last_enabled_count": str(enabled_count),
                        "catalog_scope": manifest["scope"], "last_cost_source": json.dumps(manifest, ensure_ascii=False),
                    })
                    record_system_update(connection, update_key=f"catalog:{completed}", kind="catalog", reference_id=completed,
                                         completed_at=completed, backup_path=backup, backup_sha256=backup_hash,
                                         details={"mode": "generic_cost_import", "total_count": total_count, "enabled_count": enabled_count, "source": manifest})
                    connection.commit()
                    export_enabled_products(connection, staged_excel)
                validate_excel(staged_excel, expected_rows=enabled_count, expected_database_path=staged_db)
                publish_files([(staged_db, self.database), (staged_excel, self.output_excel)], database=self.database)
            finally:
                cleanup_staged_files([staged_db, staged_excel])
            self.session = None
            warning = None
            if session["profile_name"]:
                try:
                    directory = self.database.parent / "import-profiles"
                    directory.mkdir(parents=True, exist_ok=True)
                    profile = {"version": 1, "name": session["profile_name"], "mapping_headers": manifest["mapping_headers"]}
                    target = directory / (hashlib.sha256(session["profile_name"].encode("utf-8")).hexdigest()[:20] + ".json")
                    staged = target.with_suffix(".tmp")
                    staged.write_text(json.dumps(profile, ensure_ascii=False), encoding="utf-8")
                    os.replace(staged, target)
                except OSError:
                    warning = "成本已更新，格式模板暂未保存，可稍后重新保存"
            return {"status": "applied", "total_count": total_count, "enabled_count": enabled_count,
                    "backup_file": backup.name, "completed_at": completed, "warning": warning}
