from pathlib import Path
from playwright.sync_api import sync_playwright

# 只检查本地工作台，不点击真实商品修改入口。
with sync_playwright() as p:
    edge = Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    if not edge.exists():
        edge = Path('C:/Program Files/Microsoft/Edge/Application/msedge.exe')
    browser = p.chromium.launch(executable_path=str(edge), headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1080})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:8080')
    page.wait_for_load_state('networkidle')
    initial_state = page.request.get('http://127.0.0.1:8080/api/state').json()
    input_data = initial_state['input']
    page.locator('#connection').get_by_text('浏览器已连接', exact=True).wait_for()
    assert page.locator('#shops input').count() == 8
    assert page.locator('#shops input:checked').count() == 0
    assert page.locator('#start').is_disabled()
    assert page.locator('#input-summary').inner_text() == f"{len(input_data['groups'])} 组原标题 · {input_data['titleCount']} 个新标题"
    assert page.locator('#input-file-name').inner_text() == input_data['fileName']
    assert page.locator('#file-read-state').inner_text() == '已读取'
    assert page.locator('#groups li').count() == input_data['titleCount']
    assert page.locator('#groups li:visible').count() == len(input_data['groups'][0]['titles'])
    page.get_by_role('tab', name='第 2 组').click()
    assert page.locator('.original-title:visible').inner_text() == input_data['groups'][1]['original']
    page.wait_for_timeout(1200)
    assert page.get_by_role('tab', name='第 2 组').get_attribute('aria-selected') == 'true'
    page.get_by_role('tab', name='第 2 组').press('ArrowLeft')
    assert page.get_by_role('tab', name='第 1 组').get_attribute('aria-selected') == 'true'
    page.locator('#shops input').first.check()
    assert page.locator('#start').is_enabled()
    page.get_by_role('button', name='全选', exact=True).click()
    assert page.locator('#shops input:checked').count() == 8
    page.get_by_role('button', name='清空选择', exact=True).click()
    assert page.locator('#start').is_disabled()
    page.get_by_role('tab', name='执行结果', exact=True).click()
    assert page.locator('#result-empty').is_visible()
    assert not page.locator('#preview-view').is_visible()
    page.get_by_role('tab', name='标题预览', exact=True).click()
    assert page.locator('#preview-view').is_visible()
    page.screenshot(path=str(Path(__file__).resolve().parent / 'workbench-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 1280, 'height': 720})
    assert page.locator('#start').bounding_box()['y'] < 720
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(Path(__file__).resolve().parent / 'workbench-mobile.png'), full_page=True)

    # 仅在独立测试页拦截状态响应，展示结果；不发起真实商品任务。
    display_state = page.request.get('http://127.0.0.1:8080/api/state').json()
    first = display_state['input']['groups'][0]
    shops = display_state['shops'][:2]
    display_state['task'] = {
        'status': 'failed', 'message': '标题超过平台限制：62/60，未保存', 'saved': 1, 'shops': shops,
        'groups': [{'original': first['original'], 'titleCount': 4, 'productCount': 3, 'saved': 1, 'unmodified': 2, 'unused': 3, 'status': 'failed'}],
        'items': [
            {'id': '3845594673414537410', 'shopId': shops[0]['id'], 'shopName': shops[0]['name'], 'original': first['original'], 'before': first['original'], 'after': first['titles'][0], 'target': first['titles'][0], 'excelRow': 2, 'attempts': 1, 'status': 'success', 'reason': '保存成功'},
            {'id': '3845984143154479219', 'shopId': shops[1]['id'], 'shopName': shops[1]['name'], 'original': first['original'], 'before': first['original'], 'after': first['original'], 'target': first['titles'][1], 'excelRow': 3, 'attempts': 0, 'status': 'failed', 'reason': '标题超过平台限制：62/60，未保存'},
        ],
        'stopPosition': {'original': first['original'], 'shopName': shops[1]['name'], 'productId': '3845984143154479219', 'target': first['titles'][1], 'reason': '标题超过平台限制：62/60，未保存'},
    }
    page.route('**/api/state', lambda route: route.fulfill(json=display_state))
    page.set_viewport_size({'width': 1440, 'height': 1080})
    page.reload()
    page.wait_for_load_state('networkidle')
    page.locator('#task-badge').get_by_text('已停止', exact=True).wait_for()
    assert page.locator('#saved-count').inner_text() == '1'
    assert page.locator('#failed-count').inner_text() == '1'
    assert '62/60' in page.locator('#stop-position').inner_text()
    assert page.locator('.result-item').count() == 2
    assert page.locator('#download-failures').is_visible()
    assert page.locator('#download-failures').get_attribute('href') == '/api/failures.xlsx'
    assert not page.locator('#stop').is_visible()
    page.locator('.item-details summary').first.click()
    page.wait_for_timeout(1200)
    assert page.locator('.item-details').first.get_attribute('open') is not None
    page.locator('.item-details summary').first.click()
    page.locator('.results-card').screenshot(path=str(Path(__file__).resolve().parent / 'workbench-results.png'))
    display_state['task']['status'] = 'complete'
    display_state['task']['stopPosition'] = None
    display_state['task']['groups'][0]['status'] = 'complete'
    display_state['task']['groups'][0]['failed'] = 1
    display_state['task']['groups'][0]['unused'] = 2
    display_state['task']['items'][1]['skipped'] = True
    page.locator('#task-badge').get_by_text('已完成', exact=True).wait_for()
    assert '1 件失败已记录' in page.locator('#task-message').inner_text()
    assert page.get_by_text('失败跳过', exact=True).count() == 1
    assert not page.locator('#stop-position').is_visible()
    assert page.locator('#download-failures').is_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 1440, 'height': 1080})
    display_state['task']['status'] = 'running'
    display_state['task']['stopPosition'] = None
    display_state['task']['groups'][0]['status'] = 'saving'
    display_state['task']['items'][1]['status'] = 'saving'
    page.locator('#task-badge').get_by_text('执行中', exact=True).wait_for()
    assert page.locator('#start').is_disabled()
    display_state['phase'] = 'ready'
    display_state['inputError'] = '未找到标题表格，请放入 标题.xls 或 标题.xlsx'
    display_state['input'] = None
    page.locator('#file-read-state').get_by_text('未读取', exact=True).wait_for()
    assert page.locator('#input-error').is_visible()
    assert page.locator('#start').is_disabled()
    assert page.locator('#stop').is_enabled()
    assert page.locator('#shops input').first.is_disabled()
    assert page.locator('#shops input:checked').count() == len(shops)
    display_state['phase'] = 'waiting-login'
    display_state['message'] = '请在 Edge 完成登录'
    display_state['task'] = None
    page.locator('#connection').get_by_text('等待登录', exact=True).wait_for()
    assert not page.locator('#download-failures').is_visible()
    assert page.locator('#connection-help').is_visible()
    assert page.locator('#start').is_disabled()
    display_state['phase'] = 'disconnected'
    display_state['message'] = '点击“连接 Edge”打开调试浏览器并进入业务页面'
    display_state['input'] = input_data
    display_state['inputError'] = ''
    display_state['shops'] = []
    page.locator('#connection').get_by_text('未连接', exact=True).wait_for()
    assert page.locator('#connect').is_enabled()
    assert page.locator('#refresh').is_enabled()
    assert page.locator('#start').is_disabled()
    connection_requests = []
    def mock_connect(route):
        connection_requests.append(route.request.method)
        display_state['phase'] = 'connecting'
        route.fulfill(status=202, json=display_state)
    page.route('**/api/connect', mock_connect)
    page.locator('#connect').click()
    page.locator('#connect').get_by_text('正在连接…', exact=True).wait_for()
    assert page.locator('#connect').is_disabled()
    assert connection_requests == ['POST']
    display_state['phase'] = 'error'
    display_state['message'] = '模拟连接失败'
    page.locator('#connect').get_by_text('重新连接 Edge', exact=True).wait_for()
    page.locator('#connect').click()
    page.locator('#connect').get_by_text('正在连接…', exact=True).wait_for()
    assert connection_requests == ['POST', 'POST']
    display_state['phase'] = 'waiting-login'
    page.locator('#connection').get_by_text('等待登录', exact=True).wait_for()
    assert not page.locator('#connect').is_visible()
    assert not errors, errors
    browser.close()
    print('UI PASS: selection, group switching + keyboard navigation + polling preservation, desktop/mobile layout, result comparison + error position, persistent details, running/login button states, no JS errors')
