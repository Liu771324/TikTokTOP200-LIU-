from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import collect as collector


def list_item() -> dict[str, object]:
    raw = {
        "clue_detail": {
            "clue_id": 71462589,
            "name": "免洗有机本草银耳",
            "category_path": ["传统滋补", "药食同源食品"],
        },
        "clue_indicator": {
            "pay_amount_ind": 7_565_525.45,
            "pay_amount_ind_range": "¥750万-¥1000万",
        },
    }
    return collector.parse_list_response({"code": 0, "data": {"list": [raw]}}, 1)["items"][0]


class FailureDiagnosticsTests(unittest.TestCase):
    def tearDown(self) -> None:
        collector.PAUSE_EVENT.clear()
        collector.STOP_EVENT.clear()

    def test_list_business_error_is_saved_as_sanitized_diagnostics(self) -> None:
        diagnostics = {
            "request_body": {
                "condition": {"categories": [{"first_cid": 1000009090, "second_cid": 1000009124}]},
                "page": {"current": 1, "page_size": 18},
            },
            "http_status": 200,
            "response_headers": {"content-type": "application/json", "x-tt-logid": "trace-123"},
            "top_level_keys": ["base_resp", "code", "data"],
            "code": 10001,
            "message": None,
            "base_resp": {"status_code": 10001, "status_message": "父类目不支持直接查询"},
            "data_shape": {"type": "dict", "keys": []},
        }
        error = collector.CollectorError("父类目不支持直接查询")
        error.diagnostics = diagnostics

        class FailingClient:
            def fetch_list(self, *_args: object) -> dict[str, object]:
                raise error

        args = argparse.Namespace(
            category_name="粮油干货/方便速食 / 干货",
            category_id=1000009090,
            second_category_id=1000009124,
            third_category_id=None,
            min_amount=2_500_000,
            page_size=18,
            page_interval=0,
            batch_size=1,
            max_pages=1,
        )
        state = collector.new_state(args)

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(collector, "controlled_wait"):
            with self.assertRaises(collector.CollectorError):
                collector.collect(args, FailingClient(), state, Path(directory) / "checkpoint.json")

        self.assertEqual(state["last_list_failure"], diagnostics)
        self.assertNotIn("cookie", str(state["last_list_failure"]).lower())

    def test_fetch_list_builds_diagnostics_without_sensitive_response_headers(self) -> None:
        response = mock.Mock()
        response.status_code = 200
        response.headers = {
            "content-type": "application/json",
            "X-Tt-Logid": "trace-123",
            "Set-Cookie": "session=secret",
        }
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "code": 10001,
            "base_resp": {"status_code": 10001, "status_message": "父类目不支持直接查询"},
            "data": {},
        }
        client = collector.ApiClient("session=secret")
        client.session.post = mock.Mock(return_value=response)

        with self.assertRaises(collector.CollectorError) as raised:
            client.fetch_list(1000009090, 1, 18, 1000009124)

        diagnostics = raised.exception.diagnostics
        self.assertEqual(diagnostics["request_body"]["condition"]["categories"], [
            {"first_cid": 1000009090, "second_cid": 1000009124}
        ])
        self.assertEqual(diagnostics["http_status"], 200)
        self.assertEqual(diagnostics["code"], 10001)
        self.assertEqual(diagnostics["data_shape"], {"type": "dict", "keys": []})
        self.assertEqual(diagnostics["response_headers"]["x-tt-logid"], "trace-123")
        self.assertNotIn("set-cookie", diagnostics["response_headers"])
        self.assertNotIn("secret", str(diagnostics))

    def test_indicator_classification_failure_retains_last_raw_response_and_types(self) -> None:
        raw_indicator = {
            "code": 0,
            "data": {
                "clue_id": 71462589,
                "pay_amount": 120_000,
                "pay_amount_range": "¥10万-¥25万",
                "pay_amount_hb": "unknown",
            },
        }

        class ExtremeGrowthClient:
            def fetch_indicator(self, clue_id: str) -> dict[str, object]:
                return collector.parse_indicator_response(raw_indicator, clue_id)

        with mock.patch.object(collector, "controlled_wait"):
            kind, record = collector.collect_one(ExtremeGrowthClient(), list_item())

        self.assertEqual(kind, "failure")
        self.assertEqual(record["raw_indicator"], raw_indicator)
        self.assertEqual(record["raw_indicator_types"]["pay_amount_hb"], "str")

    def test_actual_extreme_growth_ratios_are_classified_as_capped_growth(self) -> None:
        for hb in (1385.9357, 1225.7599):
            with self.subTest(hb=hb):
                indicator = collector.parse_indicator_response({
                    "code": 0,
                    "data": {
                        "clue_id": 71462589,
                        "pay_amount": 166_154.9,
                        "pay_amount_range": "¥10万-¥25万",
                        "pay_amount_hb": hb,
                    },
                }, "71462589")

                classified = collector.classify_indicator(indicator, list_item())

                self.assertEqual(classified["classification"], "999.99%+")
                self.assertEqual(classified["growth"], ">999.99%")
                self.assertNotEqual(classified["yesterday"], "-")

    def test_special_growth_display_is_classified_without_inventing_yesterday(self) -> None:
        indicator = collector.parse_indicator_response({
            "code": 0,
            "data": {
                "clue_id": 71462589,
                "pay_amount": 166_154.9,
                "pay_amount_range": "¥10万-¥25万",
                "pay_amount_hb": "▲999.99%+",
            },
        }, "71462589")

        classified = collector.classify_indicator(indicator, list_item())

        self.assertEqual(classified["classification"], "999.99%+")
        self.assertEqual(classified["growth"], ">999.99%")
        self.assertEqual(classified["yesterday"], "-")

    def test_extreme_decline_is_classified_without_invalid_yesterday_estimate(self) -> None:
        indicator = collector.parse_indicator_response({
            "code": 0,
            "data": {
                "clue_id": 71462589,
                "pay_amount": 1_200,
                "pay_amount_range": "¥1000-¥2500",
                "pay_amount_hb": -1.5,
                "pay_amount_hb_direction": "down",
            },
        }, "71462589")

        classified = collector.classify_indicator(indicator, list_item())

        self.assertEqual(classified["classification"], "下跌")
        self.assertEqual(classified["growth"], "极端下降")
        self.assertEqual(classified["yesterday"], "-")


if __name__ == "__main__":
    unittest.main()
