"""Dependency-free HTTP smoke check for an already running local server."""

from urllib.request import urlopen


with urlopen("http://127.0.0.1:8081", timeout=10) as response:
    html = response.read().decode("utf-8")

assert response.status == 200
assert "抖店商机中心 · 批量采集" in html
assert "读取 / 刷新类目" in html
