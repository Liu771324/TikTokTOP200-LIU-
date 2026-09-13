import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from cost_sync.config import AppConfig, TEST_API_BASE_URL
from cost_sync.models import Product
from cost_sync.sync import SyncService
from cost_sync.verification import verify_outputs


class MockClient:
    def iter_product_pages(self, **kwargs):
        yield [Product("001", 1, "商品", "3.5", 1, None, None)]


class VerificationTests(unittest.TestCase):
    def test_verifies_database_state_and_excel_together(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = AppConfig(
                environment="test",
                api_base_url=TEST_API_BASE_URL,
                app_key="key",
                app_secret="secret",
                access_token="token",
                sync_start_date=date(2026, 1, 1),
                window_days=7,
                output_root=Path(temp_dir),
            )
            now = datetime(2026, 1, 1, 1, tzinfo=ZoneInfo("Asia/Shanghai"))
            SyncService(config, MockClient(), now=lambda: now).run_full()

            result = verify_outputs(config)
            self.assertEqual(1, result.total_count)
            self.assertEqual(1, result.enabled_count)
            self.assertEqual("full", result.last_mode)


if __name__ == "__main__":
    unittest.main()
