"""Release-layout checks using local sources, temporary files and mocked freeze APIs.

No build tools, network requests, real installation or platform collection run here.
"""

import hashlib
import importlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from toolbox.windows import build, layout

ROOT = Path(__file__).resolve().parents[2]
WINDOWS = ROOT / 'toolbox/windows'


def write(root, relative, content='fixture'):
    file = root / relative
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content, encoding='utf-8')
    return file


def source_fixture(root):
    for name in layout.SOURCE_FILES:
        write(root, name, '')
    write(root, 'toolbox/package.json', '{"dependencies":{"exceljs":"4.4.0","playwright-core":"1.58.2"}}')


def bundle_fixture(root):
    internal = root / '_internal'
    for name in layout.SOURCE_FILES:
        write(internal, name)
    for name in ('toolbox/runtime/node.exe', 'toolbox/runtime/ffmpeg.exe',
            'toolbox/runtime/licenses/node/LICENSE', 'toolbox/runtime/licenses/ffmpeg/COPYING.GPLv3',
            'toolbox/runtime/licenses/python/LICENSE.txt', 'toolbox/runtime/licenses/proxy_tools/LICENSE.txt',
            'toolbox/release-info.json', 'node_modules/playwright-core/package.json',
            'node_modules/exceljs/package.json', 'playwright/driver/package/cli.js'):
        write(internal, name)
    write(root, layout.APP_NAME + '.exe')
    return internal


