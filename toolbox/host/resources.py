from collections import deque
from contextlib import contextmanager
from threading import Condition
from uuid import uuid4

from .errors import ToolboxError


class ResourceQueue:
    """In-process FIFO lease, held through pause and released by the operation owner."""

    def __init__(self):
        self._condition = Condition()
        self._pending = deque()
        self._holder = None

    def state(self):
        with self._condition:
            return {"holder": self._holder.copy() if self._holder else None,
                    "waiting": [item.copy() for item in self._pending]}

    @contextmanager
    def lease(self, owner, cancelled=lambda: False):
        ticket = {"owner": owner, "leaseId": uuid4().hex}
        with self._condition:
            self._pending.append(ticket)
            try:
                while self._holder is not None or self._pending[0] is not ticket:
                    if cancelled():
                        raise ToolboxError("CANCELLED", "操作已停止。")
                    self._condition.wait(0.1)
                if cancelled():
                    raise ToolboxError("CANCELLED", "操作已停止。")
                self._pending.popleft()
                self._holder = ticket
            except BaseException:
                self._pending.remove(ticket)
                self._condition.notify_all()
                raise
        try:
            yield ticket.copy()
        finally:
            with self._condition:
                self._holder = None
                self._condition.notify_all()
