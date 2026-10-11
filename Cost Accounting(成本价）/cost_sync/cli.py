from __future__ import annotations

import argparse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .api import APIError, JushuitanClient
from .config import AppConfig
from .sync import SyncService
from .verification import VerificationResult, verify_outputs


REQUIRED_PRODUCT_FIELDS = {
    "sku_id",
    "name",
    "cost_price",
    "enabled",
    "autoid",
    "created",
    "modified",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="同步聚水潭普通商品成本价")
    parser.add_argument("--config", required=True, help="本机 JSON 配置文件")
    parser.add_argument(
        "command",
        choices=("probe", "full", "incremental", "verify", "sandbox-cycle"),
        help="执行模式",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = AppConfig.from_file(args.config)
        if args.command == "verify":
            _print_verification(verify_outputs(config))
            return 0

        client = JushuitanClient(
            api_base_url=config.api_base_url,
            app_key=config.app_key,
            app_secret=config.app_secret,
            access_token=config.access_token,
        )
        if args.command == "probe":
            _run_probe(client)
            return 0

        service = SyncService(config, client)
        if args.command == "sandbox-cycle":
            if config.environment != "test":
                raise ValueError("sandbox-cycle 只允许使用 test 环境配置")
            _run_probe(client)
            _print_sync_result(service.run_full(), config)
            _print_sync_result(service.run_incremental(), config)
            _print_verification(verify_outputs(config))
            return 0

        result = service.run_full() if args.command == "full" else service.run_incremental()
        _print_sync_result(result, config)
        return 0
    except (APIError, OSError, ValueError) as exc:
        print(f"执行失败：{exc}")
        return 1


def _print_sync_result(result, config: AppConfig) -> None:
        print(
            f"同步成功：mode={result.mode}，读取={result.fetched_count}，"
            f"总商品={result.total_count}，启用商品={result.enabled_count}，"
            f"完成时间={result.completed_at}"
        )
        print(f"SQLite：{config.database_path}")
        print(f"Excel：{config.excel_path}")


def _print_verification(result: VerificationResult) -> None:
    print(
        f"本地验收成功：总商品={result.total_count}，启用商品={result.enabled_count}，"
        f"last_mode={result.last_mode}，最后成功同步={result.last_successful_sync}"
    )


def _run_probe(client: JushuitanClient) -> None:
    end = datetime.now(ZoneInfo("Asia/Shanghai")).replace(microsecond=0)
    begin = end - timedelta(hours=1)
    data = client.query_page(
        date_field="modified", begin=begin, end=end, page_index=1, page_size=1
    )
    rows = data["datas"]
    if not rows:
        print("沙箱最小只读请求成功；当前一小时窗口没有商品数据。")
        return
    fields = set(rows[0])
    missing = sorted(REQUIRED_PRODUCT_FIELDS - fields)
    if missing:
        raise APIError(f"沙箱响应缺少字段：{', '.join(missing)}")
    print("沙箱最小只读请求成功；目标商品字段齐全，未输出商品内容。")


if __name__ == "__main__":
    raise SystemExit(main())