class SourceLayoutTests(unittest.TestCase):
    def test_real_source_dependencies_match_whitelist(self):
        self.assertTrue(layout.validate_sources(ROOT))

    def test_whitelist_unique_and_only_business_javascript(self):
        self.assertEqual(len(layout.SOURCE_FILES), len(set(layout.SOURCE_FILES)))
        self.assertEqual(len(layout.SOURCE_FILES), 39)
        for folder, names in layout.BUSINESS_FILES.items():
            for name in names:
                self.assertEqual(Path(name).suffix, '.js')
                self.assertNotIn(name, ('server.js', 'app.js'))
                self.assertEqual(Path(name).name, name)
                self.assertIn(folder + '/' + name, layout.SOURCE_FILES)

    def test_datas_preserve_relative_paths(self):
        datas = layout.source_datas(ROOT)
        self.assertEqual(len(datas), len(layout.SOURCE_FILES))
        for relative, (source, destination) in zip(layout.SOURCE_FILES, datas):
            self.assertEqual(Path(source), ROOT / relative)
            self.assertEqual(Path(destination), Path(relative).parent)
            self.assertFalse(Path(destination).is_absolute())

    def test_python_and_proxy_licenses_are_explicit_inputs(self):
        datas = layout.runtime_license_datas(ROOT)
        self.assertEqual(len(datas), 2)
        for component, (source, destination) in zip(layout.RUNTIME_LICENSES, datas):
            self.assertEqual(Path(source), WINDOWS / 'licenses' / component / 'LICENSE.txt')
            self.assertEqual(destination, 'toolbox/runtime/licenses/' + component)
        python = (WINDOWS / 'licenses/python/LICENSE.txt').read_text(encoding='utf-8')
        self.assertIn('Python Software Foundation License Version 2', python)
        proxy = (WINDOWS / 'licenses/proxy_tools/LICENSE.txt').read_text(encoding='utf-8')
        self.assertIn('The BSD License (BSD)', proxy)
        self.assertIn('Copyright (c) 2013 Armin Ronacher', proxy)
        self.assertIn('Copyright (c) 2014 Jonathan Tushman', proxy)
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, 'Missing runtime license source'):
                layout.runtime_license_datas(temporary)

    def test_missing_source_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_fixture(root)
            (root / layout.SOURCE_FILES[0]).unlink()
            with self.assertRaisesRegex(ValueError, 'Missing or escaping'):
                layout.validate_sources(root)

    def test_unlisted_local_dependency_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_fixture(root)
            write(root, '商机中心/task-store.js', "require('./server')")
            write(root, '商机中心/server.js', '')
            with self.assertRaisesRegex(ValueError, 'Unlisted local dependency'):
                layout.validate_sources(root)

    def test_unlisted_npm_dependency_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_fixture(root)
            write(root, '商机中心/task-store.js', "require('express')")
            with self.assertRaisesRegex(ValueError, 'Unlisted npm dependency'):
                layout.validate_sources(root)

    def test_allowed_relative_and_shared_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_fixture(root)
            write(root, '商机中心/task-store.js', "require('./edge');require('node:fs');require('exceljs')")
            self.assertTrue(layout.validate_sources(root))

    def test_core_dynamic_playwright_import_collected(self):
        self.assertIn('playwright.sync_api', layout.core_imports(ROOT))
        self.assertIn('requests', layout.core_imports(ROOT))

    def test_only_private_playwright_node_is_filtered(self):
        for name in ('playwright/driver/node.exe', 'playwright\\driver\\NODE.EXE', 'playwright/driver/node'):
            self.assertTrue(layout.omit_extra_runtime(name))
        for name in ('toolbox/runtime/node.exe', 'playwright/driver/package/cli.js', 'node_modules/node.js'):
            self.assertFalse(layout.omit_extra_runtime(name))


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / '中文 带空格'
        self.internal = bundle_fixture(self.root)

    def test_minimal_bundle_and_inventory(self):
        records = layout.validate_bundle(self.root)
        record = next(item for item in records if item['path'] == 'ScriptAllToolbox.exe')
        self.assertEqual(record['size'], len(b'fixture'))
        self.assertEqual(record['sha256'], hashlib.sha256(b'fixture').hexdigest())
        self.assertEqual(layout.inventory(self.root), records)

    def test_second_node_runtime_rejected(self):
        write(self.internal, 'playwright/driver/node.exe')
        with self.assertRaisesRegex(ValueError, 'one shared node.exe'):
            layout.validate_bundle(self.root)

    def test_second_ffmpeg_runtime_rejected(self):
        write(self.internal, 'legacy/ffmpeg.exe')
        with self.assertRaisesRegex(ValueError, 'one shared ffmpeg.exe'):
            layout.validate_bundle(self.root)

    def test_old_business_artifacts_rejected(self):
        for folder in (*layout.BUSINESS_FILES, str(Path(layout.CORE).parent)):
            for relative in ('data/task.json', 'server.js', 'node_modules/demo/index.js', 'test/demo.test.js', 'public/index.html'):
                with self.subTest(folder=folder, relative=relative):
                    extra = write(self.internal, folder + '/' + relative)
                    with self.assertRaisesRegex(ValueError, 'whitelist mismatch'):
                        layout.validate_bundle(self.root)
                    extra.unlink()

    def test_toolbox_node_and_web_extra_files_rejected(self):
        for name in ('toolbox/node/test.cjs', 'toolbox/web/old-ui.html'):
            with self.subTest(name=name):
                extra = write(self.internal, name)
                with self.assertRaisesRegex(ValueError, 'Release assets mismatch'):
                    layout.validate_bundle(self.root)
                extra.unlink()

    def test_tool_specific_install_rejected(self):
        write(self.internal, 'other-tool/node_modules/demo/package.json')
        with self.assertRaisesRegex(ValueError, 'separate node_modules'):
            layout.validate_bundle(self.root)

    def test_nested_production_dependencies_remain_allowed(self):
        write(self.internal, 'node_modules/exceljs/node_modules/demo/package.json')
        self.assertTrue(layout.validate_bundle(self.root))

    def test_missing_assets_notices_executable_and_licenses_rejected(self):
        for name in ('ScriptAllToolbox.exe', '_internal/toolbox/tools.json',
                '_internal/toolbox/THIRD_PARTY_NOTICES.md', '_internal/' + layout.CORE,
                '_internal/toolbox/release-info.json', '_internal/playwright/driver/package/cli.js',
                '_internal/toolbox/runtime/licenses/node/LICENSE',
                '_internal/toolbox/runtime/licenses/ffmpeg/COPYING.GPLv3',
                '_internal/toolbox/runtime/licenses/python/LICENSE.txt',
                '_internal/toolbox/runtime/licenses/proxy_tools/LICENSE.txt'):
            with self.subTest(name=name):
                file = self.root / name
                contents = file.read_bytes()
                file.unlink()
                with self.assertRaises(ValueError):
                    layout.validate_bundle(self.root)
                file.write_bytes(contents)

    def test_downloaded_browser_and_toolbox_tests_rejected(self):
        for name in ('toolbox/tests', 'playwright/driver/package/.local-browsers'):
            with self.subTest(name=name):
                folder = self.internal / name
                folder.mkdir(parents=True)
                with self.assertRaisesRegex(ValueError, 'Development fixtures'):
                    layout.validate_bundle(self.root)
                folder.rmdir()


