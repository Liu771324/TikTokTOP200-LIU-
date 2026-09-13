from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterable
from contextlib import closing
from datetime import datetime
from pathlib import Path

from .models import Product


_DATABASE_INITIALIZATION_LOCK = threading.Lock()
_INITIALIZED_DATABASE_IDENTITIES: dict[Path, tuple[int, int]] = {}


SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    sku_id TEXT PRIMARY KEY,
    autoid INTEGER UNIQUE,
    name TEXT NOT NULL,
    cost_price TEXT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (-1, 0, 1)),
    created TEXT NULL,
    modified TEXT NULL,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_enabled ON products(enabled);
CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mapping_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    total_rows INTEGER NOT NULL,
    verified_rows INTEGER NOT NULL,
    pending_rows INTEGER NOT NULL,
    inserted_rows INTEGER NOT NULL,
    existing_rows INTEGER NOT NULL,
    updated_rows INTEGER NOT NULL DEFAULT 0,
    removed_rows INTEGER NOT NULL DEFAULT 0,
    legacy_rows INTEGER NOT NULL DEFAULT 0,
    shop_name TEXT NOT NULL DEFAULT '历史导入',
    import_mode TEXT NOT NULL DEFAULT 'append',
    status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
    imported_at TEXT NOT NULL,
    rolled_back_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_mapping_batches_source
    ON mapping_import_batches(source_sha256, status);
CREATE TABLE IF NOT EXISTS douyin_sku_mappings (
    douyin_sku_id TEXT PRIMARY KEY,
    douyin_product_id TEXT NOT NULL,
    merchant_sku_code TEXT NOT NULL,
    jushuitan_sku_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    specification TEXT NOT NULL,
    weight_kg TEXT NULL,
    weight_source TEXT NOT NULL DEFAULT '',
    weight_unconfigured_reason TEXT NOT NULL DEFAULT '',
    major_category TEXT NOT NULL DEFAULT '',
    major_category_unconfigured_reason TEXT NOT NULL DEFAULT '',
    category_level_1 TEXT NOT NULL DEFAULT '',
    category_level_2 TEXT NOT NULL DEFAULT '',
    category_level_3 TEXT NOT NULL DEFAULT '',
    category_level_4 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status = 'verified'),
    import_batch_id INTEGER NOT NULL REFERENCES mapping_import_batches(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    shop_name TEXT NOT NULL DEFAULT '历史导入'
);
CREATE INDEX IF NOT EXISTS idx_douyin_mappings_jushuitan
    ON douyin_sku_mappings(jushuitan_sku_id);
CREATE TABLE IF NOT EXISTS system_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    update_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('catalog', 'mapping', 'shipping', 'service_fee')),
    reference_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
    completed_at TEXT NOT NULL,
    backup_file TEXT NOT NULL,
    backup_sha256 TEXT NOT NULL,
    rolled_back_at TEXT NULL,
    recovery_backup_file TEXT NULL,
    recovery_backup_sha256 TEXT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS mapping_review_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_name TEXT NOT NULL,
    douyin_sku_id TEXT NOT NULL,
    douyin_product_id TEXT NOT NULL,
    merchant_sku_code TEXT NOT NULL,
    product_name TEXT NOT NULL,
    specification TEXT NOT NULL,
    weight_kg TEXT NULL,
    weight_source TEXT NOT NULL DEFAULT '',
    weight_unconfigured_reason TEXT NOT NULL DEFAULT '',
    major_category TEXT NOT NULL DEFAULT '',
    major_category_unconfigured_reason TEXT NOT NULL DEFAULT '',
    category_level_1 TEXT NOT NULL DEFAULT '',
    category_level_2 TEXT NOT NULL DEFAULT '',
    category_level_3 TEXT NOT NULL DEFAULT '',
    category_level_4 TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL CHECK (reason IN ('pending', 'conflict')),
    source_file TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_row INTEGER NOT NULL,
    current_shop_name TEXT NULL,
    current_jushuitan_sku_id TEXT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    captured_at TEXT NOT NULL,
    resolved_at TEXT NULL,
    resolved_jushuitan_sku_id TEXT NULL,
    import_batch_id INTEGER NOT NULL REFERENCES mapping_import_batches(id),
    resolution_batch_id INTEGER NULL REFERENCES mapping_import_batches(id),
    UNIQUE (shop_name, douyin_sku_id)
);
CREATE INDEX IF NOT EXISTS idx_mapping_review_status
    ON mapping_review_candidates(status, shop_name, id);
