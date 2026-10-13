"""Frozen desktop entry point; no tool-specific interpreter paths reach the UI."""

import os
import sys
from pathlib import Path

if getattr(sys, 'frozen', False):
    os.environ['PLAYWRIGHT_NODEJS_PATH'] = str(Path(sys._MEIPASS) / 'toolbox/runtime/node.exe')

from toolbox.desktop import main

if __name__ == '__main__':
    main()
