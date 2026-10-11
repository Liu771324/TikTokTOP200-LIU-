import json
import unittest
from datetime import datetime
from unittest.mock import patch

from cost_sync.api import APIError, JushuitanClient
from cost_sync.signing import calculate_sign


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, headers=None) -> None:
        self.payload = payload
        self.status_code = status_code
        self.headers = headers or {}

    def json(self):
        return self.payload or {
            "code": 0,
            "msg": "执行成功",
            "data": {
                "datas": [],
                "page_index": 1,
                "page_count": 1,
                "data_count": 0,
                "has_next": False,
                "page_size": 100,
            },
        }


class FakeSession:
    def __init__(self, response=None) -> None:
        self.calls = []
        self.responses = response if isinstance(response, list) else [response or FakeResponse()]

    def post(self, url, *, data, timeout, headers):
        self.calls.append((url, data, timeout, headers))
        return self.responses.pop(0)


class ApiTests(unittest.TestCase):
    def test_query_uses_documented_biz_and_signs_exact_json(self) -> None:
        session = FakeSession()
        client = JushuitanClient(
            api_base_url="https://dev-api.jushuitan.com",
            app_key="key",
            app_secret="secret",
            access_token="token",
            session=session,
            timestamp=lambda: 1234567890,
        )
        client.query_page(
            date_field="created",
            begin=datetime(2026, 1, 1),
            end=datetime(2026, 1, 7, 23, 59, 59),
        )

        url, form, _, headers = session.calls[0]
        self.assertEqual("https://dev-api.jushuitan.com/open/sku/query", url)
        biz = json.loads(form["biz"])
        self.assertEqual("2026-01-01 00:00:00", biz["modified_begin"])
        self.assertEqual("2026-01-07 23:59:59", biz["modified_end"])
        self.assertNotIn("created_begin", biz)
        self.assertEqual("created", biz["date_field"])
        unsigned = {key: value for key, value in form.items() if key != "sign"}
        self.assertEqual(calculate_sign("secret", unsigned), form["sign"])
        self.assertIn("application/x-www-form-urlencoded", headers["Content-Type"])

    def test_rejects_contradictory_pagination_metadata(self) -> None:
        response = FakeResponse(
            {
                "code": 0,
                "data": {
                    "datas": [],
                    "page_index": 1,
                    "page_count": 2,
                    "data_count": 101,
                    "has_next": False,
                    "page_size": 100,
                },
            }
        )
        client = JushuitanClient(
            api_base_url="https://dev-api.jushuitan.com",
            app_key="key",
            app_secret="secret",
            access_token="token",
            session=FakeSession(response),
        )
        with self.assertRaisesRegex(APIError, "has_next"):
            client.query_page(
                date_field="modified",
                begin=datetime(2026, 1, 1),
                end=datetime(2026, 1, 1, 1),
            )

    def test_retries_server_error_then_succeeds(self) -> None:
        session = FakeSession([FakeResponse(status_code=500), FakeResponse()])
        client = JushuitanClient(
            api_base_url="https://dev-api.jushuitan.com",
            app_key="key",
            app_secret="secret",
            access_token="token",
            session=session,
        )
        with patch("cost_sync.api.time.sleep") as sleep:
            data = client.query_page(
                date_field="modified",
                begin=datetime(2026, 1, 1),
                end=datetime(2026, 1, 1, 1),
            )
        self.assertEqual([], data["datas"])
        self.assertEqual(2, len(session.calls))
        sleep.assert_called_once_with(1)

    def test_does_not_retry_client_error(self) -> None:
        session = FakeSession(FakeResponse(status_code=400))
        client = JushuitanClient(
            api_base_url="https://dev-api.jushuitan.com",
            app_key="key",
            app_secret="secret",
            access_token="token",
            session=session,
        )
        with self.assertRaisesRegex(APIError, "HTTP 400"):
            client.query_page(
                date_field="modified",
                begin=datetime(2026, 1, 1),
                end=datetime(2026, 1, 1, 1),
            )
        self.assertEqual(1, len(session.calls))


if __name__ == "__main__":
    unittest.main()