CREATE TABLE IF NOT EXISTS service_fee_catalog_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_article_id TEXT NOT NULL,
    source_updated_at TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    source_checksum TEXT NOT NULL,
    rule_count INTEGER NOT NULL,
    UNIQUE (source_article_id, source_updated_at, source_checksum)
);
CREATE TABLE IF NOT EXISTS basic_service_fee_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    major_category TEXT NOT NULL DEFAULT '',
    category_level_1 TEXT NOT NULL,
    category_level_2 TEXT NOT NULL,
    category_level_3 TEXT NOT NULL,
    category_level_4 TEXT NOT NULL,
    rate TEXT NOT NULL,
    special_channel_rate TEXT NULL,
    effective_from TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    note TEXT NOT NULL DEFAULT '',
    source_article_id TEXT NOT NULL DEFAULT '',
    source_updated_at TEXT NULL,
    imported_at TEXT NULL,
    source_checksum TEXT NOT NULL DEFAULT '',
    catalog_import_id INTEGER NULL REFERENCES service_fee_catalog_imports(id),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    archived_at TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (
        major_category, category_level_1, category_level_2, category_level_3,
        category_level_4, effective_from
    )
);
CREATE INDEX IF NOT EXISTS idx_basic_service_fee_lookup
    ON basic_service_fee_rates (
        major_category, category_level_1, category_level_2, category_level_3,
        category_level_4, effective_from DESC
    );
CREATE TABLE IF NOT EXISTS basic_service_fee_rate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rate_id INTEGER NOT NULL REFERENCES basic_service_fee_rates(id),
    action TEXT NOT NULL CHECK (action IN ('created', 'enabled', 'disabled')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_basic_service_fee_events_rate
    ON basic_service_fee_rate_events(rate_id, id);
CREATE TABLE IF NOT EXISTS shipping_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    shop_name TEXT NOT NULL,
    first_weight TEXT NOT NULL,
    first_fee TEXT NOT NULL,
    additional_weight TEXT NOT NULL,
    additional_fee TEXT NOT NULL,
    default_region TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (shop_name, name)
);
CREATE INDEX IF NOT EXISTS idx_shipping_templates_shop
    ON shipping_templates(shop_name, enabled, id);
CREATE TABLE IF NOT EXISTS shipping_region_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES shipping_templates(id) ON DELETE CASCADE,
    region TEXT NOT NULL,
    first_fee TEXT NOT NULL,
    additional_fee TEXT NOT NULL,
    free_shipping INTEGER NOT NULL DEFAULT 0 CHECK (free_shipping IN (0, 1)),
    UNIQUE (template_id, region)
);
CREATE TABLE IF NOT EXISTS shipping_product_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_name TEXT NOT NULL,
    douyin_product_id TEXT NOT NULL,
    template_id INTEGER NOT NULL REFERENCES shipping_templates(id),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (shop_name, douyin_product_id)
);
CREATE INDEX IF NOT EXISTS idx_shipping_product_bindings_template
    ON shipping_product_bindings(template_id, enabled);
CREATE INDEX IF NOT EXISTS idx_shipping_region_lookup
    ON shipping_region_rules(template_id, region);
