"""Explicit release inputs and checks, usable without PyInstaller installed."""

import ast
import hashlib
import json
import re
from pathlib import Path

APP_NAME = 'ScriptAllToolbox'
INSTALL_MUTEX = r'Local\ScriptAllToolbox.InstallGuard'
RUNTIMES = {'python': '3.13.2', 'node': '24.19.0', 'ffmpeg': '7.1', 'pyinstaller': '6.22.2'}
CORE = 'toolbox/engines/downloader/douyin_downloader_core.py'
BUSINESS_FILES = {
    'toolbox/engines/product-title': ('browser.cjs', 'workbook.cjs', 'task.cjs', 'report.cjs'),
    'toolbox/engines/top200': ('collector.js', 'edge.js', 'task-store.js', 'collector-utils.js', 'export-excel.js'),
    'toolbox/engines/video': ('collector.js', 'edge.js', 'video-fingerprint.js', 'task-store.js',
        'compass-page.js', 'toolbox-runtime.js'),
}
NODE_FILES = ('worker.cjs', 'sdk.cjs', 'browser-client.cjs', 'douyin-page.cjs',
    'adapters/top200.cjs', 'adapters/video-ranking.cjs', 'adapters/manual-video.cjs', 'adapters/product-title.cjs')
WEB_FILES = ('index.html', 'app.js', 'style.css', 'icon.png', 'cost/index.html', 'cost/app.js',
    'cost/styles.css', 'cost/refresh_model.js', 'cost/shipping_filters.js')
PYTHON_FILES = ('toolbox/python_worker.py', 'toolbox/cost_worker.py', 'toolbox/engines/__init__.py',
    'toolbox/engines/business/__init__.py', 'toolbox/engines/business/adapter.py',
    'toolbox/engines/business/parser.py', 'toolbox/engines/business/transport.py',
    'toolbox/engines/business/report.py', 'toolbox/engines/downloader/__init__.py')
SOURCE_FILES = tuple(f'{directory}/{name}' for directory, names in BUSINESS_FILES.items() for name in names) + tuple(
    f'toolbox/node/{name}' for name in NODE_FILES) + tuple(f'toolbox/web/{name}' for name in WEB_FILES) + (
        'toolbox/tools.json', 'toolbox/windows/icon.ico', CORE, 'toolbox/THIRD_PARTY_NOTICES.md', 'toolbox/engines/downloader/THIRD_PARTY_NOTICES.md') + PYTHON_FILES
COST_FILES = ('toolbox/engines/cost/data/douyin_service_fee_2026.json',) + tuple(
    f'toolbox/browser-extension/cost/{name}' for name in ('manifest.json', 'background.js', 'content.js', 'core.js', 'panel.js'))
SOURCE_FILES += COST_FILES
RUNTIME_LICENSES = ('python', 'proxy_tools')
FROZEN_DATA_FILES = tuple(name for name in SOURCE_FILES if not name.endswith('.py'))
REQUIRE = re.compile(r"\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")


def validate_version(version):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise ValueError('Version must be X.Y.Z with numeric components')
    if any(int(part) > 65535 for part in version.split('.')):
        raise ValueError('Version component exceeds Windows file-version range')
    return version


def validate_sources(root):
    root = Path(root).resolve()
    allowed = set(SOURCE_FILES)
    external = set(json.loads((root / 'toolbox/package.json').read_text(encoding='utf-8'))['dependencies'])
    for relative in SOURCE_FILES:
        source = root / relative
        if not source.is_file() or not source.resolve().is_relative_to(root):
            raise ValueError(f'Missing or escaping release input: {relative}')
        if source.suffix not in {'.js', '.cjs'}:
            continue
        for request in REQUIRE.findall(source.read_text(encoding='utf-8')):
            if request.startswith('.'):
                base = source.parent / request
                choices = (base, base.with_suffix('.js'), base.with_suffix('.cjs'), base / 'index.js')
                resolved = next((item.resolve() for item in choices if item.is_file()), None)
                if resolved is None or not resolved.is_relative_to(root) or resolved.relative_to(root).as_posix() not in allowed:
                    raise ValueError(f'Unlisted local dependency: {relative} -> {request}')
            elif not request.startswith('node:') and request.split('/')[0] not in external:
                raise ValueError(f'Unlisted npm dependency: {relative} -> {request}')
    return True


