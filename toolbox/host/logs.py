import json
import re
from threading import RLock

from .events import now
from .store import page


def redact(message):
    text = str(message)
    text = re.sub(r'''(?i)["']?(cookie|authorization|access[_-]?token|sessionid)["']?\s*[:=].*''', r'\1: [已隐藏]', text)
    text = re.sub(r'https?://[^\s<>"\']+', '[链接已隐藏]', text)
    return text[:8192]


class Logs:
    def __init__(self, paths, *, chunk_bytes=5 * 1024 * 1024, files=10):
        self.paths = paths
        self.chunk_bytes, self.files = chunk_bytes, files
        self._lock = RLock()
        self._seq = 0
        self.directory = paths.resolve('logs')
        self.directory.mkdir(parents=True, exist_ok=True)
        for path in self.directory.glob('events.*.ndjson'):
            with path.open(encoding='utf-8', errors='replace') as stream:
                for line in stream:
                    try:
                        entry = json.loads(line)
                        if type(entry) is dict and type(entry.get('seq')) is int:
                            self._seq = max(self._seq, entry['seq'])
                    except ValueError:
                        continue

    def _file(self, index):
        return self.paths.resolve(f'logs/events.{index}.ndjson')

    def write(self, message, task_id=None, level='info'):
        with self._lock:
            self._seq += 1
            entry = {'seq': self._seq, 'at': now(), 'taskId': task_id, 'level': level, 'message': redact(message)}
            line = (json.dumps(entry, ensure_ascii=False) + '\n').encode('utf-8')
            if len(line) > self.chunk_bytes:
                entry['message'] = '[日志超过单文件大小限制]'
                line = (json.dumps(entry, ensure_ascii=False) + '\n').encode('utf-8')
            current = self._file(0)
            if current.exists() and current.stat().st_size + len(line) > self.chunk_bytes:
                self._file(self.files - 1).unlink(missing_ok=True)
                for index in range(self.files - 2, -1, -1):
                    source = self._file(index)
                    if source.exists():
                        source.replace(self._file(index + 1))
            with current.open('ab') as stream:
                stream.write(line)

    def read(self, task_id, after_seq=0, limit=100):
        page(after_seq, limit, 200)
        with self._lock:
            entries = []
            oldest = None
            for index in range(self.files - 1, -1, -1):
                path = self._file(index)
                if not path.exists():
                    continue
                with path.open(encoding='utf-8', errors='replace') as stream:
                    for line in stream:
                        try:
                            entry = json.loads(line)
                        except ValueError:
                            continue
                        if type(entry) is not dict or type(entry.get('seq')) is not int or 'taskId' not in entry:
                            continue
                        oldest = entry['seq'] if oldest is None else oldest
                        if entry['seq'] > after_seq and entry['taskId'] == task_id:
                            entries.append(entry)
                            if len(entries) == limit:
                                return {'items': entries, 'nextSeq': entry['seq'], 'rotated': after_seq < oldest - 1}
            return {'items': entries, 'nextSeq': self._seq,
                    'rotated': oldest is not None and after_seq < oldest - 1}
