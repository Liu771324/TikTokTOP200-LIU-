from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Iterable

from .database import connect_database
from .locks import management_locked
from .update_rollback import backup_database, record_system_update

if TYPE_CHECKING:
    from .mapping_import import MappingCandidate, MappingImportPreview


@dataclass(frozen=True)
class ReviewCaptureResult:
    batch_id: int | None
    saved_rows: int
    unchanged_rows: int
    backup_path: Path | None


@dataclass(frozen=True)
class ReviewResolutionResult:
    candidate_id: int
    batch_id: int
    shop_name: str
    douyin_sku_id: str
    jushuitan_sku_id: str
    previous_shop_name: str | None
    backup_path: Path


def read_mapping_review_candidates(
    database_path: str | Path, *, limit: int = 200
) -> dict[str, object]:
    if not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("待核验列表单次最多读取 500 条")
    database = Path(database_path).resolve()
    with connect_database(database) as connection:
        total = int(connection.execute(
            "SELECT COUNT(*) FROM mapping_review_candidates WHERE status = 'open'"
        ).fetchone()[0])
        rows = connection.execute(
            """
            SELECT id, shop_name, douyin_sku_id, douyin_product_id,
                   merchant_sku_code, product_name, specification,
                   weight_kg, weight_source, weight_unconfigured_reason,
                   major_category, major_category_unconfigured_reason,
                   category_level_1, category_level_2, category_level_3, category_level_4, reason,
                   source_file, source_row, current_shop_name,
                   current_jushuitan_sku_id, captured_at
            FROM mapping_review_candidates
            WHERE status = 'open'
            ORDER BY CASE reason WHEN 'conflict' THEN 0 ELSE 1 END,
                     captured_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return {"total_open": total, "items": [dict(row) for row in rows]}


def upsert_mapping_review_candidates(
    connection: sqlite3.Connection,
    candidates: Iterable["MappingCandidate"],
    *,
    shop_name: str,
    source_file: str,
    source_sha256: str,
    captured_at: str,
    import_batch_id: int,
    conflict_sku_ids: frozenset[str] = frozenset(),
) -> tuple[int, int]:
    current = {
        str(row["douyin_sku_id"]): row
        for row in connection.execute(
            "SELECT douyin_sku_id, shop_name, jushuitan_sku_id "
            "FROM douyin_sku_mappings"
        )
    }
    selected = [
        candidate
        for candidate in candidates
        if candidate.status == "pending" or candidate.douyin_sku_id in conflict_sku_ids
    ]
    saved = unchanged = 0
    for candidate in selected:
        reason = "conflict" if candidate.douyin_sku_id in conflict_sku_ids else "pending"
        mapped = current.get(candidate.douyin_sku_id)
        values = (
            shop_name,
            candidate.douyin_sku_id,
            candidate.douyin_product_id,
            candidate.merchant_sku_code,
            candidate.product_name,
            candidate.specification,
            candidate.weight_kg,
            candidate.weight_source,
            candidate.weight_unconfigured_reason,
            candidate.major_category,
            candidate.major_category_unconfigured_reason,
            candidate.category_level_1,
            candidate.category_level_2,
            candidate.category_level_3,
            candidate.category_level_4,
            reason,
            source_file,
            source_sha256,
            candidate.source_row,
            None if mapped is None else str(mapped["shop_name"]),
            None if mapped is None else str(mapped["jushuitan_sku_id"]),
        )
        existing = connection.execute(
            """
            SELECT shop_name, douyin_sku_id, douyin_product_id, merchant_sku_code,
                   product_name, specification, weight_kg, weight_source,
                   weight_unconfigured_reason, major_category,
                   major_category_unconfigured_reason, category_level_1, category_level_2,
                   category_level_3, category_level_4, reason, source_file, source_sha256,
                   source_row, current_shop_name, current_jushuitan_sku_id
            FROM mapping_review_candidates
            WHERE shop_name = ? AND douyin_sku_id = ? AND status = 'open'
            """,
            (shop_name, candidate.douyin_sku_id),
        ).fetchone()
        if existing is not None and tuple(existing) == values:
            unchanged += 1
            continue
        connection.execute(
            """
            INSERT INTO mapping_review_candidates (
                shop_name, douyin_sku_id, douyin_product_id, merchant_sku_code,
                product_name, specification, weight_kg, weight_source,
                weight_unconfigured_reason, major_category,
                major_category_unconfigured_reason, category_level_1, category_level_2,
                category_level_3, category_level_4, reason, source_file, source_sha256,
                source_row, current_shop_name, current_jushuitan_sku_id, status,
                captured_at, import_batch_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
            ON CONFLICT(shop_name, douyin_sku_id) DO UPDATE SET
                douyin_product_id = excluded.douyin_product_id,
                merchant_sku_code = excluded.merchant_sku_code,
                product_name = excluded.product_name,
                specification = excluded.specification,
                weight_kg = excluded.weight_kg,
                weight_source = excluded.weight_source,
                weight_unconfigured_reason = excluded.weight_unconfigured_reason,
                major_category = excluded.major_category,
                major_category_unconfigured_reason = excluded.major_category_unconfigured_reason,
                category_level_1 = excluded.category_level_1,
                category_level_2 = excluded.category_level_2,
                category_level_3 = excluded.category_level_3,
                category_level_4 = excluded.category_level_4,
                reason = excluded.reason,
                source_file = excluded.source_file,
                source_sha256 = excluded.source_sha256,
                source_row = excluded.source_row,
                current_shop_name = excluded.current_shop_name,
                current_jushuitan_sku_id = excluded.current_jushuitan_sku_id,
                status = 'open',
                captured_at = excluded.captured_at,
                resolved_at = NULL,
                resolved_jushuitan_sku_id = NULL,
                import_batch_id = excluded.import_batch_id,
                resolution_batch_id = NULL
            """,
            (*values, captured_at, import_batch_id),
        )
        saved += 1
    return saved, unchanged


def mark_review_candidates_resolved_by_import(
    connection: sqlite3.Connection,
    candidates: Iterable["MappingCandidate"],
    *,
    shop_name: str,
    resolved_at: str,
    batch_id: int,
) -> None:
    verified = [
        (candidate.jushuitan_sku_id, resolved_at, batch_id, shop_name, candidate.douyin_sku_id)
        for candidate in candidates
        if candidate.status == "verified" and candidate.jushuitan_sku_id is not None
    ]
    connection.executemany(
        """
        UPDATE mapping_review_candidates
        SET status = 'resolved', resolved_jushuitan_sku_id = ?, resolved_at = ?,
            resolution_batch_id = ?
        WHERE shop_name = ? AND douyin_sku_id = ? AND status = 'open'
        """,
        verified,
    )


@management_locked
def capture_mapping_review_candidates(
    database_path: str | Path,
    preview: "MappingImportPreview",
    *,
    shop_name: str,
    conflict_sku_ids: Iterable[str],
    captured_at: str,
) -> ReviewCaptureResult:
    if not preview.ready_to_import:
        raise ValueError("预览存在重复或无效标识，不能保存待处理项")
    conflicts = frozenset(conflict_sku_ids)
    selected_count = sum(
        candidate.status == "pending" or candidate.douyin_sku_id in conflicts
        for candidate in preview.candidates
    )
    if selected_count == 0:
        raise ValueError("本次预览没有待核验或冲突项")
    database = Path(database_path).resolve()
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        unchanged = _count_unchanged(
            connection, preview.candidates, shop_name=shop_name,
            source_file=preview.source_file, source_sha256=preview.source_sha256,
            conflict_sku_ids=conflicts,
        )
        if unchanged == selected_count:
            return ReviewCaptureResult(None, 0, unchanged, None)
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
        backup = database.with_name(
            f"{database.stem}.before-review-capture-{stamp}{database.suffix}.bak"
        )
        backup_hash = backup_database(database, backup)
        cursor = connection.execute(
            """
            INSERT INTO mapping_import_batches (
                source_file, source_sha256, total_rows, verified_rows, pending_rows,
                inserted_rows, existing_rows, updated_rows, removed_rows, legacy_rows,
                shop_name, import_mode, status, imported_at
            ) VALUES (?, ?, ?, 0, ?, 0, 0, 0, 0, 0, ?, 'review', 'applied', ?)
            """,
            (preview.source_file, preview.source_sha256, selected_count, selected_count,
             shop_name, captured_at),
        )
        batch_id = int(cursor.lastrowid)
        saved, unchanged = upsert_mapping_review_candidates(
            connection, preview.candidates, shop_name=shop_name,
            source_file=preview.source_file, source_sha256=preview.source_sha256,
            captured_at=captured_at, import_batch_id=batch_id,
            conflict_sku_ids=conflicts,
        )
        record_system_update(
            connection, update_key=f"mapping:{batch_id}", kind="mapping",
            reference_id=str(batch_id), completed_at=captured_at,
            backup_path=backup, backup_sha256=backup_hash,
            details={"batch_id": batch_id, "shop_name": shop_name,
                     "source_file": preview.source_file, "mode": "review",
                     "total_rows": selected_count, "verified_rows": 0,
                     "pending_rows": saved, "inserted_rows": 0,
                     "existing_rows": unchanged, "updated_rows": 0,
                     "removed_rows": 0, "legacy_rows": 0},
        )
    return ReviewCaptureResult(batch_id, saved, unchanged, backup)


def _count_unchanged(
    connection: sqlite3.Connection,
    candidates: Iterable["MappingCandidate"],
    *,
    shop_name: str,
    source_file: str,
    source_sha256: str,
    conflict_sku_ids: frozenset[str],
) -> int:
    current = {
        str(row["douyin_sku_id"]): row
        for row in connection.execute(
            "SELECT douyin_sku_id, shop_name, jushuitan_sku_id FROM douyin_sku_mappings"
        )
    }
    unchanged = 0
    for candidate in candidates:
        if candidate.status != "pending" and candidate.douyin_sku_id not in conflict_sku_ids:
            continue
        reason = "conflict" if candidate.douyin_sku_id in conflict_sku_ids else "pending"
        mapped = current.get(candidate.douyin_sku_id)
        row = connection.execute(
            """
            SELECT douyin_product_id, merchant_sku_code, product_name, specification,
                   weight_kg, weight_source, weight_unconfigured_reason,
                   major_category, major_category_unconfigured_reason,
                   category_level_1, category_level_2, category_level_3, category_level_4,
                   reason, source_file, source_sha256, source_row,
                   current_shop_name, current_jushuitan_sku_id
            FROM mapping_review_candidates
            WHERE shop_name = ? AND douyin_sku_id = ? AND status = 'open'
            """,
            (shop_name, candidate.douyin_sku_id),
        ).fetchone()
        expected = (
            candidate.douyin_product_id, candidate.merchant_sku_code,
            candidate.product_name, candidate.specification,
            candidate.weight_kg, candidate.weight_source,
            candidate.weight_unconfigured_reason,
            candidate.major_category,
            candidate.major_category_unconfigured_reason,
            candidate.category_level_1, candidate.category_level_2,
            candidate.category_level_3, candidate.category_level_4,
            reason, source_file,
            source_sha256, candidate.source_row,
            None if mapped is None else str(mapped["shop_name"]),
            None if mapped is None else str(mapped["jushuitan_sku_id"]),
        )
        if row is not None and tuple(row) == expected:
            unchanged += 1
    return unchanged


@management_locked
def resolve_mapping_review_candidate(
    database_path: str | Path,
    candidate_id: int,
    jushuitan_sku_id: str,
    *,
    resolved_at: str,
) -> ReviewResolutionResult:
    if not isinstance(candidate_id, int) or candidate_id <= 0:
        raise ValueError("待核验记录编号无效")
    target_sku = jushuitan_sku_id.strip() if isinstance(jushuitan_sku_id, str) else ""
    if not target_sku or len(target_sku) > 200:
        raise ValueError("请输入有效的聚水潭商品编码")
    database = Path(database_path).resolve()
    with connect_database(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        candidate = connection.execute(
            "SELECT * FROM mapping_review_candidates WHERE id = ? AND status = 'open'",
            (candidate_id,),
        ).fetchone()
        if candidate is None:
            raise ValueError("待核验记录不存在或已经处理")
        product = connection.execute(
            "SELECT 1 FROM products WHERE sku_id = ? AND enabled = 1", (target_sku,)
        ).fetchone()
        if product is None:
            raise ValueError("聚水潭商品编码不存在或未启用")
        current = connection.execute(
            "SELECT shop_name, jushuitan_sku_id FROM douyin_sku_mappings "
            "WHERE douyin_sku_id = ?", (candidate["douyin_sku_id"],)
        ).fetchone()
        actual = None if current is None else (
            str(current["shop_name"]), str(current["jushuitan_sku_id"])
        )
        captured = (
            None if candidate["current_shop_name"] is None else str(candidate["current_shop_name"]),
            None if candidate["current_jushuitan_sku_id"] is None else str(candidate["current_jushuitan_sku_id"]),
        )
        if (actual is None and captured != (None, None)) or (
            actual is not None and actual != captured
        ):
            raise ValueError("该 SKUID 的现有映射已变化，请重新导入最新店铺表核验")
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
        backup = database.with_name(
            f"{database.stem}.before-manual-mapping-{stamp}{database.suffix}.bak"
        )
        backup_hash = backup_database(database, backup)
        cursor = connection.execute(
            """
            INSERT INTO mapping_import_batches (
                source_file, source_sha256, total_rows, verified_rows, pending_rows,
                inserted_rows, existing_rows, updated_rows, removed_rows, legacy_rows,
                shop_name, import_mode, status, imported_at
            ) VALUES (?, ?, 1, 1, 0, ?, 0, ?, 0, 0, ?, 'manual', 'applied', ?)
            """,
            (candidate["source_file"], candidate["source_sha256"],
             1 if current is None else 0, 0 if current is None else 1,
             candidate["shop_name"], resolved_at),
        )
        batch_id = int(cursor.lastrowid)
        connection.execute(
            """
            INSERT INTO douyin_sku_mappings (
                douyin_sku_id, douyin_product_id, merchant_sku_code,
                jushuitan_sku_id, product_name, specification, weight_kg,
                weight_source, weight_unconfigured_reason, category_level_1,
                category_level_2, category_level_3, category_level_4,
                major_category, major_category_unconfigured_reason, status,
                import_batch_id, created_at, updated_at, shop_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?)
            ON CONFLICT(douyin_sku_id) DO UPDATE SET
                douyin_product_id = excluded.douyin_product_id,
                merchant_sku_code = excluded.merchant_sku_code,
                jushuitan_sku_id = excluded.jushuitan_sku_id,
                product_name = excluded.product_name,
                specification = excluded.specification,
                weight_kg = excluded.weight_kg,
                weight_source = excluded.weight_source,
                weight_unconfigured_reason = excluded.weight_unconfigured_reason,
                category_level_1 = excluded.category_level_1,
                category_level_2 = excluded.category_level_2,
                category_level_3 = excluded.category_level_3,
                category_level_4 = excluded.category_level_4,
                major_category = excluded.major_category,
                major_category_unconfigured_reason = excluded.major_category_unconfigured_reason,
                status = 'verified', import_batch_id = excluded.import_batch_id,
                updated_at = excluded.updated_at, shop_name = excluded.shop_name
            """,
            (candidate["douyin_sku_id"], candidate["douyin_product_id"],
             candidate["merchant_sku_code"], target_sku, candidate["product_name"],
             candidate["specification"], candidate["weight_kg"],
             candidate["weight_source"], candidate["weight_unconfigured_reason"],
             candidate["category_level_1"],
             candidate["category_level_2"], candidate["category_level_3"],
             candidate["category_level_4"], candidate["major_category"],
             candidate["major_category_unconfigured_reason"],
             batch_id, resolved_at, resolved_at,
             candidate["shop_name"]),
        )
        connection.execute(
            """
            UPDATE mapping_review_candidates
            SET status = 'resolved', resolved_at = ?, resolved_jushuitan_sku_id = ?,
                resolution_batch_id = ?
            WHERE id = ?
            """,
            (resolved_at, target_sku, batch_id, candidate_id),
        )
        previous_shop = None if current is None else str(current["shop_name"])
        record_system_update(
            connection, update_key=f"mapping:{batch_id}", kind="mapping",
            reference_id=str(batch_id), completed_at=resolved_at,
            backup_path=backup, backup_sha256=backup_hash,
            details={"batch_id": batch_id, "shop_name": str(candidate["shop_name"]),
                     "source_file": str(candidate["source_file"]), "mode": "manual",
                     "total_rows": 1, "verified_rows": 1, "pending_rows": 0,
                     "inserted_rows": 1 if current is None else 0,
                     "existing_rows": 0, "updated_rows": 0 if current is None else 1,
                     "removed_rows": 0, "legacy_rows": 0},
        )
    return ReviewResolutionResult(
        candidate_id, batch_id, str(candidate["shop_name"]),
        str(candidate["douyin_sku_id"]), target_sku,
        previous_shop, backup,
    )