"""


class ClosingConnection(sqlite3.Connection):
    """事务上下文结束后同时释放 Windows 文件句柄。"""

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def connect_database(path: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, factory=ClosingConnection)
    connection.row_factory = sqlite3.Row
    database = Path(path).resolve()
    try:
        with _DATABASE_INITIALIZATION_LOCK:
            identity = _database_file_identity(database)
            if _INITIALIZED_DATABASE_IDENTITIES.get(database) != identity:
                _migrate_legacy_service_fee_unique_index(connection)
                connection.executescript(SCHEMA)
                _ensure_mapping_shop_columns(connection)
                _ensure_system_update_columns(connection)
                _ensure_system_update_kind(connection)
                _ensure_service_fee_columns(connection)
                _ensure_shipping_template_columns(connection)
                initialized_identity = _database_file_identity(database)
                if initialized_identity is not None:
                    _INITIALIZED_DATABASE_IDENTITIES[database] = initialized_identity
    except Exception:
        connection.close()
        raise
    return connection


def _database_file_identity(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_dev, stat.st_ino


_SERVICE_FEE_UNIQUE_COLUMNS = (
    "major_category",
    "category_level_1",
    "category_level_2",
    "category_level_3",
    "category_level_4",
    "effective_from",
)

_SERVICE_FEE_COLUMNS = (
    "id",
    "major_category",
    "category_level_1",
    "category_level_2",
    "category_level_3",
    "category_level_4",
    "rate",
    "special_channel_rate",
    "effective_from",
    "enabled",
    "note",
    "source_article_id",
    "source_updated_at",
    "imported_at",
    "source_checksum",
    "catalog_import_id",
    "archived",
    "archived_at",
    "created_at",
    "updated_at",
)

_SERVICE_FEE_COLUMN_DEFAULTS = {
    "major_category": "''",
    "special_channel_rate": "NULL",
    "source_article_id": "''",
    "source_updated_at": "NULL",
    "imported_at": "NULL",
    "source_checksum": "''",
    "catalog_import_id": "NULL",
    "archived": "0",
    "archived_at": "NULL",
}


def _migrate_legacy_service_fee_unique_index(
    connection: sqlite3.Connection,
) -> None:
    table_exists = connection.execute(
        "SELECT 1 FROM sqlite_master "
        "WHERE type = 'table' AND name = 'basic_service_fee_rates'"
    ).fetchone()
    if table_exists is None:
        return

    existing_columns = {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(basic_service_fee_rates)")
    }
    unique_indexes = [
        row
        for row in connection.execute("PRAGMA index_list(basic_service_fee_rates)")
        if int(row[2]) == 1
    ]
    unique_columns = {
        tuple(
            str(column[0])
            for column in connection.execute(
                "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
                (str(row[1]),),
            )
        )
        for row in unique_indexes
    }
    if unique_columns == {_SERVICE_FEE_UNIQUE_COLUMNS}:
        return

    required_columns = set(_SERVICE_FEE_COLUMNS) - set(_SERVICE_FEE_COLUMN_DEFAULTS)
    missing_required = sorted(required_columns - existing_columns)
    if missing_required:
        raise ValueError(
            "费率库需要先完成兼容迁移：旧表缺少字段 "
            + "、".join(missing_required)
        )

    try:
        _backup_service_fee_schema(connection)
    except Exception as exc:
        raise ValueError("费率库需要先完成兼容迁移：创建备份失败") from exc
    select_columns = ", ".join(
        column
        if column in existing_columns
        else f"{_SERVICE_FEE_COLUMN_DEFAULTS[column]} AS {column}"
        for column in _SERVICE_FEE_COLUMNS
    )
    columns = ", ".join(_SERVICE_FEE_COLUMNS)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DROP TABLE IF EXISTS basic_service_fee_rates_migrating")
        connection.execute(
            """
            CREATE TABLE basic_service_fee_rates_migrating (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                major_category TEXT NOT NULL DEFAULT '',
                category_level_1 TEXT NOT NULL,
                category_level_2 TEXT NOT NULL,
                category_level_3 TEXT NOT NULL,
                category_level_4 TEXT NOT NULL,
                rate TEXT NOT NULL,
                special_channel_rate TEXT NULL,
                effective_from TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                note TEXT NOT NULL DEFAULT '',
                source_article_id TEXT NOT NULL DEFAULT '',
                source_updated_at TEXT NULL,
                imported_at TEXT NULL,
                source_checksum TEXT NOT NULL DEFAULT '',
                catalog_import_id INTEGER NULL REFERENCES service_fee_catalog_imports(id),
                archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
                archived_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (
                    major_category, category_level_1, category_level_2,
                    category_level_3, category_level_4, effective_from
                )
            )
            """
        )
        connection.execute(
            f"INSERT INTO basic_service_fee_rates_migrating ({columns}) "
            f"SELECT {select_columns} FROM basic_service_fee_rates ORDER BY id"
        )
        connection.execute("DROP TABLE basic_service_fee_rates")
        connection.execute(
            "ALTER TABLE basic_service_fee_rates_migrating "
            "RENAME TO basic_service_fee_rates"
        )
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity is None or str(integrity[0]).lower() != "ok":
            raise sqlite3.DatabaseError("SQLite integrity_check 未通过")
        connection.commit()
    except Exception as exc:
        connection.rollback()
        raise ValueError("费率库需要先完成兼容迁移") from exc


def _backup_service_fee_schema(connection: sqlite3.Connection) -> Path:
    row = connection.execute("PRAGMA database_list").fetchone()
    database = Path(str(row[2])).resolve() if row is not None and row[2] else None
    if database is None or not database.is_file():
        raise ValueError("费率库需要先完成兼容迁移：无法确定数据库路径")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    base = f"{database.stem}.before-service-fee-schema-{stamp}"
    backup = database.with_name(f"{base}{database.suffix}.bak")
    sequence = 2
    while backup.exists():
        backup = database.with_name(f"{base}-{sequence}{database.suffix}.bak")
        sequence += 1
    try:
        with closing(sqlite3.connect(backup)) as target:
            connection.backup(target)
            integrity = target.execute("PRAGMA integrity_check").fetchone()
            if integrity is None or str(integrity[0]).lower() != "ok":
                raise sqlite3.DatabaseError("SQLite integrity_check 未通过")
    except Exception:
        backup.unlink(missing_ok=True)
        raise
    return backup


def _ensure_mapping_shop_columns(connection: sqlite3.Connection) -> None:
    migrations = {
        "mapping_import_batches": {
            "updated_rows": "INTEGER NOT NULL DEFAULT 0",
            "removed_rows": "INTEGER NOT NULL DEFAULT 0",
            "legacy_rows": "INTEGER NOT NULL DEFAULT 0",
            "shop_name": "TEXT NOT NULL DEFAULT '历史导入'",
            "import_mode": "TEXT NOT NULL DEFAULT 'append'",
        },
        "douyin_sku_mappings": {
            "shop_name": "TEXT NOT NULL DEFAULT '历史导入'",
            "weight_kg": "TEXT NULL",
            "weight_source": "TEXT NOT NULL DEFAULT ''",
            "weight_unconfigured_reason": "TEXT NOT NULL DEFAULT ''",
            "category_level_1": "TEXT NOT NULL DEFAULT ''",
            "category_level_2": "TEXT NOT NULL DEFAULT ''",
            "category_level_3": "TEXT NOT NULL DEFAULT ''",
            "category_level_4": "TEXT NOT NULL DEFAULT ''",
            "major_category": "TEXT NOT NULL DEFAULT ''",
            "major_category_unconfigured_reason": "TEXT NOT NULL DEFAULT ''",
        },
        "mapping_review_candidates": {
            "weight_kg": "TEXT NULL",
            "weight_source": "TEXT NOT NULL DEFAULT ''",
            "weight_unconfigured_reason": "TEXT NOT NULL DEFAULT ''",
            "category_level_1": "TEXT NOT NULL DEFAULT ''",
            "category_level_2": "TEXT NOT NULL DEFAULT ''",
            "category_level_3": "TEXT NOT NULL DEFAULT ''",
            "category_level_4": "TEXT NOT NULL DEFAULT ''",
            "major_category": "TEXT NOT NULL DEFAULT ''",
            "major_category_unconfigured_reason": "TEXT NOT NULL DEFAULT ''",
        },
    }
    for table, columns in migrations.items():
        existing = {
            str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")
        }
        for column, definition in columns.items():
            if column not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_mapping_batches_shop "
        "ON mapping_import_batches(shop_name, status, imported_at)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_douyin_mappings_shop "
        "ON douyin_sku_mappings(shop_name, douyin_sku_id)"
    )


def _ensure_system_update_columns(connection: sqlite3.Connection) -> None:
    existing = {
        str(row[1]) for row in connection.execute("PRAGMA table_info(system_updates)")
    }
    migrations = {
        "rolled_back_at": "TEXT NULL",
        "recovery_backup_file": "TEXT NULL",
        "recovery_backup_sha256": "TEXT NULL",
        "details_json": "TEXT NOT NULL DEFAULT '{}'",
    }
    for column, definition in migrations.items():
        if column not in existing:
            connection.execute(
                f"ALTER TABLE system_updates ADD COLUMN {column} {definition}"
            )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_system_updates_status "
        "ON system_updates(status, id)"
    )


def _ensure_system_update_kind(connection: sqlite3.Connection) -> None:
    row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'system_updates'"
    ).fetchone()
    if row is not None and "'service_fee'" in str(row[0]):
        return
    connection.execute("ALTER TABLE system_updates RENAME TO system_updates_legacy")
    connection.execute(
        """
        CREATE TABLE system_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            update_key TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK (kind IN ('catalog', 'mapping', 'shipping', 'service_fee')),
            reference_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
            completed_at TEXT NOT NULL,
            backup_file TEXT NOT NULL,
            backup_sha256 TEXT NOT NULL,
            rolled_back_at TEXT NULL,
            recovery_backup_file TEXT NULL,
            recovery_backup_sha256 TEXT NULL,
            details_json TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    connection.execute(
        """
        INSERT INTO system_updates (
            id, update_key, kind, reference_id, status, completed_at,
            backup_file, backup_sha256, rolled_back_at, recovery_backup_file,
            recovery_backup_sha256, details_json
        )
        SELECT id, update_key, kind, reference_id, status, completed_at,
               backup_file, backup_sha256, rolled_back_at, recovery_backup_file,
               recovery_backup_sha256, details_json
        FROM system_updates_legacy
        """
    )
    connection.execute("DROP TABLE system_updates_legacy")
    connection.execute(
        "CREATE INDEX idx_system_updates_status ON system_updates(status, id)"
    )