def source_datas(root, staged_root=None):
    validate_sources(root)
    data_root = Path(staged_root or root).resolve()
    for name in FROZEN_DATA_FILES:
        file = data_root / name
        if not file.is_file() or not file.resolve().is_relative_to(data_root):
            raise ValueError(f'Missing protected release data: {name}')
    return [(str(data_root / name), str(Path(name).parent)) for name in FROZEN_DATA_FILES]


def runtime_license_datas(root):
    root = Path(root).resolve()
    datas = []
    for component in RUNTIME_LICENSES:
        file = root / 'toolbox/windows/licenses' / component / 'LICENSE.txt'
        if not file.is_file() or not file.resolve().is_relative_to(root):
            raise ValueError(f'Missing runtime license source: {component}')
        datas.append((str(file), f'toolbox/runtime/licenses/{component}'))
    return datas


def core_imports(root):
    tree = ast.parse((Path(root) / CORE).read_text(encoding='utf-8'))
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.module != '__future__':
            imports.add(node.module)
    return sorted(imports)


def omit_extra_runtime(destination):
    path = destination.replace('\\', '/').lower()
    return path.startswith('playwright/driver/') and Path(path).name in {'node', 'node.exe'}


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(directory):
    directory = Path(directory).resolve()
    records = []
    for file in sorted(directory.rglob('*')):
        if file.is_symlink() or not file.resolve().is_relative_to(directory):
            raise ValueError('Release tree contains a link outside its root')
        if file.is_file():
            records.append({'path': file.relative_to(directory).as_posix(), 'size': file.stat().st_size, 'sha256': sha256(file)})
    return records


def validate_bundle(directory):
    directory = Path(directory)
    internal = directory / '_internal'
    expected = {'node.exe': 'toolbox/runtime/node.exe', 'ffmpeg.exe': 'toolbox/runtime/ffmpeg.exe'}
    for name, relative in expected.items():
        found = [item.relative_to(internal).as_posix() for item in internal.rglob(name)]
        if found != [relative]:
            raise ValueError(f'Expected one shared {name}: {found}')
    for folder in (*BUSINESS_FILES, Path(CORE).parent.as_posix()):
        actual = {item.relative_to(internal).as_posix() for item in (internal / folder).rglob('*') if item.is_file()}
        expected_files = {name for name in FROZEN_DATA_FILES if name.startswith(folder + '/')}
        if actual != expected_files:
            raise ValueError(f'Business release whitelist mismatch: {folder}')
    if any(not (internal / f'node_modules/{name}/package.json').is_file() for name in ('playwright-core', 'exceljs', 'xlsx')):
        raise ValueError('Shared production npm installation is missing')
    for item in internal.rglob('node_modules'):
        relative = item.relative_to(internal).as_posix()
        if relative != 'node_modules' and not relative.startswith('node_modules/'):
            raise ValueError(f'Unexpected separate node_modules: {relative}')
    for name in ('toolbox/node', 'toolbox/web'):
        actual = {item.relative_to(internal).as_posix() for item in (internal / name).rglob('*') if item.is_file()}
        expected_files = {item for item in FROZEN_DATA_FILES if item.startswith(name + '/')}
        if actual != expected_files:
            raise ValueError(f'Release assets mismatch: {name}')
    if not (directory / f'{APP_NAME}.exe').is_file():
        raise ValueError('Missing desktop executable')
    for name in (*FROZEN_DATA_FILES, 'toolbox/release-info.json', 'playwright/driver/package/cli.js'):
        if not (internal / name).is_file():
            raise ValueError(f'Missing frozen runtime data: {name}')
    for name in ('node', 'ffmpeg', *RUNTIME_LICENSES):
        if not any(item.is_file() for item in (internal / 'toolbox/runtime/licenses' / name).rglob('*')):
            raise ValueError(f'Missing runtime license: {name}')
    if (internal / 'toolbox/tests').exists() or any(internal.rglob('.local-browsers')):
        raise ValueError('Development fixtures or downloaded browsers entered the release')
    if any((internal / name).exists() for name in (CORE, *PYTHON_FILES, 'toolbox/windows/protection')) or any(
            item.suffix == '.map' for folder in ('toolbox/web', 'toolbox/node', *BUSINESS_FILES)
            for item in (internal / folder).rglob('*') if item.is_file()):
        raise ValueError('Raw protected source or development maps entered the release')
    return inventory(directory)
