import tempfile
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class WebviewRectificationTests(unittest.TestCase):
    def test_cost_wizard_controls_preview_invalidation_and_saved_refresh_warning(self):
        errors = []
        with tempfile.TemporaryDirectory() as output, sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True)
            try:
                page = browser.new_page(viewport={"width": 1180, "height": 800})
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto((ROOT / "cost_sync/webview_static/index.html").as_uri())
                page.wait_for_load_state("networkidle")
                page.evaluate("""() => {
                  window.__desktopAutoStart = false;
                  window.__testCalls = [];
                  window.__testSaved = false;
                  window.pywebview = {api: {async invoke(action, payload) {
                    window.__testCalls.push({action, payload});
                    let result;
                    if (action === 'get_state') {
                      if (window.__testSaved) return {ok: false, error: 'synthetic refresh failure'};
                      result = {expected:true, health_present:true, owns_service:true, port:0, database_path:'synthetic',
                        health:{status:'ok',ready:true,environment:'test',enabled_count:0,verified_mapping_count:0,mapping_shops:[]}};
                    } else if (action === 'choose_file') result = {path:'synthetic.csv',name:'synthetic.csv'};
                    else if (action === 'inspect_cost_source') result = {
                      sheets:['文本表格'],sheet:'文本表格',header_row:1,headers:['商品编码','成本价'],
                      proposed_mapping:{sku:0,cost:1,name:null,status:null},profiles:[],scope:'合成目录',
                      sample:[{row:1,values:['商品编码','成本价']},{row:2,values:['0001','0.80']}]};
                    else if (action === 'preview_cost_import') result = {
                      preview_id:'synthetic-token',ready_to_import:true,total_rows:1,added:1,changed:0,removed:0,
                      result_count:1,empty_cost:0,affected_mappings:0,removed_sample:[],errors:[],
                      manifest:{source_label:'合成来源',file_name:'synthetic.csv',sheet:'文本表格',header_row:1,mode:payload.mode}};
                    else if (action === 'apply_cost_import') {window.__testSaved = true; result = {total_count:1,backup_file:'synthetic.bak'};}
                    else if (action === 'get_shipping_templates') result = [];
                    else if (action === 'get_shipping_bindings') result = {products:[],shops:[],page:1,page_count:1,filtered_count:0,unbound_count:0,unavailable_count:0};
                    else if (action === 'trial_shipping_fee') result = {fee:'4',additional_steps:1,rule_type:'base'};
                    else throw new Error('unexpected action '+action);
                    return {ok:true,result};
                  }}};
                  window.dispatchEvent(new Event('desktop-bridge-ready'));
                }""")
                page.locator('[data-page="catalog"]').click()
                page.locator('#cost-choose').click()
                page.locator('#cost-form').wait_for(state="visible")
                page.locator('#cost-same-catalog').check()
                page.locator('#cost-basis').check()
                page.locator('#cost-preview').click()
                page.wait_for_function("!document.getElementById('cost-apply').disabled")
                page.locator('#cost-source-label').fill("另一合成来源")
                self.assertTrue(page.locator('#cost-apply').is_disabled())
                page.locator('#cost-mode').select_option('replace')
                self.assertTrue(page.locator('#cost-full-row').is_visible())
                self.assertTrue(page.locator('#cost-full').evaluate('(element) => element.required'))
                page.locator('#cost-mode').select_option('merge')
                self.assertTrue(page.locator('#cost-full-row').is_hidden())
                for width in (1180, 760):
                    page.set_viewport_size({"width": width, "height": 800})
                    self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
                    page.screenshot(path=str(Path(output) / f"cost-wizard-{width}.png"), full_page=True)
                page.locator('#cost-preview').click()
                page.wait_for_function("!document.getElementById('cost-apply').disabled")
                page.locator('#cost-apply').click()
                page.locator('#confirm-accept').click()
                page.wait_for_function("document.getElementById('cost-result').textContent.includes('更新已完成，界面刷新暂未完成')")
                self.assertTrue(page.locator('#cost-apply').is_disabled())
                self.assertEqual(1, page.evaluate("__testCalls.filter(item => item.action === 'apply_cost_import').length"))
                self.assertEqual([], errors)
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
