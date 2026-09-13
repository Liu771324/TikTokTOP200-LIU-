import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from cost_sync.cli import main


class CliTests(unittest.TestCase):
    def test_sandbox_cycle_rejects_production_config_before_network_call(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.production.local.json"
            config.write_text(
                json.dumps(
                    {
                        "environment": "production",
                        "api_base_url": "https://openapi.jushuitan.com",
                        "app_key": "key",
                        "app_secret": "secret",
                        "access_token": "token",
                        "sync_start_date": "2026-01-01",
                    }
                ),
                encoding="utf-8",
            )
            output = io.StringIO()
            with redirect_stdout(output):
                result = main(["--config", str(config), "sandbox-cycle"])

        self.assertEqual(1, result)
        self.assertIn("只允许使用 test 环境", output.getvalue())


if __name__ == "__main__":
    unittest.main()

