from pathlib import Path
from urllib.request import urlopen
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT = ROOT / ".artifact-build" / "upload-console.png"

with urlopen("http://127.0.0.1:4173/api/status") as response:
    status = json.load(response)

expected_terms = status["upload"]["terms"]
expected_counts = status["latestJob"]["counts"]

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1050}, device_scale_factor=1)
    errors = []
    page.on("console", lambda message: errors.append(f"console: {message.text}") if message.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.goto("http://127.0.0.1:4173", wait_until="networkidle")
    page.get_by_role("heading", name="上传选品表格").wait_for()
    page.get_by_text("Edge 已连接", exact=True).wait_for()
    page.get_by_text(expected_terms[0], exact=True).wait_for()
    page.get_by_role("heading", name="采集完成").wait_for()
    assert page.locator("#startButton").is_enabled()
    assert page.locator("#termChips .term-chip").count() == len(expected_terms)
    assert page.locator("#resultList .result-row").count() >= 1
    assert page.locator("#businessCount").inner_text() == str(expected_counts["business"])
    assert page.locator("#compassCount").inner_text() == str(expected_counts["compass"])
    assert page.locator("#unprocessedCount").inner_text() == str(expected_counts["unprocessed"])
    assert "任务失败" not in page.locator("#logBox").inner_text()
    assert page.locator("#downloadButton").is_visible()
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(250)
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(ROOT / ".artifact-build" / "upload-console-mobile.png"), full_page=True)
    if errors:
        raise AssertionError("\n".join(errors))
    print(f"UI smoke passed: {SCREENSHOT}")
    browser.close()