def _ensure_service_fee_columns(connection: sqlite3.Connection) -> None:
    existing = {
        str(row[1])
        for row in connection.execute("PRAGMA table_info(basic_service_fee_rates)")
    }
    migrations = {
        "major_category": "TEXT NOT NULL DEFAULT ''",
        "special_channel_rate": "TEXT NULL",
        "source_article_id": "TEXT NOT NULL DEFAULT ''",
        "source_updated_at": "TEXT NULL",
        "imported_at": "TEXT NULL",
        "source_checksum": "TEXT NOT NULL DEFAULT ''",
        "catalog_import_id": "INTEGER NULL REFERENCES service_fee_catalog_imports(id)",
        "archived": "INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))",
        "archived_at": "TEXT NULL",
    }
    for column, definition in migrations.items():
        if column not in existing:
            connection.execute(
                f"ALTER TABLE basic_service_fee_rates ADD COLUMN {column} {definition}"
            )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_basic_service_fee_major_lookup "
        "ON basic_service_fee_rates(major_category, category_level_1, effective_from DESC)"
    )


def _ensure_shipping_template_columns(connection: sqlite3.Connection) -> None:
    existing = {
        str(row[1]) for row in connection.execute("PRAGMA table_info(shipping_templates)")
    }
    if "is_default" not in existing:
        connection.execute(
            "ALTER TABLE shipping_templates "
            "ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))"
        )
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_shipping_default_shop "
        "ON shipping_templates(shop_name) WHERE is_default = 1"
    )


