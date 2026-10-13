import shutil
import subprocess
from pathlib import Path

from toolbox.host.application import ROOT
from toolbox.host.browser import find_edge
from toolbox.host.processes import start_process
from toolbox.host.static import StaticServer


def main():
    static = StaticServer(ROOT / 'toolbox/web')
    process, job = start_process([shutil.which('node'), str(Path(__file__).with_name('ui-smoke.cjs')),
        static.url, str(find_edge()), str(ROOT / 'toolbox/build/ui-smoke')],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        stdout, stderr = process.communicate(timeout=60)
        print(stdout.decode('utf-8', errors='replace'), end='')
        if process.returncode:
            raise RuntimeError(stderr.decode('utf-8', errors='replace'))
    finally:
        job.close()
        static.close()


if __name__ == '__main__':
    main()
