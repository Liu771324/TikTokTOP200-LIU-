"""Source-only live acceptance driver. Commands/results stay in ignored build data."""
import json
import time
import threading
from pathlib import Path

from toolbox.desktop import main


DIRECTORY = Path(__file__).resolve().parents[1] / 'build/live-acceptance'


def run(app, bridge, window, finish):
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    sequence = 0
    closing = threading.Event()
    pending = []
    (DIRECTORY / 'ready.json').write_text(json.dumps({'ready': True}), encoding='utf-8')
    def execute(command):
        try:
            if command['method'] == 'page.inspect':
                from playwright.sync_api import sync_playwright
                with app.browser.lease('acceptance-inspect-' + str(command['seq']), closing.is_set) as session, sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(session['endpoint'])
                    pages = [page for context in browser.contexts for page in context.pages
                             if command.get('host', 'compass.jinritemai.com') in page.url]
                    page = pages[-1]
                    if command.get('clickTab'):
                        page.get_by_role('tab', name=command['clickTab'], exact=True).click()
                        page.wait_for_timeout(2000)
                    result = page.evaluate(command.get('script') or """() => ({path:location.pathname,
                      tabs:[...document.querySelectorAll('[role=tab]')].map(t=>({text:t.innerText,selected:t.getAttribute('aria-selected'),visible:!!t.getClientRects().length})),
                      category:[...document.querySelectorAll('.aurora-cascader,.ecom-cascader')].map(t=>t.innerText),
                      headers:[...document.querySelectorAll('thead')].map(t=>t.innerText),
                      rows:document.querySelectorAll('tbody tr').length,
                      notice:[...document.querySelectorAll('[role=alert]')].map(t=>t.innerText)})""")
            elif command['method'] == 'ui.inspect':
                result = window.evaluate_js(command['script'])
            else:
                result = bridge.invoke(command['method'], command.get('params', {}))
            output = {'seq': command['seq'], 'result': result}
        except Exception as exc:
            output = {'seq': command['seq'], 'errorType': type(exc).__name__}
        target = DIRECTORY / f"result-{command['seq']}.json"
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')
        temporary.replace(target)
    try:
        while True:
            command_file = DIRECTORY / 'command.json'
            if not command_file.exists():
                time.sleep(.2)
                continue
            try:
                command = json.loads(command_file.read_text(encoding='utf-8-sig'))
            except (OSError, ValueError):
                time.sleep(.2)
                continue
            if command['seq'] <= sequence:
                time.sleep(.2)
                continue
            sequence = command['seq']
            if command['method'] == 'finish':
                closing.set()
                app.operations.shutdown()
                app.scheduler.shutdown()
                for thread in pending:
                    thread.join(5)
                if any(thread.is_alive() for thread in pending):
                    raise RuntimeError('验收读取尚未退出')
                finish()
                return
            pending = [thread for thread in pending if thread.is_alive()]
            thread = threading.Thread(target=execute, args=(command,), daemon=True)
            pending.append(thread)
            thread.start()
    finally:
        (DIRECTORY / 'ready.json').unlink(missing_ok=True)


if __name__ == '__main__':
    main(acceptance_runner=run)
