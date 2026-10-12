"""Development smoke: owned temporary Edge profile, about:blank only."""
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from toolbox.host.browser import BrowserManager
from toolbox.host.events import Events
from toolbox.host.paths import DataPaths


def main():
    temporary = tempfile.TemporaryDirectory(prefix='toolbox-edge-smoke-')
    try:
        directory = temporary.name
        paths = DataPaths(Path(directory))
        paths.initialize()
        manager = BrowserManager(paths, Events())
        try:
            with manager.lease('development-smoke') as session:
                version = manager._request('/json/version')['Browser']
                script = '''const {connect,selectPage}=require(process.argv[2]);
                (async()=>{for(let i=0;i<2;i++){
                    const {browser,disconnect}=await connect({browser:{endpoint:process.argv[1]}});
                    const page=await selectPage(browser,process.argv[3],url=>url==='about:blank');
                    if(await page.evaluate(()=>1+1)!==2)throw Error('page not responsive');
                    await disconnect();
                }})().catch(e=>{console.error(e);process.exitCode=1});'''
                page_id = next(p['id'] for p in manager._request('/json/list') if p.get('url') == 'about:blank')
                result = subprocess.run([shutil.which('node'), '-e', script, session['endpoint'],
                    str(Path(__file__).parents[1] / 'node/browser-client.cjs'), page_id],
                    cwd=Path(__file__).parents[1], capture_output=True, timeout=30,
                    creationflags=subprocess.CREATE_NO_WINDOW)
                if result.returncode:
                    raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))
                manager._check_identity()
                assert manager.state()['connected']
                process = manager._process
            assert manager.queue.state()['holder'] is None
            manager.close()
            assert process.poll() is not None
        finally:
            manager.close()
    finally:
        started = time.monotonic()
        while True:
            try:
                temporary.cleanup()
                break
            except PermissionError:
                if time.monotonic() - started >= 10:
                    raise
                time.sleep(.05)
    print(json.dumps({'edge': version, 'cdpConnectDisconnect': 2,
                      'sharedSessionSurvived': True, 'ownedShutdown': True,
                      'temporaryCleanupSeconds': round(time.monotonic() - started, 3)}))


if __name__ == '__main__':
    main()
