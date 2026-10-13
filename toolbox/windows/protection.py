"""Build-only conservative JavaScript processing; source tree stays untouched."""
import json
import shutil
from pathlib import Path

try:
    from .layout import FROZEN_DATA_FILES, sha256
except ImportError:
    from layout import FROZEN_DATA_FILES, sha256


def prepare(root, work, node, npm_cli, environment, run):
    root, work = Path(root), Path(work)
    project = work / 'protection-tool'
    project.mkdir()
    for name in ('package.json', 'package-lock.json', 'protect.cjs'):
        shutil.copy2(root / 'toolbox/windows/protection' / name, project / name)
    run([node, npm_cli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=project, env=environment)
    stage = work / 'protected-source'
    for relative in FROZEN_DATA_FILES:
        destination = stage / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, destination)
    scripts = [relative for relative in FROZEN_DATA_FILES if Path(relative).suffix in ('.js', '.cjs')]
    inputs = work / 'protection-files.json'
    inputs.write_text(json.dumps(scripts, ensure_ascii=False), encoding='utf-8')
    run([node, project / 'protect.cjs', stage, inputs], env=environment)
    return stage, {'level': 'basic', 'javascriptObfuscator': '4.1.1',
                   'pythonCore': 'PyInstaller bytecode (not native compilation)',
                   'lockSha256': sha256(project / 'package-lock.json'), 'scripts': len(scripts)}
