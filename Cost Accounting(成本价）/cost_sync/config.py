from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path


TEST_API_BASE_URL = "https://dev-api.jushuitan.com"
PRODUCTION_API_BASE_URL = "https://openapi.jushuitan.com"


@dataclass(frozen=True)
class AppConfig:
    environment: str
    api_base_url: str
    app_key: str
    app_secret: str
    access_token: str
    sync_start_date: date
    window_days: int
    output_root: Path

    @property
    def output_dir(self) -> Path:
        return self.output_root / self.environment

    @property
    def database_path(self) -> Path:
        return self.output_dir / "cost_accounting.sqlite3"

    @property
    def excel_path(self) -> Path:
        return self.output_dir / "enabled_product_costs.xlsx"

    @classmethod
    def from_file(cls, path: str | Path) -> "AppConfig":
        config_path = Path(path).resolve()
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("配置文件根节点必须是 JSON 对象")
        required = ("environment", "api_base_url", "sync_start_date")
        missing = [key for key in required if key not in raw]
        if missing:
            raise ValueError(f"配置文件缺少必填项：{', '.join(missing)}")
        output_root = Path(raw.get("output_root", "storage"))
        if not output_root.is_absolute():
            output_root = config_path.parent / output_root

        config = cls(
            environment=str(raw["environment"]).strip().lower(),
            api_base_url=str(raw["api_base_url"]).strip().rstrip("/"),
            app_key=_required_secret(raw, "app_key"),
            app_secret=_required_secret(raw, "app_secret"),
            access_token=_required_secret(raw, "access_token"),
            sync_start_date=date.fromisoformat(raw["sync_start_date"]),
            window_days=int(raw.get("window_days", 7)),
            output_root=output_root.resolve(),
        )
        config.validate()
        return config

    def validate(self) -> None:
        expected_urls = {
            "test": TEST_API_BASE_URL,
            "production": PRODUCTION_API_BASE_URL,
        }
        if self.environment not in expected_urls:
            raise ValueError("environment 必须是 test 或 production")
        if self.api_base_url != expected_urls[self.environment]:
            raise ValueError(
                f"{self.environment} 环境只允许连接 {expected_urls[self.environment]}"
            )
        if not 1 <= self.window_days <= 7:
            raise ValueError("window_days 必须在 1 到 7 之间")


def _required_secret(raw: dict, key: str) -> str:
    value = str(raw.get(key, "")).strip()
    if not value or value.startswith("请填入"):
        raise ValueError(f"配置项 {key} 尚未填写")
    return value
