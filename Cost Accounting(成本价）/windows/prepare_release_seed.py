"""Create empty initialization files without reading any business data."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cost_sync.database import connect_database
from cost_sync.excel import export_enabled_products, validate_excel


def main() -> None:
    target = Path(sys.argv[1]).resolve()
    target.mkdir(parents=True, exist_ok=True)
    database = target / "cost_accounting.sqlite3"
    excel = target / "enabled_product_costs.xlsx"
    if database.exists() or excel.exists():
        raise FileExistsError("Refusing to overwrite existing seed files")
    with connect_database(database) as connection:
        connection.commit()
        if export_enabled_products(connection, excel) != 0:
            raise ValueError("Release seed must contain no products")
    validate_excel(excel, expected_rows=0, expected_database_path=database)


if __name__ == "__main__":
    main()
