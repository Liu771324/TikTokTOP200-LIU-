import unittest

from cost_sync.signing import calculate_sign


class SigningTests(unittest.TestCase):
    def test_matches_official_authorization_example(self) -> None:
        # 公开文档中的演示参数，不是本项目凭据。
        params = {
            "app_key": "5b53060f23d84ddf9703056e84fa5a2d",
            "timestamp": "1639128407",
            "grant_type": "authorization_code",
            "charset": "utf-8",
            "code": "123456",
        }
        actual = calculate_sign("e9c5ca33fecb404b8e6cdbd0ef4a6d25", params)
        self.assertEqual("05e3a51e19e0883afd1882ccd309e0b9", actual)

    def test_ignores_sign_and_empty_values(self) -> None:
        base = {"biz": "{\"name\":\"中文商品\"}", "charset": "utf-8"}
        with_ignored = {**base, "sign": "old", "empty": "", "none": None}
        self.assertEqual(calculate_sign("secret", base), calculate_sign("secret", with_ignored))


if __name__ == "__main__":
    unittest.main()

