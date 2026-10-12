import os
import subprocess
import tempfile
from pathlib import Path

from .errors import ToolboxError
from .processes import start_process


class VideoValidator:
    def __init__(self, ffmpeg, scratch):
        self.ffmpeg, self.scratch = Path(ffmpeg), Path(scratch)

    def __call__(self, path):
        if not self.ffmpeg.is_file():
            raise ToolboxError('MEDIA_UNAVAILABLE', '视频处理组件缺失，请重新安装工具箱。')
        with tempfile.TemporaryFile(dir=self.scratch) as diagnostics:
            process, job = start_process(
                [str(self.ffmpeg), '-nostdin', '-v', 'error', '-xerror',
                 '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov', '-i', str(path),
                 '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=diagnostics,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            try:
                process.wait(timeout=30)
                if process.returncode:
                    raise ToolboxError('MEDIA_UNAVAILABLE', '结果文件不包含可读取的视频画面。', retryable=True)
            except subprocess.TimeoutExpired as exc:
                raise ToolboxError('MEDIA_UNAVAILABLE', '视频检查超时，请重新下载该条目。', retryable=True) from exc
            finally:
                job.close()
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