class BuildContractTests(unittest.TestCase):
    def test_version_validation_and_resource_match(self):
        for version in ('0.1.0', '1.2.3', '65535.0.1'):
            self.assertEqual(layout.validate_version(version), version)
            resource = build.file_version_text(version)
            self.assertIn("StringStruct('FileVersion', '" + version + "')", resource)
            self.assertIn("StringStruct('ProductVersion', '" + version + "')", resource)
            self.assertIn('filevers=' + str(tuple(map(int, version.split('.'))) + (0,)), resource)
        for version in ('1', '1.2', '1.2.3.4', '01.2.3', '-1.2.3', '1.2.3-beta', '65536.0.0', '../1.2.3'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                layout.validate_version(version)

    def test_build_directories_are_unique_and_preserve_existing_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sentinel = write(root, 'toolbox/build/unknown/data.txt', 'keep')
            data = write(root, 'user-data/results.xlsx', 'keep')
            first = build.build_directory(root, '0.1.0')
            second = build.build_directory(root, '0.1.0')
            self.assertNotEqual(first, second)
            for work, release in (first, second):
                self.assertTrue(work.is_relative_to(root / 'toolbox/build/windows'))
                self.assertTrue(release.is_relative_to(root / 'dist/release'))
                self.assertTrue(work.is_dir())
                self.assertTrue(release.is_dir())
            self.assertEqual(sentinel.read_text(), 'keep')
            self.assertEqual(data.read_text(), 'keep')

    def test_import_does_not_build_or_create_directories(self):
        with patch('subprocess.run', side_effect=AssertionError('unexpected process')), patch.object(
                Path, 'mkdir', side_effect=AssertionError('unexpected directory')):
            importlib.reload(build)

    def test_exact_build_locks_and_runtime_versions(self):
        self.assertEqual(build.locked_versions([WINDOWS / 'requirements-build.lock.txt']), {
            'PyInstaller': '6.22.2', 'altgraph': '0.17.5', 'packaging': '26.3',
            'pefile': '2024.8.26', 'pyinstaller-hooks-contrib': '2026.7',
            'pywin32-ctypes': '0.2.3', 'setuptools': '84.0.0'})
        package = json.loads((ROOT / 'toolbox/package.json').read_text(encoding='utf-8'))
        self.assertEqual(package['engines']['node'], layout.RUNTIMES['node'])
        self.assertEqual(package['dependencies'], {'exceljs': '4.4.0', 'playwright-core': '1.58.2'})

    def test_lock_bom_does_not_change_package_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'requirements.lock.txt'
            file.write_text('bottle==0.13.4\n', encoding='utf-8-sig')
            self.assertEqual(build.locked_versions([file]), {'bottle': '0.13.4'})
        self.assertIn("read_text(encoding='utf-8-sig')", (WINDOWS / 'toolbox.spec').read_text(encoding='utf-8'))

    def test_build_uses_isolated_locks_and_records_provenance(self):
        source = (WINDOWS / 'build.py').read_text(encoding='utf-8')
        for token in ("'ci', '--omit=dev'", "'--no-audit'", "'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'",
                'requirements.lock.txt', 'requirements-build.lock.txt', 'sys.base_prefix',
                "'sourceCommit'", "'sourceDirty'", "'runtimeVersions'", "'pythonDependencies'",
                "'nodeDependencies'", "'lockSha256'", "'sha256'", "'manifest.json'", "'SHA256SUMS.txt'"):
            # Environment.update uses keyword arguments, not quoted keys.
            self.assertIn(token.strip("'") if token == "'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'" else token, source)
        for token in ('shutil.rmtree', 'os.remove', '.unlink(', 'shell=True', "'--clean'"):
            self.assertNotIn(token, source)

    def test_powershell_forwards_paths_as_array_and_verifies_microsoft(self):
        source = (WINDOWS / 'build.ps1').read_text(encoding='utf-8')
        self.assertIn('Get-AuthenticodeSignature -LiteralPath $WebView2Bootstrapper', source)
        self.assertIn("$signature.Status -ne 'Valid'", source)
        self.assertIn('Microsoft Corporation', source)
        self.assertIn('& $PythonExe @buildArguments', source)
        for token in ('NodeLicense', 'FFmpegLicense', 'BuildVenvPath'):
            self.assertIn(token, source)
        self.assertNotIn('Invoke-Expression', source)

    def test_bootstrap_and_host_use_shared_frozen_paths(self):
        source = (WINDOWS / 'bootstrap.py').read_text(encoding='utf-8')
        self.assertIn("Path(sys._MEIPASS) / 'toolbox/runtime/node.exe'", source)
        self.assertLess(source.index('PLAYWRIGHT_NODEJS_PATH'), source.index('from toolbox.desktop import main'))
        host = (ROOT / 'toolbox/host/application.py').read_text(encoding='utf-8')
        self.assertIn('ROOT = Path(__file__).resolve().parents[2]', host)
        self.assertIn("'PLAYWRIGHT_NODEJS_PATH'", host)
        instance = (ROOT / 'toolbox/host/instance.py').read_text(encoding='utf-8')
        self.assertIn(layout.INSTALL_MUTEX, instance)

    def test_build_and_release_outputs_are_ignored(self):
        ignored = (ROOT / '.gitignore').read_text(encoding='utf-8').splitlines()
        for name in ('**/build/', '**/dist/', '**/release/'):
            self.assertIn(name, ignored)


class SpecTests(unittest.TestCase):
    def test_spec_with_fake_pyinstaller_collects_one_shared_runtime(self):
        captured = {}
        hooks = types.ModuleType('PyInstaller.utils.hooks')
        hooks.collect_data_files = lambda *args, **kwargs: [('driver-source', 'playwright/driver/package')]
        hooks.copy_metadata = lambda name: [('metadata/' + name, name + '.dist-info')]

        def analysis(scripts, **kwargs):
            captured['analysis'] = kwargs
            self.assertEqual(scripts, [str(WINDOWS / 'bootstrap.py')])
            result = types.SimpleNamespace(pure=[], scripts=scripts,
                datas=[('playwright/driver/node.exe', 'private-node', 'DATA'),
                    ('playwright/driver/package/cli.js', 'cli', 'DATA')],
                binaries=[('playwright/driver/node.exe', 'private-node', 'BINARY'),
                    ('toolbox/runtime/node.exe', 'node', 'BINARY')])
            captured['result'] = result
            return result

        def executable(*args, **kwargs):
            captured['exe'] = kwargs
            return 'fake-exe'

        def collect(*args, **kwargs):
            captured['collect'] = (args, kwargs)

        environment = {'TOOLBOX_NODE_MODULES': str(ROOT / 'toolbox/build/mock/npm/node_modules'),
            'TOOLBOX_NODE_EXE': str(ROOT / 'toolbox/build/mock/node.exe'),
            'TOOLBOX_FFMPEG_EXE': str(ROOT / 'toolbox/build/mock/ffmpeg.exe'),
            'TOOLBOX_NODE_LICENSE': 'NodeLICENSE', 'TOOLBOX_FFMPEG_LICENSE': 'COPYING.GPLv3',
            'TOOLBOX_BUILD_INFO': 'release-info.json', 'TOOLBOX_VERSION_FILE': 'version-info.txt'}
        namespace = {'SPECPATH': str(WINDOWS), 'Analysis': analysis, 'PYZ': lambda pure: 'fake-pyz',
            'EXE': executable, 'COLLECT': collect}
        with patch.dict(sys.modules, {'PyInstaller': types.ModuleType('PyInstaller'),
                'PyInstaller.utils': types.ModuleType('PyInstaller.utils'),
                'PyInstaller.utils.hooks': hooks, 'layout': layout}), patch.dict('os.environ', environment), patch.object(sys, 'path', sys.path.copy()):
            exec(compile((WINDOWS / 'toolbox.spec').read_text(encoding='utf-8'), str(WINDOWS / 'toolbox.spec'), 'exec'), namespace)
        args = captured['analysis']
        self.assertEqual(args['pathex'], [str(ROOT)])
        for hidden in ('playwright.sync_api', 'webview.platforms.winforms', 'webview.platforms.edgechromium', 'pystray._win32'):
            self.assertIn(hidden, args['hiddenimports'])
        self.assertEqual(sum(destination == 'node_modules' for source, destination in args['datas']), 1)
        self.assertEqual(sum(destination == 'toolbox/runtime' for source, destination in args['datas']), 2)
        self.assertIn((environment['TOOLBOX_NODE_LICENSE'], 'toolbox/runtime/licenses/node'), args['datas'])
        self.assertIn(('metadata/playwright', 'playwright.dist-info'), args['datas'])
        for item in layout.runtime_license_datas(ROOT):
            self.assertIn(item, args['datas'])
        self.assertEqual(captured['result'].datas, [('playwright/driver/package/cli.js', 'cli', 'DATA')])
        self.assertEqual(captured['result'].binaries, [('toolbox/runtime/node.exe', 'node', 'BINARY')])
        self.assertTrue(captured['exe']['exclude_binaries'])
        self.assertFalse(captured['exe']['console'])
        self.assertEqual(captured['exe']['contents_directory'], '_internal')
        self.assertEqual(captured['exe']['version'], 'version-info.txt')
        self.assertEqual(captured['collect'][1]['name'], layout.APP_NAME)


class MockBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / '构建 空格'
        source_fixture(self.root)
        self.windows = self.root / 'toolbox/windows'
        self.windows.mkdir()
        for name in ('requirements.lock.txt', 'package-lock.json'):
            shutil.copy2(ROOT / 'toolbox' / name, self.root / 'toolbox' / name)
        shutil.copy2(WINDOWS / 'requirements-build.lock.txt', self.windows / 'requirements-build.lock.txt')
        self.venv = self.root / 'toolbox/build/venv'
        self.python = write(self.venv, 'Scripts/python.exe')
        self.node = write(self.root, '输入 node/node.exe')
        write(self.node.parent, 'node_modules/npm/bin/npm-cli.js')
        self.ffmpeg = write(self.root, '输入 ffmpeg/ffmpeg.exe')
        self.iscc = write(self.root, '编译器/ISCC.exe')
        self.bootstrapper = write(self.root, '微软/Setup.exe')
        self.node_license = write(self.root, '许可/NodeLICENSE', 'Node license')
        self.ffmpeg_license = write(self.root, '许可/GPL.txt', 'GPL license')
        self.argv = ['--version', '0.1.0', '--node', str(self.node), '--ffmpeg', str(self.ffmpeg),
            '--iscc', str(self.iscc), '--bootstrapper', str(self.bootstrapper),
            '--node-license', str(self.node_license), '--ffmpeg-license', str(self.ffmpeg_license),
            '--build-venv', str(self.venv)]
        self.commands = []
        self.compile_mode = 'success'
        self.probe = {'version': [3, 13, 2], 'x64': True, 'prefix': str(self.venv), 'base': str(self.root / 'base-python')}

    def fake_run(self, arguments, *, cwd=None, env=None, capture=False):
        command = [str(item) for item in arguments]
        self.commands.append(command)
        if command[:2] == [str(self.node), '--version']:
            return 'v24.19.0'
        if command[:2] == [str(self.node), '-p']:
            return 'x64'
        if command[:2] == [str(self.ffmpeg), '-version']:
            return 'ffmpeg version 7.1-essentials_build\nconfiguration: fixture'
        if command[:2] == [str(self.python), '-c']:
            if 'sys.base_prefix' in command[2]:
                return json.dumps(self.probe)
            return json.dumps(build.locked_versions([self.root / 'toolbox/requirements.lock.txt',
                self.windows / 'requirements-build.lock.txt']))
        if command[:2] == ['git', 'rev-parse']:
            return 'fixture-commit'
        if command[:2] == ['git', 'status']:
            return ' M fixture.js'
        if command[1:3] == ['-m', 'PyInstaller']:
            self.app_dir = Path(command[command.index('--distpath') + 1]) / layout.APP_NAME
            internal = bundle_fixture(self.app_dir)
            shutil.copy2(env['TOOLBOX_BUILD_INFO'], internal / 'toolbox/release-info.json')
            shutil.copy2(env['TOOLBOX_NODE_LICENSE'], internal / 'toolbox/runtime/licenses/node/LICENSE')
            shutil.copy2(env['TOOLBOX_FFMPEG_LICENSE'], internal / 'toolbox/runtime/licenses/ffmpeg/COPYING.GPLv3')
            self.assertEqual(Path(env['TOOLBOX_NODE_LICENSE']).name, 'LICENSE')
            self.assertEqual(Path(env['TOOLBOX_FFMPEG_LICENSE']).name, 'COPYING.GPLv3')
            self.assertEqual(env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'], '1')
            return None
        if command[0] == str(self.iscc):
            self.assertIn('/Qp', command)
            if self.compile_mode == 'failure':
                raise subprocess.CalledProcessError(2, command)
            output = Path(next(item.partition('=')[2] for item in command if item.startswith('/DOutputDir=')))
            if self.compile_mode == 'missing':
                return None
            write(output, 'ScriptAllToolbox-0.1.0-windows-x64.exe', 'setup fixture')
            return None
        if command[1:3] == ['-m', 'pip'] or 'ci' in command:
            return None
        self.fail('Unexpected simulated command: ' + str(command))

    def invoke(self):
        with patch.object(build, 'ROOT', self.root), patch.object(build, 'WINDOWS', self.windows), patch.object(
                build, 'run', side_effect=self.fake_run), patch('builtins.print') as output, patch(
                'subprocess.run', side_effect=AssertionError('real process forbidden')):
            build.main(self.argv)
            return Path(output.call_args.args[0])

    def test_mocked_pipeline_writes_version_commit_hashes_and_preserves_locks(self):
        lock = self.root / 'toolbox/package-lock.json'
        original = lock.read_bytes()
        release = self.invoke()
        manifest = json.loads((release / 'manifest.json').read_text(encoding='utf-8'))
        info = json.loads((self.app_dir / '_internal/toolbox/release-info.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['version'], info['version'])
        self.assertEqual(manifest['version'], '0.1.0')
        self.assertEqual(manifest['sourceCommit'], 'fixture-commit')
        self.assertTrue(manifest['sourceDirty'])
        self.assertEqual(manifest['inputs']['nodeLicense']['sha256'], layout.sha256(self.node_license))
        self.assertEqual(manifest['inputs']['innoCompiler']['sha256'], layout.sha256(self.iscc))
        self.assertEqual(manifest['lockSha256']['package-lock.json'], layout.sha256(lock))
        self.assertEqual(lock.read_bytes(), original)
        self.assertEqual(manifest['installer']['sha256'], layout.sha256(release / manifest['installer']['path']))
        self.assertEqual((self.app_dir / '_internal/toolbox/runtime/licenses/node/LICENSE').read_text(), 'Node license')
        for line in (release / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
            digest, relative = line.split('  ', 1)
            self.assertEqual(digest, layout.sha256(release / relative))
        self.assertTrue(any('ci' in command and '--omit=dev' in command for command in self.commands))

    def test_failed_compiler_does_not_publish_final_manifest(self):
        self.compile_mode = 'failure'
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke()
        release = self.app_dir.parents[1]
        self.assertFalse((release / 'manifest.json').exists())
        self.assertFalse((release / 'SHA256SUMS.txt').exists())
        self.assertTrue((self.app_dir / 'ScriptAllToolbox.exe').is_file())

    def test_compiler_success_without_installer_does_not_publish_manifest(self):
        self.compile_mode = 'missing'
        with self.assertRaisesRegex(ValueError, 'Expected one setup executable'):
            self.invoke()
        release = self.app_dir.parents[1]
        self.assertFalse((release / 'manifest.json').exists())
        self.assertFalse((release / 'SHA256SUMS.txt').exists())

    def test_wrong_version_or_base_environment_rejected_before_install(self):
        for update in ({'version': [3, 12, 0]}, {'x64': False}, {'prefix': self.probe['base']}, {'base': self.probe['prefix']}):
            with self.subTest(update=update):
                original = self.probe.copy()
                self.probe.update(update)
                self.commands.clear()
                with self.assertRaisesRegex(ValueError, 'Build venv must be isolated'):
                    self.invoke()
                self.assertFalse(any(command[1:3] == ['-m', 'pip'] for command in self.commands))
                self.probe = original


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (WINDOWS / 'installer.iss').read_text(encoding='utf-8')
        cls.active = '\n'.join(line for line in cls.source.splitlines() if not line.lstrip().startswith('//'))

    def test_per_user_x64_version_and_fixed_mutex(self):
        for token in ('PrivilegesRequired=lowest', 'ArchitecturesAllowed=x64os',
                'ArchitecturesInstallIn64BitMode=x64os', 'MinVersion=10.0',
                'DefaultDirName={localappdata}\\Programs\\ScriptAllToolbox',
                'AppVersion={#AppVersion}', 'UsePreviousAppDir=yes',
                'AppMutex=' + layout.INSTALL_MUTEX,
                'CloseApplications=no', 'RestartApplications=no'):
            self.assertIn(token, self.active)
        self.assertNotIn('UninstallAppMutex=', self.active)

    def test_upgrade_uninstall_preserves_user_data_and_never_kills(self):
        for token in ('[UninstallDelete]', '[InstallDelete]', 'taskkill', 'TerminateProcess', 'DelTree', 'RemoveDir'):
            self.assertNotIn(token.lower(), self.active.lower())
        self.assertIn("ExpandConstant('{localappdata}\\ScriptAllToolbox')", self.active)
        self.assertIn('Result := Pos(DataRoot, AppRoot) = 1;', self.active)

    def test_silent_dir_override_has_same_data_guard_before_webview_install(self):
        wizard = self.active[self.active.index('function NextButtonClick('):self.active.index('function PrepareToInstall(')]
        prepare = self.active[self.active.index('function PrepareToInstall('):]
        self.assertIn('and DataDirectoryConflict then', wizard)
        self.assertIn('if DataDirectoryConflict then begin', prepare)
        self.assertLess(prepare.index('if DataDirectoryConflict then'), prepare.index('if HasWebView2 then exit;'))

    def test_webview_detection_skip_and_non_elevated_bootstrapper(self):
        self.assertIn('{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', self.active)
        for hive in ('HKCU32', 'HKCU64', 'HKLM32', 'HKLM64'):
            self.assertIn('HasRuntimeIn(' + hive + ')', self.active)
        self.assertIn("(Version <> '') and (Version <> '0.0.0.0')", self.active)
        self.assertLess(self.active.index('if HasWebView2 then exit;'), self.active.index('ExtractTemporaryFile('))
        self.assertIn("'/silent /install'", self.active)
        self.assertIn('if not HasWebView2 then', self.active)
        self.assertNotIn("'runas'", self.active)

    def test_registry_root_type_matches_pinned_inno_6_7_3(self):
        self.assertRegex(self.active, r'function\s+HasRuntimeIn\(Hive:\s*Integer\):\s*Boolean;')
        self.assertNotRegex(self.active, r'\bHKEY\b')
        readme = (WINDOWS / 'README.md').read_text(encoding='utf-8')
        self.assertIn('https://github.com/jrsoftware/issrc/blob/is-6_7_3/Projects/Src/Shared.ScriptFunc.pas', readme)
        self.assertIn('const RootKey: Integer', readme)

    def test_missing_edge_uses_official_link(self):
        self.assertIn('https://www.microsoft.com/edge/download', self.active)
        self.assertIn('if not HasEdge then', self.active)


if __name__ == '__main__':
    unittest.main()
