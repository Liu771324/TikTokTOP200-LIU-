import json
import tempfile
import unittest
from pathlib import Path

from cost_sync.config import AppConfig


class ConfigTests(unittest.TestCase):
    def test_test_environment_rejects_production_domain(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "config.test.local.json"
            path.write_text(
                json.dumps(
                    {
                        "environment": "test",
                        "api_base_url": "https://openapi.jushuitan.com",
                        "app_key": "key",
                        "app_secret": "secret",
                        "access_token": "token",
                        "sync_start_date": "2026-01-01",
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "test 环境只允许连接"):
                AppConfig.from_file(path)

    def test_missing_required_key_has_operator_friendly_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "config.test.local.json"
            path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "environment"):
                AppConfig.from_file(path)


if __name__ == "__main__":
    unittest.main()
