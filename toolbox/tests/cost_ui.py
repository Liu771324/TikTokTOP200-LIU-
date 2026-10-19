"""Real browser + real trusted bridge + isolated worker; no merchant/platform writes."""
from pathlib import Path
import json
import tempfile
from types import SimpleNamespace

from playwright.sync_api import sync_playwright, expect

from toolbox.host.application import Application, ROOT
from toolbox.host.bridge import Bridge
from toolbox.host.browser import find_edge
from toolbox.host.paths import DataPaths
from toolbox.host.static import StaticServer


def main():
    evidence = ROOT / 'toolbox/build/cost-integration'
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cost-ui-') as temporary:
        data = Path(temporary)
        source = data / '合成供应商.csv'
        source.write_text('商品编码,成本价\n0001,12.34\nSKU002,0\n', encoding='utf-8-sig')
        app = Application(DataPaths(data / 'data'), test_adapter=True, cost_port=0)
        static = StaticServer(ROOT / 'toolbox/web')
        app.window = SimpleNamespace(get_current_url=lambda: static.url, create_file_dialog=lambda *a, **k: [str(source)])
        bridge = Bridge(app, static.url)
        errors = []
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=str(find_edge()), headless=True)
                page = browser.new_page(viewport={'width': 1280, 'height': 820})
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.expose_function('desktopCall', bridge.invoke)
                page.goto(static.url)
                page.wait_for_load_state('networkidle')
                page.evaluate("window.pywebview={api:{invoke:(action,payload)=>window.desktopCall(action,payload)}};window.dispatchEvent(new Event('pywebviewready'))")
                page.locator('#tools [data-view="cost-assistant"]').click()
                page.locator('#cost-host #service-pill.ready').wait_for()
                assert page.locator('#cost-host .nav-item').count() == 7
                for tab in ('catalog', 'mapping', 'service-fee', 'shipping', 'history', 'logs', 'overview'):
                    page.locator(f'#cost-host [data-page="{tab}"]').click()
                    page.locator(f'#cost-host #page-{tab}').wait_for(state='visible')
                for width in (1000, 1280, 1600):
                    page.set_viewport_size({'width': width, 'height': 820})
                    page.locator('#cost-host [data-page="shipping"]').click()
                    page.wait_for_timeout(200)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'horizontal overflow at {width}'
                page.set_viewport_size({'width': 1280, 'height': 820})
                page.screenshot(path=str(evidence / 'shipping.png'), full_page=True)
                page.locator('#cost-host [data-page="catalog"]').click()
                page.locator('#cost-host #cost-choose').click()
                page.locator('#cost-host #cost-form').wait_for(state='visible')
                page.locator('#cost-host #cost-source-label').fill('合成界面验收')
                page.locator('#cost-host #cost-same-catalog').check()
                page.locator('#cost-host #cost-basis').check()
                page.locator('#work-nav [data-view="tasks"]').click()
                assert page.locator('#cost-content').is_hidden()
                page.locator('#tools [data-view="cost-assistant"]').click()
                assert page.locator('#cost-host #cost-source-label').input_value() == '合成界面验收'
                page.locator('#cost-host #cost-preview').click()
                page.locator('#cost-host #cost-apply').wait_for(state='visible')
                expect(page.locator('#cost-host #cost-apply')).to_be_enabled()
                page.locator('#cost-host #cost-apply').click()
                page.locator('#cost-host #confirm-accept').click()
                expect(page.locator('#cost-host #cost-result')).to_contain_text('成本更新完成')
                page.screenshot(path=str(evidence / 'import.png'), full_page=True)
                page.locator('#work-nav [data-view="storage"]').click()
                page.get_by_text('成本业务库与导出', exact=True).wait_for()
                assert app.cost.invoke('get_state', {})['health']['enabled_count'] == 2
                assert not errors, errors
                browser.close()
            result = {'passed': True, 'pages': 7, 'widths': [1000, 1280, 1600], 'import': '2 synthetic products',
                      'retainedDraft': True, 'storageClassification': True, 'javascriptErrors': errors}
            (evidence / 'ui-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(result, ensure_ascii=False))
        finally:
            app.shutdown()
            static.close()


if __name__ == '__main__':
    main()
