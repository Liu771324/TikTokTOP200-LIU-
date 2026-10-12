import json
from pathlib import Path

from .errors import ToolboxError
from .events import now
from .paths import atomic_json

TRANSITIONS = {
    "queued": {"running", "cancelled", "failed"},
    "running": {"pausing", "waiting_user", "stopping", "completed", "completed_with_errors", "failed", "interrupted"},
    "pausing": {"paused", "stopping", "completed", "completed_with_errors", "failed", "interrupted"},
    "paused": {"running", "stopping", "interrupted"},
    "waiting_user": {"running", "stopping", "interrupted"},
    "stopping": {"cancelled", "failed", "interrupted"},
    "cancelled": {"queued"}, "interrupted": {"queued"}, "failed": {"queued"},
    "completed_with_errors": {"queued"}, "completed": set(),
}
ACTIVE = {"queued", "running", "pausing", "paused", "waiting_user", "stopping"}
RECOVERABLE = ACTIVE - {"queued"}


def save_state(path, context, state):
    atomic_json(path, {"formatVersion": 1, "toolId": context["toolId"],
                       "taskId": context["taskId"], "attempt": context["attempt"],
                       "savedAt": now(), "state": state})


def load_state(path, task_id, tool_id):
    try:
        envelope = json.loads(Path(path).read_text(encoding="utf-8"))
        if (envelope["formatVersion"] != 1 or envelope["taskId"] != task_id
                or envelope["toolId"] != tool_id or type(envelope["state"]) is not dict
                or type(envelope["attempt"]) is not int or envelope["attempt"] < 1
                or not isinstance(envelope["savedAt"], str)):
            raise ValueError("identity mismatch")
        return envelope
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ToolboxError("STATE_CORRUPT", "任务进度文件不可读取，已保留原文件和结果。") from exc
