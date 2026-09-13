import sqlite3
import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

import cost_sync.database as database_module
from cost_sync.database import connect_database, count_products, upsert_products
from cost_sync.models import Product


class ProductAndDatabaseTests(unittest.TestCase):
    def test_schema_checks_run_once_until_the_database_file_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "cost.sqlite3"
            with mock.patch(
                "cost_sync.database._ensure_mapping_shop_columns",
                wraps=database_module._ensure_mapping_shop_columns,
            ) as ensure:
                with connect_database(database):
                    pass
                with connect_database(database):
                    pass
                self.assertEqual(1, ensure.call_count)
                replacement = database.with_name("replacement.sqlite3")
                sqlite3.connect(replacement).close()
                os.replace(replacement, database)
                with connect_database(database):
                    pass
            self.assertEqual(2, ensure.call_count)

    def test_decimal_is_normalized_without_binary_float(self) -> None:
        product = Product.from_api(
            {"sku_id": "001", "name": "测试", "cost_price": "10.2300", "enabled": 1}
        )
        self.assertEqual("10.23", product.cost_price)

    def test_invalid_cost_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Product.from_api(
                {"sku_id": "001", "name": "测试", "cost_price": "NaN", "enabled": 1}
            )

    def test_negative_cost_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "cost_price"):
            Product.from_api(
                {"sku_id": "001", "name": "测试", "cost_price": "-5", "enabled": 1}
            )

    def test_autoid_rename_removes_old_sku(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "test.sqlite3"
            with connect_database(database) as connection:
                first = Product("OLD", 42, "旧编码", "1.2", 1, None, None)
                renamed = Product("NEW", 42, "新编码", "1.3", 1, None, None)
                upsert_products(connection, [first], synced_at="2026-01-01T00:00:00+08:00")
                upsert_products(connection, [renamed], synced_at="2026-01-02T00:00:00+08:00")
                connection.commit()
                self.assertEqual(1, count_products(connection))
                row = connection.execute("SELECT sku_id, cost_price FROM products").fetchone()
                self.assertEqual(("NEW", "1.3"), tuple(row))

    def test_existing_mapping_database_adds_shop_columns_without_losing_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "legacy.sqlite3"
            with closing(sqlite3.connect(database)) as connection:
                connection.executescript(
                    """
                    CREATE TABLE mapping_import_batches (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        source_file TEXT NOT NULL,
                        source_sha256 TEXT NOT NULL,
                        total_rows INTEGER NOT NULL,
                        verified_rows INTEGER NOT NULL,
                        pending_rows INTEGER NOT NULL,
                        inserted_rows INTEGER NOT NULL,
                        existing_rows INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        imported_at TEXT NOT NULL,
                        rolled_back_at TEXT NULL
                    );
                    CREATE TABLE douyin_sku_mappings (
                        douyin_sku_id TEXT PRIMARY KEY,
                        douyin_product_id TEXT NOT NULL,
                        merchant_sku_code TEXT NOT NULL,
                        jushuitan_sku_id TEXT NOT NULL,
                        product_name TEXT NOT NULL,
                        specification TEXT NOT NULL,
                        status TEXT NOT NULL,
                        import_batch_id INTEGER NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    INSERT INTO mapping_import_batches VALUES (
                        1, 'legacy.xlsx', 'abc', 1, 1, 0, 1, 0,
                        'applied', '2026-09-01T00:00:00+08:00', NULL
                    );
                    INSERT INTO douyin_sku_mappings VALUES (
                        'DY-1', 'P-1', 'ERP-1', 'ERP-1', '商品', '规格',
                        'verified', 1, '2026-09-01T00:00:00+08:00',
                        '2026-09-01T00:00:00+08:00'
                    );
                    """
                )
                connection.commit()

            with connect_database(database) as connection:
                batch = connection.execute(
                    "SELECT shop_name, import_mode, updated_rows, removed_rows, legacy_rows "
                    "FROM mapping_import_batches WHERE id = 1"
                ).fetchone()
                mapping = connection.execute(
                    "SELECT douyin_sku_id, shop_name FROM douyin_sku_mappings"
                ).fetchone()
                mapping_columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(douyin_sku_mappings)")
                }
                review_columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(mapping_review_candidates)")
                }

            self.assertEqual(("历史导入", "append", 0, 0, 0), tuple(batch))
            self.assertEqual(("DY-1", "历史导入"), tuple(mapping))
            expected_categories = {
                "category_level_1",
                "category_level_2",
                "category_level_3",
                "category_level_4",
            }
            self.assertTrue(expected_categories <= mapping_columns)
            self.assertTrue(expected_categories <= review_columns)

    def test_legacy_service_fee_unique_index_is_rebuilt_without_losing_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database = Path(temp_dir) / "legacy.sqlite3"
            with closing(sqlite3.connect(database)) as connection:
                connection.executescript(
                    """
                    CREATE TABLE basic_service_fee_rates (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        major_category TEXT NOT NULL DEFAULT '',
                        category_level_1 TEXT NOT NULL,
                        category_level_2 TEXT NOT NULL,
                        category_level_3 TEXT NOT NULL,
                        category_level_4 TEXT NOT NULL,
                        rate TEXT NOT NULL,
                        effective_from TEXT NOT NULL,
                        enabled INTEGER NOT NULL DEFAULT 1,
                        note TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        UNIQUE (
                            category_level_1, category_level_2, category_level_3,
                            category_level_4, effective_from
                        )
                    );
                    CREATE TABLE basic_service_fee_rate_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        rate_id INTEGER NOT NULL REFERENCES basic_service_fee_rates(id),
                        action TEXT NOT NULL,
                        enabled INTEGER NOT NULL,
                        changed_at TEXT NOT NULL
                    );
                    INSERT INTO basic_service_fee_rates (
                        id, major_category, category_level_1, category_level_2,
                        category_level_3, category_level_4, rate, effective_from,
                        enabled, note, created_at, updated_at
                    ) VALUES (
                        41, '', '冷冻/冷藏制品', '面点', '中式面点', '圆子/芋圆',
                        '0.03', '2026-07-15', 1, '旧规则',
                        '2026-07-15T00:00:00+08:00', '2026-07-15T00:00:00+08:00'
                    );
                    INSERT INTO basic_service_fee_rate_events (
                        id, rate_id, action, enabled, changed_at
                    ) VALUES (9, 41, 'created', 1, '2026-07-15T00:00:00+08:00');
                    """
                )
                connection.commit()

            with connect_database(database) as connection:
                unique_indexes = [
                    row
                    for row in connection.execute(
                        "PRAGMA index_list(basic_service_fee_rates)"
                    )
                    if int(row[2]) == 1
                ]
                unique_columns = {
                    tuple(
                        str(column[2])
                        for column in connection.execute(
                            f"PRAGMA index_info({row[1]})"
                        )
                    )
                    for row in unique_indexes
                }
                rate = connection.execute(
                    "SELECT id, major_category, rate, note "
                    "FROM basic_service_fee_rates WHERE id = 41"
                ).fetchone()
                event = connection.execute(
                    "SELECT id, rate_id, action FROM basic_service_fee_rate_events WHERE id = 9"
                ).fetchone()
                connection.execute(
                    """
                    INSERT INTO basic_service_fee_rates (
                        major_category, category_level_1, category_level_2,
                        category_level_3, category_level_4, rate, effective_from,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "生鲜", "冷冻/冷藏制品", "面点", "中式面点", "圆子/芋圆",
                        "0.03", "2026-07-15", "2026-09-11T00:00:00+08:00",
                        "2026-09-11T00:00:00+08:00",
                    ),
                )

            self.assertEqual(
                {
                    (
                        "major_category", "category_level_1", "category_level_2",
                        "category_level_3", "category_level_4", "effective_from",
                    )
                },
                unique_columns,
            )
            self.assertEqual((41, "", "0.03", "旧规则"), tuple(rate))
            self.assertEqual((9, 41, "created"), tuple(event))
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(
                    "ok", connection.execute("PRAGMA integrity_check").fetchone()[0]
                )
            self.assertEqual(1, len(list(Path(temp_dir).glob(
                "legacy.before-service-fee-schema-*.sqlite3.bak"
            ))))


if __name__ == "__main__":
    unittest.main()
