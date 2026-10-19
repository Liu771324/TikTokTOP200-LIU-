"""Frozen desktop entry point; no tool-specific interpreter paths reach the UI."""

import os
import sys
from pathlib import Path

if getattr(sys, 'frozen', False):
    os.environ['PLAYWRIGHT_NODEJS_PATH'] = str(Path(sys._MEIPASS) / 'toolbox/runtime/node.exe')

if __name__ == '__main__':
    if sys.argv[1:] == ['--business-worker']:
        from toolbox.python_worker import main
    elif sys.argv[1:2] == ['--cost-service-worker']:
        from toolbox.cost_worker import main
    else:
        from toolbox.desktop import main
    main()