def upsert_products(
    connection: sqlite3.Connection, products: Iterable[Product], *, synced_at: str
) -> None:
    for product in products:
        if product.autoid is not None:
            connection.execute(
                "DELETE FROM products WHERE autoid = ? AND sku_id <> ?",
                (product.autoid, product.sku_id),
            )
        connection.execute(
            """
            INSERT INTO products (
                sku_id, autoid, name, cost_price, enabled, created, modified, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sku_id) DO UPDATE SET
                autoid = excluded.autoid,
                name = excluded.name,
                cost_price = excluded.cost_price,
                enabled = excluded.enabled,
                created = excluded.created,
                modified = excluded.modified,
                synced_at = excluded.synced_at
            """,
            (
                product.sku_id,
                product.autoid,
                product.name,
                product.cost_price,
                product.enabled,
                product.created,
                product.modified,
                synced_at,
            ),
        )


def set_sync_state(connection: sqlite3.Connection, values: dict[str, str]) -> None:
    connection.executemany(
        """
        INSERT INTO sync_state(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        values.items(),
    )


def get_sync_state(connection: sqlite3.Connection, key: str) -> str | None:
    row = connection.execute(
        "SELECT value FROM sync_state WHERE key = ?", (key,)
    ).fetchone()
    return None if row is None else str(row["value"])


def count_products(connection: sqlite3.Connection, *, enabled_only: bool = False) -> int:
    sql = "SELECT COUNT(*) FROM products"
    if enabled_only:
        sql += " WHERE enabled = 1"
    return int(connection.execute(sql).fetchone()[0])


def copy_mapping_state(
    source_path: str | Path, target: sqlite3.Connection
) -> None:
    source = Path(source_path).resolve()
    uri = f"{source.as_uri()}?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as previous:
        batch_columns = (
            "id, source_file, source_sha256, total_rows, verified_rows, pending_rows, "
            "inserted_rows, existing_rows, updated_rows, removed_rows, legacy_rows, "
            "shop_name, import_mode, status, imported_at, rolled_back_at"
        )
        target.executemany(
            f"INSERT INTO mapping_import_batches ({batch_columns}) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            previous.execute(
                f"SELECT {batch_columns} FROM mapping_import_batches ORDER BY id"
            ),
        )
        update_columns = (
            "id, update_key, kind, reference_id, status, completed_at, backup_file, "
            "backup_sha256, rolled_back_at, recovery_backup_file, recovery_backup_sha256, "
            "details_json"
        )
        has_update_table = previous.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_updates'"
        ).fetchone()
        if has_update_table is not None:
            source_update_columns = {
                str(row[1])
                for row in previous.execute("PRAGMA table_info(system_updates)")
            }
            optional_sources = {
                "rolled_back_at": "NULL",
                "recovery_backup_file": "NULL",
                "recovery_backup_sha256": "NULL",
                "details_json": "'{}'",
            }
            source_select = ", ".join(
                column
                if column in source_update_columns
                else f"{optional_sources[column]} AS {column}"
                for column in update_columns.split(", ")
            )
            target.executemany(
                f"INSERT INTO system_updates ({update_columns}) VALUES "
                "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                previous.execute(
                    f"SELECT {source_select} FROM system_updates ORDER BY id"
                ),
            )
        mapping_columns = (
            "douyin_sku_id, douyin_product_id, merchant_sku_code, jushuitan_sku_id, "
            "product_name, specification, weight_kg, weight_source, "
            "weight_unconfigured_reason, major_category, major_category_unconfigured_reason, "
            "category_level_1, category_level_2, "
            "category_level_3, category_level_4, status, import_batch_id, created_at, "
            "updated_at, shop_name"
        )
        source_mapping_columns = {
            str(row[1]) for row in previous.execute("PRAGMA table_info(douyin_sku_mappings)")
        }
        mapping_select = ", ".join(
            column
            if column in source_mapping_columns
            else (f"NULL AS {column}" if column == "weight_kg" else f"'' AS {column}")
            for column in mapping_columns.split(", ")
        )
        target.executemany(
            f"INSERT INTO douyin_sku_mappings ({mapping_columns}) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            previous.execute(
                f"SELECT {mapping_select} FROM douyin_sku_mappings ORDER BY douyin_sku_id"
            ),
        )
        has_review_table = previous.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'table' AND name = 'mapping_review_candidates'"
        ).fetchone()
        if has_review_table is not None:
            review_columns = (
                "id, shop_name, douyin_sku_id, douyin_product_id, merchant_sku_code, "
                "product_name, specification, weight_kg, weight_source, "
                "weight_unconfigured_reason, major_category, major_category_unconfigured_reason, "
                "category_level_1, category_level_2, "
                "category_level_3, category_level_4, reason, source_file, source_sha256, "
                "source_row, current_shop_name, current_jushuitan_sku_id, status, captured_at, "
                "resolved_at, resolved_jushuitan_sku_id, import_batch_id, resolution_batch_id"
            )
            source_review_columns = {
                str(row[1])
                for row in previous.execute("PRAGMA table_info(mapping_review_candidates)")
            }
            review_select = ", ".join(
                column
                if column in source_review_columns
                else (f"NULL AS {column}" if column == "weight_kg" else f"'' AS {column}")
                for column in review_columns.split(", ")
            )
            target.executemany(
                f"INSERT INTO mapping_review_candidates ({review_columns}) VALUES "
                "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                previous.execute(
                    f"SELECT {review_select} FROM mapping_review_candidates ORDER BY id"
                ),
            )
        has_fee_table = previous.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'table' AND name = 'basic_service_fee_rates'"
        ).fetchone()
        if has_fee_table is not None:
            has_catalog_imports = previous.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' "
                "AND name = 'service_fee_catalog_imports'"
            ).fetchone()
            if has_catalog_imports is not None:
                catalog_columns = (
                    "id, source_article_id, source_updated_at, imported_at, "
                    "source_checksum, rule_count"
                )
                target.executemany(
                    f"INSERT INTO service_fee_catalog_imports ({catalog_columns}) VALUES "
                    "(?, ?, ?, ?, ?, ?)",
                    previous.execute(
                        f"SELECT {catalog_columns} FROM service_fee_catalog_imports ORDER BY id"
                    ),
                )
            fee_columns = (
                "id, major_category, category_level_1, category_level_2, category_level_3, "
                "category_level_4, rate, effective_from, enabled, note, "
                "special_channel_rate, source_article_id, source_updated_at, imported_at, "
                "source_checksum, catalog_import_id, archived, archived_at, created_at, updated_at"
            )
            source_fee_columns = {
                str(row[1])
                for row in previous.execute("PRAGMA table_info(basic_service_fee_rates)")
            }
            fee_defaults = {
                "major_category": "''",
                "special_channel_rate": "NULL",
                "source_article_id": "''",
                "source_updated_at": "NULL",
                "imported_at": "NULL",
                "source_checksum": "''",
                "catalog_import_id": "NULL",
                "archived": "0",
                "archived_at": "NULL",
            }
            fee_select = ", ".join(
                column if column in source_fee_columns
                else f"{fee_defaults[column]} AS {column}"
                for column in fee_columns.split(", ")
            )
            target.executemany(
                f"INSERT INTO basic_service_fee_rates ({fee_columns}) VALUES "
                "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                previous.execute(
                    f"SELECT {fee_select} FROM basic_service_fee_rates ORDER BY id"
                ),
            )
            has_fee_events = previous.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'basic_service_fee_rate_events'"
            ).fetchone()
            if has_fee_events is not None:
                event_columns = "id, rate_id, action, enabled, changed_at"
                target.executemany(
                    f"INSERT INTO basic_service_fee_rate_events ({event_columns}) VALUES "
                    "(?, ?, ?, ?, ?)",
                    previous.execute(
                        f"SELECT {event_columns} FROM basic_service_fee_rate_events ORDER BY id"
                    ),
                )
        has_shipping_templates = previous.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'table' AND name = 'shipping_templates'"
        ).fetchone()
        if has_shipping_templates is not None:
            shipping_template_columns = {
                str(row[1])
                for row in previous.execute("PRAGMA table_info(shipping_templates)")
            }
            template_columns = (
                "id, name, shop_name, first_weight, first_fee, additional_weight, "
                "additional_fee, default_region, enabled, is_default, created_at, updated_at"
            )
            template_select_columns = (
                template_columns
                if "is_default" in shipping_template_columns
                else (
                    "id, name, shop_name, first_weight, first_fee, additional_weight, "
                    "additional_fee, default_region, enabled, 0 AS is_default, "
                    "created_at, updated_at"
                )
            )
            target.executemany(
                f"INSERT INTO shipping_templates ({template_columns}) VALUES "
                "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                previous.execute(
                    f"SELECT {template_select_columns} FROM shipping_templates ORDER BY id"
                ),
            )
            has_shipping_rules = previous.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'shipping_region_rules'"
            ).fetchone()
            if has_shipping_rules is not None:
                rule_columns = (
                    "id, template_id, region, first_fee, additional_fee, free_shipping"
                )
                target.executemany(
                    f"INSERT INTO shipping_region_rules ({rule_columns}) VALUES "
                    "(?, ?, ?, ?, ?, ?)",
                    previous.execute(
                        f"SELECT {rule_columns} FROM shipping_region_rules ORDER BY id"
                    ),
                )
            has_product_bindings = previous.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' "
                "AND name = 'shipping_product_bindings'"
            ).fetchone()
            if has_product_bindings is not None:
                binding_columns = (
                    "id, shop_name, douyin_product_id, template_id, enabled, "
                    "created_at, updated_at"
                )
                target.executemany(
                    f"INSERT INTO shipping_product_bindings ({binding_columns}) VALUES "
                    "(?, ?, ?, ?, ?, ?, ?)",
                    previous.execute(
                        f"SELECT {binding_columns} FROM shipping_product_bindings ORDER BY id"
                    ),
                )
