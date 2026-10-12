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

    def reserve(self, owner):
        ticket = {"owner": owner, "leaseId": uuid4().hex}
        with self._condition:
            self._pending.append(ticket)
            self._condition.notify_all()
        return ticket

    def withdraw(self, ticket):
        with self._condition:
            if ticket in self._pending:
                self._pending.remove(ticket)
                self._condition.notify_all()

    @contextmanager
    def lease(self, owner, cancelled=lambda: False, reservation=None):
        ticket = reservation if reservation is not None else self.reserve(owner)
        with self._condition:
            if ticket not in self._pending or ticket['owner'] != owner:
                raise ToolboxError('INVALID_PARAMETERS', '资源排队凭据无效。')
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
