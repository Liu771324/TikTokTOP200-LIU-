import json
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from .errors import ToolboxError


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".state-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def display_filename(name, suffix=""):
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name)).strip(" .")[:120]
    if not clean or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", clean, re.I):
        clean = "结果_" + clean
    return clean + suffix


@dataclass(frozen=True)
class DataPaths:
    root: Path

    def __post_init__(self):
        object.__setattr__(self, "root", Path(self.root).resolve())

    @classmethod
    def default(cls):
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            raise ToolboxError("INVALID_PARAMETERS", "无法找到当前用户的本地数据目录。")
        return cls(Path(base) / "ScriptAllToolbox")

    def initialize(self):
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ("tasks", "media", "scratch", "logs", "browser-profile"):
            self.resolve(name).mkdir(exist_ok=True)

    def resolve(self, relative):
        raw = str(relative)
        win = PureWindowsPath(raw)
        if not raw or win.root or win.drive or any(":" in part for part in win.parts) or ".." in win.parts or ".." in Path(raw).parts:
            raise ToolboxError("INVALID_PARAMETERS", "文件不在工具箱的数据目录内。")
        candidate = self.root.joinpath(raw).absolute()
        component = self.root
        for part in candidate.relative_to(self.root).parts:
            component /= part
            try:
                info = component.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ToolboxError("INVALID_PARAMETERS", "工具箱内部目录不能使用链接或重解析路径。")
        # resolve follows junctions/symlinks, including existing parent components.
        try:
            candidate.resolve().relative_to(self.root.resolve())
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise ToolboxError("INVALID_PARAMETERS", "文件不在工具箱的数据目录内。") from exc
        return candidate

    def relative(self, path):
        try:
            relative = Path(path).absolute().relative_to(self.root)
        except ValueError as exc:
            raise ToolboxError("INVALID_PARAMETERS", "文件不在工具箱的数据目录内。") from exc
        self.resolve(relative)
        return relative.as_posix()

    def task_context(self, task, ffmpeg_path, browser=None):
        task_id = task["id"]
        if not re.fullmatch(r"[a-f0-9]{32}", task_id):
            raise ToolboxError("INVALID_PARAMETERS", "任务标识无效。")
        task_root = self.resolve(f"tasks/{task_id}")
        scratch = self.resolve(f"scratch/{task_id}")
        staging = self.resolve(f"tasks/{task_id}/staging")
        control = self.resolve(f"tasks/{task_id}/control")
        state_path = self.resolve(f"tasks/{task_id}/engine-state.json")
        for directory in (task_root, scratch, staging, control):
            directory.mkdir(parents=True, exist_ok=True)
        return {"protocolVersion": 1, "taskId": task_id, "attempt": task["attempt"],
                "toolId": task["toolId"], "parameterVersion": task["parameterVersion"],
                "dataRoot": str(self.root), "taskRoot": str(task_root),
                "statePath": str(state_path),
                "scratchRoot": str(scratch), "artifactStagingRoot": str(staging),
                "controlRoot": str(control), "ffmpegPath": str(ffmpeg_path), "browser": browser}
