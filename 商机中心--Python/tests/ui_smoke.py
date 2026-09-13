from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PREVIEW_DIR = ROOT / "data" / "verification-previews"


def main() -> None:
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        page.goto("http://127.0.0.1:8765", wait_until="networkidle")
        assert page.title() == "商机采集驾驶舱"
        assert page.locator("[data-step]").count() == 5
        assert page.locator(".metric").count() == 6
        page.wait_for_function("document.querySelector('#categoryId').options.length > 1", timeout=20_000)
        assert page.locator("#categoryId").input_value() == "1000002718"
        assert page.locator("#categoryId option:checked").get_attribute("data-name") == "传统滋补"
        assert page.locator("#categoryId option").count() >= 40
        assert page.locator("#secondCategoryId option").count() > 1
        assert page.locator("#secondCategoryId").input_value() == "0"
        assert page.locator("#thirdCategoryId").input_value() == "0"
        page.locator("#secondCategoryId").select_option("1000002728")
        assert page.locator("#thirdCategoryId option").count() > 1
        assert page.locator("#thirdCategoryId").is_enabled()

        status = page.request.get("http://127.0.0.1:8765/api/status")
        history = page.request.get("http://127.0.0.1:8765/api/history")
        assert status.ok and isinstance(status.json(), dict)
        assert history.ok and isinstance(history.json().get("tasks"), list)

        page.wait_for_function(
            "document.querySelector('#authLabel').textContent !== '正在检测…'",
            timeout=20_000,
        )
        page.screenshot(path=str(PREVIEW_DIR / "ui-desktop.png"), full_page=True)

        mobile = browser.new_page(viewport={"width": 390, "height": 844})
        mobile.goto("http://127.0.0.1:8765", wait_until="networkidle")
        assert mobile.locator("#taskForm").is_visible()
        assert mobile.locator(".route-track").is_visible()
        mobile.screenshot(path=str(PREVIEW_DIR / "ui-mobile.png"), full_page=True)

        mobile.close()
        browser.close()

    assert not page_errors, f"page errors: {page_errors}"
    assert not console_errors, f"console errors: {console_errors}"
    print("UI smoke test passed: API, layout, Edge auth state, desktop/mobile rendering")


if __name__ == "__main__":
    main()
