import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from cost_sync.xlsx_safety import validate_xlsx_container


class XlsxSafetyTests(unittest.TestCase):
    def test_small_archive_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "small.xlsx"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("xl/worksheets/sheet1.xml", b"small")

            validate_xlsx_container(path, "测试表")

    def test_expanded_archive_over_limit_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "expanded.xlsx"
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("xl/worksheets/sheet1.xml", b"12345")

            with patch("cost_sync.xlsx_safety.MAX_XLSX_EXPANDED_BYTES", 4):
                with self.assertRaisesRegex(ValueError, "解压后大小"):
                    validate_xlsx_container(path, "测试表")

    def test_archive_with_too_many_entries_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "entries.xlsx"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("one", b"1")
                archive.writestr("two", b"2")

            with patch("cost_sync.xlsx_safety.MAX_XLSX_ENTRIES", 1):
                with self.assertRaisesRegex(ValueError, "内部文件数量"):
                    validate_xlsx_container(path, "测试表")


if __name__ == "__main__":
    unittest.main()
