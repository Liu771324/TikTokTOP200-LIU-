import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
import threading
from pathlib import Path

from .host.application import Application, ROOT
from .host.bridge import Bridge
from .host.instance import SingleInstance
from .host.paths import DataPaths
from .host.location import DataLocation
from .host.errors import ToolboxError
from .host.static import StaticServer
from .host.processes import contain_current_process


def webview2_available():
    import winreg
    key = r'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                with winreg.OpenKey(hive, key, 0, winreg.KEY_READ | view) as handle:
                    version = winreg.QueryValueEx(handle, 'pv')[0]
                    if version and version != '0.0.0.0':
                        return True
            except OSError:
                pass
    return False


def main(acceptance_runner=None):
    parser = argparse.ArgumentParser(description='小叶电商工具箱')
    parser.add_argument('--smoke', action='store_true', help='开发验证：临时数据、测试工作者并自动退出')
    parser.add_argument('--smoke-data-root', help=argparse.SUPPRESS)
    parser.add_argument('--acceptance', action='store_true', help='源码开发验收：临时开放真实工具，使用正式用户数据')
    options = parser.parse_args()
    if acceptance_runner and (not options.acceptance or getattr(sys, 'frozen', False)):
        parser.error('验收回调仅可用于源码 --acceptance')
    if options.acceptance and (options.smoke or getattr(sys, 'frozen', False)):
        parser.error('--acceptance 只用于源码真实验收，不能与smoke或冻结发布版一起使用')
    if options.smoke_data_root and not options.smoke:
        parser.error('--smoke-data-root 只可用于开发 smoke 子进程')
    if options.smoke and not options.smoke_data_root:
        import tempfile
        temporary = tempfile.TemporaryDirectory(prefix='toolbox-desktop-smoke-')
        try:
            command = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'toolbox.desktop']
            result = subprocess.run([*command, '--smoke', '--smoke-data-root', temporary.name], timeout=60)
        finally:
            deadline = time.monotonic() + 10
            while True:
                try:
                    temporary.cleanup()
                    break
                except PermissionError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(.05)
        if result.returncode:
            raise SystemExit(result.returncode)
        return
    location = None if options.smoke else DataLocation(forbidden=(ROOT, Path(sys.executable).parent))
    # Keep the production identity stable across data moves and compatible with 0.1.1.
    identity = Path(options.smoke_data_root) if options.smoke else location.settings
    instance = SingleInstance(identity)
    legacy_instance = None
    if not instance.primary:
        instance.close()
        return
    if location:
        legacy_instance = SingleInstance(location.legacy)
        if not legacy_instance.primary:
            legacy_instance.close()
            instance.close()
            return
    try:
        if location:
            try:
                location.migrate_pending()
            except (OSError, ToolboxError):
                location.record_failure()
            paths = DataPaths(location.current())
        else:
            paths = DataPaths(Path(options.smoke_data_root))
    except (OSError, ToolboxError):
        ctypes.windll.user32.MessageBoxW(None, '数据位置不可用或配置无法读取。请恢复原数据磁盘后重试；软件不会创建空库替代原数据。', '小叶电商工具箱', 0x10)
        instance.close()
        if legacy_instance:
            legacy_instance.close()
        return
    if not webview2_available():
        ctypes.windll.user32.MessageBoxW(None, '未找到 Microsoft Edge WebView2 Runtime。请从微软官网下载并安装 WebView2 运行时后重试。', '小叶电商工具箱', 0x10)
        instance.close()
        if legacy_instance:
            legacy_instance.close()
        return
    import pystray
    import webview
    from PIL import Image
    contain_current_process()
    fixture_smoke = options.smoke and not getattr(sys, 'frozen', False)
    app = Application(paths, test_adapter=fixture_smoke, acceptance=options.acceptance,
                      cost_port=0 if options.smoke else 8765)
    static = StaticServer(ROOT / 'toolbox/web')
    exiting = threading.Event()
    smoke_errors = []
    exit_lock = threading.Lock()
    icon = None
    try:
        bridge = Bridge(app, static.url)
        window = webview.create_window('小叶电商工具箱', static.url, js_api=bridge, width=1280, height=820,
                                      min_size=(1000, 640), background_color='#f2f5f8')
        app.window = app.files.window = window
        def show(*args):
            window.show()
            window.restore()
        def close_window():
            if exiting.is_set():
                return True
            window.hide()
            return False
        def finish_exit(confirm=True):
            if not exit_lock.acquire(blocking=False):
                return
            try:
                if confirm and not window.create_confirmation_dialog('退出工具箱', '退出会停止当前任务，保留已保存的进度与结果。确定退出？'):
                    return
                app.shutdown()
                exiting.set()
                icon.stop()
                window.destroy()
            except Exception as exc:
                app.logs.write(type(exc).__name__ + ': 退出未完成，请再次尝试。', level='error')
                show()
                window.create_confirmation_dialog('暂时无法退出', '任务仍在保存或后台进程未能结束，请稍后再次退出。')
            finally:
                exit_lock.release()
        def request_exit(*args):
            threading.Thread(target=finish_exit, daemon=True).start()
        app.show, app.request_exit = show, request_exit
        window.events.closing += close_window
        image = Image.open(ROOT / 'toolbox/web/icon.png')
        icon = pystray.Icon('ScriptAllToolbox', image, '小叶电商工具箱', pystray.Menu(
            pystray.MenuItem('打开工具箱', show, default=True), pystray.MenuItem('退出', request_exit)))
        threading.Thread(target=icon.run, daemon=True).start()
        instance.watch(show)
        def smoke():
            if not options.smoke:
                if acceptance_runner:
                    window.events.loaded.wait(15)
                    acceptance_runner(app, bridge, window, lambda: finish_exit(False))
                return
            try:
                window.events.loaded.wait(15)
                import time
                ui_deadline = time.monotonic() + 8
                while window.evaluate_js("document.querySelectorAll('#tools button').length") != len(app.descriptors) and time.monotonic() < ui_deadline:
                    time.sleep(.05)
                assert window.evaluate_js("document.querySelectorAll('#tools button').length") == len(app.descriptors)
                assert bridge.invoke('app.get_state')['ok']
                cost_state = bridge.invoke('cost.invoke', {'action': 'get_state'})
                assert cost_state['ok'] and cost_state['data']['owns_service']
                assert not bridge.invoke('execute', {'command': 'arbitrary'})['ok']
                close_window()
                show()
                duplicate = SingleInstance(paths.root)
                assert not duplicate.primary
                duplicate.close()
                duplicate_command = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'toolbox.desktop']
                second = subprocess.run([*duplicate_command, '--smoke', '--smoke-data-root', str(paths.root)], timeout=8)
                assert second.returncode == 0
                # Fixture task uses the same public lifecycle without platform navigation.
                if fixture_smoke:
                    app.descriptors['top200']['requiresBrowser'] = False
                    task = app.scheduler.create('top200', {'categories': ['fixture'] * 3})
                    deadline = time.monotonic() + 8
                    while app.store.task(task['id'])['state'] != 'completed' and time.monotonic() < deadline:
                        time.sleep(.05)
                    assert app.store.task(task['id'])['state'] == 'completed'
                else:
                    # Frozen smoke checks the production worker without shipping fixtures.
                    from .host.worker import NodeWorker
                    with NodeWorker(ROOT / 'toolbox/runtime/node.exe', ROOT / 'toolbox/node/worker.cjs'):
                        pass
                print(json.dumps({'desktopLoaded': True, 'trayCreated': icon.visible, 'singleInstance': True,
                                  'hideRestore': True, 'bridgeWhitelist': True, 'worker': 'ready',
                                  'costWorker': 'ready',
                                  'fixtureTask': 'completed' if fixture_smoke else 'not included'}), flush=True)
            except Exception as exc:
                smoke_errors.append(exc)
                raise
            finally:
                finish_exit(False)
        webview.start(smoke, gui='edgechromium', debug=False, private_mode=False,
                      icon=str(ROOT / 'toolbox/windows/icon.ico'),
                      storage_path=str(paths.resolve('webview-profile')))
        if smoke_errors:
            raise RuntimeError('桌面 smoke 未通过') from smoke_errors[0]
    finally:
        if icon:
            icon.stop()
        if not exiting.is_set():
            app.shutdown()
        static.close()
        instance.close()
        if legacy_instance:
            legacy_instance.close()


if __name__ == '__main__':
    main()
