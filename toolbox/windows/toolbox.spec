# PyInstaller 6.22.2 onedir; paths are anchored to this spec, never the caller's cwd.
import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, copy_metadata

WINDOWS = Path(SPECPATH).resolve()
ROOT = WINDOWS.parents[1]
sys.path.insert(0, str(WINDOWS))
from layout import APP_NAME, source_datas, runtime_license_datas, core_imports, omit_extra_runtime

node_modules = Path(os.environ['TOOLBOX_NODE_MODULES']).resolve()
node_exe = Path(os.environ['TOOLBOX_NODE_EXE']).resolve()
ffmpeg_exe = Path(os.environ['TOOLBOX_FFMPEG_EXE']).resolve()
datas = source_datas(ROOT, os.environ.get('TOOLBOX_PROTECTED_SOURCE_ROOT')) + runtime_license_datas(ROOT) + [(str(node_modules), 'node_modules'),
    (str(node_exe), 'toolbox/runtime'), (str(ffmpeg_exe), 'toolbox/runtime'),
    (os.environ['TOOLBOX_NODE_LICENSE'], 'toolbox/runtime/licenses/node'),
    (os.environ['TOOLBOX_FFMPEG_LICENSE'], 'toolbox/runtime/licenses/ffmpeg'),
    (os.environ['TOOLBOX_BUILD_INFO'], 'toolbox')]
datas += collect_data_files('playwright', includes=['driver/package/**', 'driver/LICENSE'])
for line in (ROOT / 'toolbox/requirements.lock.txt').read_text(encoding='utf-8-sig').splitlines():
    if '==' in line and not line.startswith('#'):
        datas += copy_metadata(line.split('==')[0])

a = Analysis([str(WINDOWS / 'bootstrap.py')], pathex=[str(ROOT)], binaries=[], datas=datas,
    hiddenimports=core_imports(ROOT) + ['toolbox.engines.downloader.douyin_downloader_core', 'toolbox.engines.business.adapter',
        'toolbox.python_worker', 'webview.platforms.winforms', 'webview.platforms.edgechromium', 'pystray._win32'],
    hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'tkinter', 'webview.platforms.android', 'webview.platforms.gtk', 'webview.platforms.cocoa'],
    noarchive=False, optimize=0)
# Playwright's built-in hook also collects its private Node. Both clients use our shared Node.
a.datas = [item for item in a.datas if not omit_extra_runtime(item[0])]
a.binaries = [item for item in a.binaries if not omit_extra_runtime(item[0])]
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name=APP_NAME, debug=False,
    bootloader_ignore_signals=False, strip=False, upx=False, console=False,
    contents_directory='_internal', version=os.environ['TOOLBOX_VERSION_FILE'])
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name=APP_NAME)
