from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
from threading import Lock


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Events:
    def __init__(self, capacity=1000):
        self._events = deque(maxlen=capacity)
        self._seq = 0
        self._lock = Lock()

    def emit(self, event_type, data, task_id=None):
        with self._lock:
            self._seq += 1
            event = {"seq": self._seq, "type": event_type, "at": now(), "data": deepcopy(data)}
            if task_id:
                event["taskId"] = task_id
            self._events.append(event)
            return deepcopy(event)

    def read(self, after_seq=0, limit=100):
        if type(after_seq) is not int or after_seq < 0 or type(limit) is not int or not 1 <= limit <= 1000:
            raise ValueError("无效的事件分页参数")
        with self._lock:
            reset = after_seq > self._seq or bool(self._events and after_seq < self._events[0]["seq"] - 1)
            entries = [] if reset else [e for e in self._events if e["seq"] > after_seq][:limit]
            return {"events": deepcopy(entries), "seq": self._seq, "resetRequired": reset,
                    "nextSeq": entries[-1]["seq"] if entries else (self._seq if reset else after_seq)}
