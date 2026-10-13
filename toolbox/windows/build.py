"""Windows build coordinator. No shell interpolation, cleanup, or build on import."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

try:
    from .layout import APP_NAME, RUNTIMES, inventory, sha256, validate_bundle, validate_sources, validate_version
except ImportError:
    from layout import APP_NAME, RUNTIMES, inventory, sha256, validate_bundle, validate_sources, validate_version

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parents[1]


def run(arguments, *, cwd=ROOT, env=None, capture=False):
    result = subprocess.run([str(value) for value in arguments], cwd=cwd, env=env, check=True,
        text=True, encoding='utf-8', errors='replace', stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def required_file(value, description):
    file = Path(value).resolve()
    if not file.is_file():
        raise ValueError(f'{description} does not exist: {file}')
    return file


def build_directory(root, version):
    root = Path(root).resolve()
    identifier = validate_version(version) + '-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    work = root / 'toolbox/build/windows' / identifier
    release = root / 'dist/release' / identifier
    for folder, intended in ((work, root / 'toolbox/build'), (release, root / 'dist/release')):
        if not folder.resolve().is_relative_to(intended.resolve()):
            raise ValueError('Build output escapes its intended directory')
        folder.mkdir(parents=True, exist_ok=False)
    return work, release


def file_version_text(version):
    validate_version(version)
    numbers = tuple(int(value) for value in version.split('.')) + (0,)
    return f'''VSVersionInfo(
  ffi=FixedFileInfo(filevers={numbers}, prodvers={numbers}, mask=0x3f, flags=0x0,
    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[StringFileInfo([StringTable('080404B0', [
    StringStruct('CompanyName', 'Script All'), StringStruct('FileDescription', '电商工具箱'),
    StringStruct('FileVersion', '{version}'), StringStruct('ProductVersion', '{version}'),
    StringStruct('ProductName', '电商工具箱'), StringStruct('OriginalFilename', '{APP_NAME}.exe')])]),
    VarFileInfo([VarStruct('Translation', [2052, 1200])])])
'''


def locked_versions(paths):
    versions = {}
    for file in paths:
        for line in Path(file).read_text(encoding='utf-8-sig').splitlines():
            if line.strip() and not line.lstrip().startswith('#'):
                name, version = line.strip().split('==')
                versions[name] = version
    return versions


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build the Windows x64 desktop release in isolated output directories')
    parser.add_argument('--version', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--iscc', required=True)
    parser.add_argument('--bootstrapper', required=True)
    parser.add_argument('--node-license')
    parser.add_argument('--ffmpeg-license', default=str(ROOT / 'toolbox/build/downloads/COPYING.GPLv3'))
    parser.add_argument('--build-venv')
    options = parser.parse_args(argv)
    validate_version(options.version)
    if sys.platform != 'win32' or sys.version_info[:3] != (3, 13, 2) or sys.maxsize <= 2**32:
        raise ValueError('Build requires Windows x64 Python 3.13.2')
    validate_sources(ROOT)
    node = required_file(options.node, 'Node executable')
    ffmpeg = required_file(options.ffmpeg, 'FFmpeg executable')
    if node.name.lower() != 'node.exe' or ffmpeg.name.lower() != 'ffmpeg.exe':
        raise ValueError('Runtime inputs must be named node.exe and ffmpeg.exe')
    iscc = required_file(options.iscc, 'Inno Setup compiler')
    bootstrapper = required_file(options.bootstrapper, 'Microsoft-signed Evergreen bootstrapper')
    node_license = required_file(options.node_license or node.with_name('LICENSE'), 'Node license')
    ffmpeg_license = required_file(options.ffmpeg_license, 'FFmpeg GPLv3 license')
    npm_cli = required_file(node.parent / 'node_modules/npm/bin/npm-cli.js', 'npm CLI matching the supplied Node distribution')
    node_version = run([node, '--version'], capture=True)
    node_arch = run([node, '-p', 'process.arch'], capture=True)
    ffmpeg_version = run([ffmpeg, '-version'], capture=True).splitlines()[0]
    if node_version != 'v' + RUNTIMES['node'] or node_arch != 'x64':
        raise ValueError('Node must be Windows x64 v24.19.0')
    if not re.match(r'ffmpeg version 7\.1(?:\s|[-+])', ffmpeg_version):
        raise ValueError('FFmpeg must match the recorded 7.1 build')
    work, release = build_directory(ROOT, options.version)
    if options.build_venv:
        venv = Path(options.build_venv).resolve()
        if not venv.is_relative_to((ROOT / 'toolbox/build').resolve()):
            raise ValueError('Existing build venv must belong to toolbox/build')
        python = required_file(venv / 'Scripts/python.exe', 'Build venv Python')
    else:
        venv = work / 'venv'
        run([sys.executable, '-m', 'venv', venv])
        python = required_file(venv / 'Scripts/python.exe', 'Build venv Python')
    runtime_lock = ROOT / 'toolbox/requirements.lock.txt'
    build_lock = WINDOWS / 'requirements-build.lock.txt'
    environment = os.environ.copy()
    environment.update(PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1', PYTHONUTF8='1', PYTHONNOUSERSITE='1')
    probe = json.loads(run([python, '-c',
        'import json,sys; print(json.dumps({"version":list(sys.version_info[:3]),"x64":sys.maxsize>2**32,"prefix":sys.prefix,"base":sys.base_prefix}))'],
        capture=True, env=environment))
    if probe['version'] != [3, 13, 2] or not probe['x64'] or Path(probe['prefix']).resolve() != venv or probe['prefix'] == probe['base']:
        raise ValueError('Build venv must be isolated Windows x64 Python 3.13.2')
    run([python, '-m', 'pip', 'install', '--disable-pip-version-check', '-r', runtime_lock, '-r', build_lock], env=environment)
    actual = json.loads(run([python, '-c',
        'import importlib.metadata,json,sys; print(json.dumps({n:importlib.metadata.version(n) for n in sys.argv[1:]}))',
        *locked_versions([runtime_lock, build_lock])], capture=True, env=environment))
    if actual != locked_versions([runtime_lock, build_lock]):
        raise ValueError('Build environment does not match the pinned locks')
    node_project = work / 'npm'
    node_project.mkdir()
    for name in ('package.json', 'package-lock.json'):
        shutil.copy2(ROOT / 'toolbox' / name, node_project / name)
    run([node, npm_cli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=node_project, env=environment)
    commit = run(['git', 'rev-parse', 'HEAD'], capture=True)
    dirty = bool(run(['git', 'status', '--porcelain', '--untracked-files=all'], capture=True))
    inputs = {'node': node, 'ffmpeg': ffmpeg, 'innoCompiler': iscc, 'webview2Bootstrapper': bootstrapper,
        'nodeLicense': node_license, 'ffmpegLicense': ffmpeg_license}
    build_info = {'version': options.version, 'sourceCommit': commit, 'sourceDirty': dirty,
        'builtAt': datetime.now(timezone.utc).isoformat(), 'runtimeVersions': {**RUNTIMES, 'node': node_version, 'ffmpeg': ffmpeg_version},
        'pythonDependencies': actual,
        'nodeDependencies': json.loads((node_project / 'package-lock.json').read_text(encoding='utf-8'))['packages'],
        'inputs': {name: {'filename': file.name, 'size': file.stat().st_size, 'sha256': sha256(file)} for name, file in inputs.items()},
        'lockSha256': {file.name: sha256(file) for file in (runtime_lock, build_lock, ROOT / 'toolbox/package-lock.json')}}
    info_path = work / 'release-info.json'
    info_path.write_text(json.dumps(build_info, ensure_ascii=False, indent=2), encoding='utf-8')
    version_file = work / 'version-info.txt'
    version_file.write_text(file_version_text(options.version), encoding='utf-8')
    bundled_node_license = work / 'licenses/node/LICENSE'
    bundled_ffmpeg_license = work / 'licenses/ffmpeg/COPYING.GPLv3'
    for source, destination in ((node_license, bundled_node_license), (ffmpeg_license, bundled_ffmpeg_license)):
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    environment.update(TOOLBOX_NODE_MODULES=str(node_project / 'node_modules'), TOOLBOX_NODE_EXE=str(node),
        TOOLBOX_FFMPEG_EXE=str(ffmpeg), TOOLBOX_VERSION_FILE=str(version_file), TOOLBOX_BUILD_INFO=str(info_path),
        TOOLBOX_NODE_LICENSE=str(bundled_node_license), TOOLBOX_FFMPEG_LICENSE=str(bundled_ffmpeg_license))
    run([python, '-m', 'PyInstaller', '--distpath', release / 'app', '--workpath', work / 'freeze', WINDOWS / 'toolbox.spec'], env=environment)
    app_dir = release / 'app' / APP_NAME
    app_files = validate_bundle(app_dir)
    installer_dir = release / 'installer'
    installer_dir.mkdir()
    run([iscc, '/Qp', f'/DAppVersion={options.version}', f'/DAppDir={app_dir}', f'/DOutputDir={installer_dir}',
        f'/DBootstrapperPath={bootstrapper}', WINDOWS / 'installer.iss'], env=environment)
    installers = list(installer_dir.glob('*.exe'))
    if len(installers) != 1:
        raise ValueError('Expected one setup executable')
    manifest = {**build_info, 'application': {'path': app_dir.relative_to(release).as_posix(),
        'size': sum(file['size'] for file in app_files), 'files': app_files},
        'installer': {'path': installers[0].relative_to(release).as_posix(), 'size': installers[0].stat().st_size,
            'sha256': sha256(installers[0])},
        'knownLimitations': ['Fresh Windows 10/11 x64 install/upgrade/uninstall acceptance is required.',
            'Evergreen bootstrapper needs internet only when WebView2 Runtime is missing.',
            'Application and installer are not code signed by this script.',
            'Redistribution notices and corresponding FFmpeg source must be reviewed before public release.']}
    (release / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    sums = inventory(release)
    (release / 'SHA256SUMS.txt').write_text(''.join(f"{file['sha256']}  {file['path']}\n" for file in sums), encoding='utf-8')
    print(release)


if __name__ == '__main__':
    main()
