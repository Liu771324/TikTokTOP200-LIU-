from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from cost_sync.database import connect_database, set_sync_state
from cost_sync.update_history import read_update_history
from cost_sync.update_rollback import backup_database, record_system_update


class UpdateHistoryTests(unittest.TestCase):
    def test_reads_unified_history_without_modifying_database(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "cost_accounting.sqlite3"
            with connect_database(database) as connection:
                set_sync_state(
                    connection,
                    {
                        "last_successful_sync": "2026-09-04T09:37:02+08:00",
                        "last_mode": "excel_pair_import",
                        "last_enabled_count": "36798",
                        "last_ordinary_count": "18420",
                        "last_combination_count": "18378",
                    },
                )
                connection.executemany(
                    """
                    INSERT INTO mapping_import_batches (
                        source_file, source_sha256, total_rows, verified_rows,
                        pending_rows, inserted_rows, existing_rows, updated_rows,
                        removed_rows, legacy_rows, shop_name, import_mode, status,
                        imported_at, rolled_back_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'replace', ?, ?, ?)
                    """,
                    (
                        (
                            "shop-older.xlsx", "a" * 64, 100, 90, 10,
                            90, 0, 0, 0, 0, "测试店铺", "applied",
                            "2026-09-02T13:36:26+08:00", None,
                        ),
                        (
                            "shop-today.xlsx", "b" * 64, 110, 95, 15,
                            5, 90, 0, 2, 0, "测试店铺", "applied",
                            "2026-09-04T09:37:55+08:00", None,
                        ),
                    ),
                )
                connection.commit()

            before = hashlib.sha256(database.read_bytes()).hexdigest()
            history = read_update_history(database)
            after = hashlib.sha256(database.read_bytes()).hexdigest()

        self.assertEqual(before, after)
        self.assertEqual(
            ["mapping:2", "catalog:2026-09-04T09:37:02+08:00", "mapping:1"],
            [entry["update_id"] for entry in history],
        )
        self.assertEqual([True, False, False], [entry["is_latest"] for entry in history])
        self.assertEqual("店铺映射更新", history[0]["title"])
        self.assertEqual("商品成本更新", history[1]["title"])
        self.assertEqual(36798, history[1]["enabled_count"])
        self.assertFalse(any(entry["can_rollback"] for entry in history))

    def test_only_latest_safely_tracked_update_is_marked_rollbackable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "cost_accounting.sqlite3"
            with connect_database(database) as connection:
                set_sync_state(
                    connection,
                    {"last_successful_sync": "2026-09-04T09:37:02+08:00"},
                )
                connection.commit()
            backup = Path(temp_dir) / "before-mapping.sqlite3.bak"
            backup_hash = backup_database(database, backup)
            with connect_database(database) as connection:
                batch_id = connection.execute(
                    """
                    INSERT INTO mapping_import_batches (
                        source_file, source_sha256, total_rows, verified_rows,
                        pending_rows, inserted_rows, existing_rows, shop_name,
                        import_mode, status, imported_at
                    ) VALUES ('shop.xlsx', ?, 1, 1, 0, 1, 0, '测试店铺',
                              'replace', 'applied', ?)
                    """,
                    ("a" * 64, "2026-09-04T09:37:55+08:00"),
                ).lastrowid
                record_system_update(
                    connection,
                    update_key=f"mapping:{batch_id}",
                    kind="mapping",
                    reference_id=str(batch_id),
                    completed_at="2026-09-04T09:37:55+08:00",
                    backup_path=backup,
                    backup_sha256=backup_hash,
                    details={"batch_id": batch_id, "shop_name": "测试店铺"},
                )

            history = read_update_history(database)

        self.assertEqual([True, False], [entry["is_latest"] for entry in history])
        self.assertEqual([True, False], [entry["can_rollback"] for entry in history])

    def test_tied_latest_updates_are_not_marked_rollbackable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "cost_accounting.sqlite3"
            with connect_database(database) as connection:
                connection.commit()
            backup = Path(temp_dir) / "before-updates.sqlite3.bak"
            backup_hash = backup_database(database, backup)
            with connect_database(database) as connection:
                for batch_id in (1, 2):
                    record_system_update(
                        connection,
                        update_key=f"mapping:{batch_id}",
                        kind="mapping",
                        reference_id=str(batch_id),
                        completed_at="2026-09-04T09:37:55+08:00",
                        backup_path=backup,
                        backup_sha256=backup_hash,
                        details={"batch_id": batch_id},
                    )

            history = read_update_history(database)

        self.assertEqual(2, len(history))
        self.assertFalse(any(entry["can_rollback"] for entry in history))


if __name__ == "__main__":
    unittest.main()
