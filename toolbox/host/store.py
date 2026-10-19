import hashlib
import json
import mimetypes
import os
import shutil
import sqlite3
import time
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from threading import RLock
from uuid import uuid4

from .errors import ToolboxError
from .events import now
from .paths import display_filename
from .paths import atomic_json
from .state import ACTIVE, RECOVERABLE, TRANSITIONS
from .fingerprints import best_match, validate_fingerprint

TOOLS = {"business-center", "top200", "video-ranking", "manual-video", "product-title"}


def file_operation(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        with self._lock:
            if self._transaction_depth:
                raise ToolboxError("UNSUPPORTED_OPERATION", "文件操作不能嵌套在未提交的事务中。")
        with self._files_lock:
            return method(self, *args, **kwargs)
    return guarded


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def atomic_copy(source, destination):
    temporary = destination.with_name(destination.name + '.registering')
    try:
        with source.open('rb') as input_stream, temporary.open('wb') as output_stream:
            shutil.copyfileobj(input_stream, output_stream)
            output_stream.flush()
            os.fsync(output_stream.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def page(offset, limit, maximum=100):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= maximum:
        raise ToolboxError("INVALID_PARAMETERS", "分页参数无效。")


class Store:
    def __init__(self, paths):
        self.paths = paths
        paths.initialize()
        self._lock = RLock()
        self._files_lock = RLock()
        self._db = sqlite3.connect(paths.root / "toolbox.sqlite3", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        version_table = self._db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'").fetchone()
        if version_table:
            versions = self._db.execute("SELECT version FROM schema_meta").fetchall()
            if len(versions) != 1 or versions[0][0] != 1:
                self._db.close()
                raise ToolboxError("STATE_CORRUPT", "当前数据版本不受支持。")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
            INSERT INTO schema_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_meta);
            CREATE TABLE IF NOT EXISTS tasks(
                id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, parameter_version INTEGER NOT NULL,
                parameters_json TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
                progress_json TEXT NOT NULL, error_json TEXT, state_relpath TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS artifacts(
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT, relpath TEXT UNIQUE NOT NULL,
                size INTEGER NOT NULL, mime TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS video_hash ON artifacts(sha256) WHERE kind='video';
            CREATE TABLE IF NOT EXISTS task_artifacts(
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                artifact_id TEXT NOT NULL REFERENCES artifacts(id), candidate_id TEXT NOT NULL,
                role TEXT NOT NULL, display_name TEXT NOT NULL, metadata_json TEXT NOT NULL,
                registration_json TEXT NOT NULL, PRIMARY KEY(task_id,candidate_id));
            CREATE TABLE IF NOT EXISTS capture_items(
                id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, source_kind TEXT NOT NULL,
                source_page TEXT NOT NULL, provider_id TEXT, title TEXT NOT NULL, public_url TEXT,
                link_kind TEXT NOT NULL, locator_json TEXT NOT NULL, captured_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS capture_item_details(
                item_id TEXT PRIMARY KEY REFERENCES capture_items(id) ON DELETE CASCADE,
                metadata_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pending_task_deletions(task_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS artifact_fingerprints(
                artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
                algorithm_version INTEGER NOT NULL, fingerprint_json TEXT NOT NULL);
        """)
        if self._db.execute("SELECT version FROM schema_meta").fetchone()[0] != 1:
            self._db.close()
            raise ToolboxError("STATE_CORRUPT", "当前数据版本不受支持。")
        self._db.commit()
        self._previews = {}
        self._transaction_depth = 0

    @contextmanager
    def transaction(self):
        with self._lock:
            depth = self._transaction_depth
            savepoint = f"nested_{depth}"
            if depth:
                self._db.execute(f"SAVEPOINT {savepoint}")
            else:
                self._db.execute("BEGIN")
            self._transaction_depth += 1
            try:
                yield self._db
                if depth:
                    self._db.execute(f"RELEASE SAVEPOINT {savepoint}")
                else:
                    self._db.commit()
            except BaseException:
                if depth:
                    self._db.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    self._db.execute(f"RELEASE SAVEPOINT {savepoint}")
                else:
                    self._db.rollback()
                raise
            finally:
                self._transaction_depth -= 1

    def close(self):
        with self._lock:
            self._db.close()

    def create_task(self, tool_id, parameters):
        if tool_id not in TOOLS or type(parameters) is not dict:
            raise ToolboxError("INVALID_PARAMETERS", "工具或任务参数无效。")
        task_id = uuid4().hex
        at = now()
        with self.transaction() as db:
            db.execute("INSERT INTO tasks VALUES(?,?,1,?,'queued',1,'{}',NULL,?,?,?)",
                       (task_id, tool_id, encode(parameters), f"tasks/{task_id}/engine-state.json", at, at))
        return self.task(task_id)

    @staticmethod
    def _task(row):
        return {"id": row["id"], "toolId": row["tool_id"], "parameterVersion": row["parameter_version"],
                "parameters": json.loads(row["parameters_json"]), "state": row["state"],
                "attempt": row["attempt"], "progress": json.loads(row["progress_json"]),
                "error": json.loads(row["error_json"]) if row["error_json"] else None,
                "createdAt": row["created_at"], "updatedAt": row["updated_at"]}

    def task(self, task_id):
        with self._lock:
            row = self._db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise ToolboxError("INVALID_PARAMETERS", "任务不存在。")
            return self._task(row)

    def list_tasks(self, *, offset=0, limit=20, tool_id=None, state=None):
        page(offset, limit)
        conditions, parameters = [], []
        for column, value in (("tool_id", tool_id), ("state", state)):
            if value is not None:
                conditions.append(f"{column}=?")
                parameters.append(value)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        with self._lock:
            total = self._db.execute("SELECT count(*) FROM tasks" + where, parameters).fetchone()[0]
            rows = self._db.execute("SELECT * FROM tasks" + where + " ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?",
                                    [*parameters, limit, offset]).fetchall()
            return {"items": [self._task(r) for r in rows], "total": total, "offset": offset}

    def transition(self, task_id, state, *, attempt=None, progress=None, error=None):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise ToolboxError("INVALID_PARAMETERS", "任务不存在。")
            if attempt is not None and row["attempt"] != attempt:
                return False
            if state not in TRANSITIONS or (row["state"] != state and state not in TRANSITIONS[row["state"]]):
                raise ToolboxError("UNSUPPORTED_OPERATION", "当前任务状态不支持此操作。")
            next_attempt = row["attempt"] + int(state == "queued" and row["state"] != "queued")
            db.execute("UPDATE tasks SET state=?,attempt=?,progress_json=?,error_json=?,updated_at=? WHERE id=?",
                       (state, next_attempt, encode(progress) if progress is not None else row["progress_json"],
                        encode(error) if error else None, now(), task_id))
        return True

    def update_progress(self, task_id, attempt, progress):
        with self.transaction() as db:
            row = db.execute("SELECT state,attempt FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None or row['attempt'] != attempt or row['state'] not in ACTIVE:
                return False
            db.execute("UPDATE tasks SET progress_json=?,updated_at=? WHERE id=?",
                       (encode(progress), now(), task_id))
        return True

    def recover(self):
        with self.transaction() as db:
            marks = ",".join("?" for _ in RECOVERABLE)
            ids = [r[0] for r in db.execute(f"SELECT id FROM tasks WHERE state IN ({marks})", tuple(RECOVERABLE))]
            db.execute(f"UPDATE tasks SET state='interrupted',error_json=?,updated_at=? WHERE state IN ({marks})",
                       (encode({"code": "WORKER_EXITED", "message": "上次运行被中断，可从已保存进度恢复。"}), now(), *RECOVERABLE))
        return ids

    def artifacts(self, task_id, offset=0, limit=50):
        page(offset, limit, 200)
        with self._lock:
            total = self._db.execute("SELECT count(*) FROM task_artifacts WHERE task_id=?", (task_id,)).fetchone()[0]
            rows = self._db.execute("""SELECT a.*,r.role,r.display_name,r.metadata_json FROM task_artifacts r
                JOIN artifacts a ON a.id=r.artifact_id WHERE r.task_id=? ORDER BY r.rowid LIMIT ? OFFSET ?""",
                                    (task_id, limit, offset)).fetchall()
            return {"items": [{"id": r["id"], "kind": r["kind"], "size": r["size"], "status": r["status"],
                               "role": r["role"], "displayName": r["display_name"],
                               "metadata": json.loads(r["metadata_json"])} for r in rows], "total": total}

    def artifact_path(self, artifact_id):
        with self._lock:
            row = self._db.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
            if row is None or row["status"] != "ready":
                raise ToolboxError("ARTIFACT_MISSING", "结果文件不可用。")
            path = self.paths.resolve(row["relpath"])
            if not path.is_file():
                with self.transaction() as db:
                    db.execute("UPDATE artifacts SET status='missing' WHERE id=?", (artifact_id,))
                raise ToolboxError("ARTIFACT_MISSING", "结果文件已被移动或删除。")
            return path

    def media_index(self):
        with self._lock:
            rows = self._db.execute('''SELECT a.id,a.sha256,a.size,a.relpath,f.fingerprint_json
                FROM artifacts a JOIN artifact_fingerprints f ON f.artifact_id=a.id
                WHERE a.status='ready' AND f.algorithm_version=1 ORDER BY a.rowid''').fetchall()
        return [{'artifactId': r['id'], 'sha256': r['sha256'], 'size': r['size'],
                 'fingerprint': json.loads(r['fingerprint_json'])}
                for r in rows if (path := self.paths.resolve(r['relpath'])).is_file()
                and path.stat().st_size == r['size']]

    def registered(self, task_id, candidate_id):
        with self._lock:
            row = self._db.execute('''SELECT r.registration_json,a.status,a.relpath,a.size FROM task_artifacts r
                JOIN artifacts a ON a.id=r.artifact_id WHERE task_id=? AND candidate_id=?''',
                                   (task_id, candidate_id)).fetchone()
            if row and row['status'] == 'ready':
                path = self.paths.resolve(row['relpath'])
                if path.is_file() and path.stat().st_size == row['size']:
                    return json.loads(row['registration_json'])
            return None

    def update_metadata(self, task_id, attempt, candidate_id, metadata):
        limits = {'title': 2000, 'caption': 20000}
        if (not isinstance(candidate_id, str) or not 1 <= len(candidate_id) <= 200
                or type(metadata) is not dict or not metadata or metadata.keys() - limits.keys()
                or any(not isinstance(value, str) or not value.strip() or len(value) > limits[key]
                       for key, value in metadata.items())):
            raise ToolboxError('INVALID_PARAMETERS', '仅可更新非空的视频标题和文案，且不能超过长度限制。')
        with self.transaction() as db:
            task = self.task(task_id)
            if task['attempt'] != attempt or task['state'] not in ACTIVE:
                raise ToolboxError('UNSUPPORTED_OPERATION', '元数据不属于当前执行。')
            if task['state'] == 'stopping':
                raise ToolboxError('CANCELLED', '操作已停止。')
            row = db.execute('''SELECT r.metadata_json,r.registration_json,a.kind FROM task_artifacts r
                JOIN artifacts a ON a.id=r.artifact_id WHERE r.task_id=? AND r.candidate_id=?''',
                             (task_id, candidate_id)).fetchone()
            if row is None or row['kind'] != 'video':
                raise ToolboxError('INVALID_PARAMETERS', '当前任务没有此视频结果引用。')
            updated = {**json.loads(row['metadata_json']), **metadata}
            db.execute('UPDATE task_artifacts SET metadata_json=? WHERE task_id=? AND candidate_id=?',
                       (encode(updated), task_id, candidate_id))
            return json.loads(row['registration_json'])

    @file_operation
    def register(self, task_id, attempt, candidate, *, validate_video=None, visual_match=None):
        candidate_id = candidate.get("candidateId")
        if not isinstance(candidate_id, str) or not 1 <= len(candidate_id) <= 200:
            raise ToolboxError("INVALID_PARAMETERS", "结果候选标识无效。")
        metadata_json = encode(candidate.get("metadata", {}))
        replace_role = candidate.get('replaceRole', False)
        if type(replace_role) is not bool or (replace_role and candidate.get('kind') not in {'excel', 'text'}):
            raise ToolboxError('INVALID_PARAMETERS', '仅报表和文本结果可替换同任务角色。')
        fingerprint = candidate.get('fingerprint')
        validate_fingerprint(fingerprint)
        display_name = display_filename(candidate.get("displayName", "结果"))
        self.task(task_id)
        old_intent = self.paths.resolve(f"tasks/{task_id}/control/register-{hashlib.sha256(candidate_id.encode()).hexdigest()}.json")
        if old_intent.exists():
            self.reconcile()
        journal = None
        repair_reference = False
        with self._lock:
            task = self.task(task_id)
            if task["attempt"] != attempt or task["state"] not in ACTIVE:
                raise ToolboxError("UNSUPPORTED_OPERATION", "结果不属于当前执行。")
            existing = self._db.execute("SELECT registration_json FROM task_artifacts WHERE task_id=? AND candidate_id=?",
                                  (task_id, candidate_id)).fetchone()
            if existing:
                previous = json.loads(existing[0])
                valid_existing = self.registered(task_id, candidate_id)
                if valid_existing and (not replace_role or previous.get('registeredAttempt') == attempt):
                    return previous
                repair_reference = True
        source = self.paths.resolve(candidate.get("relpath", ""))
        staging = self.paths.resolve(f"tasks/{task_id}/staging")
        try:
            source.resolve().relative_to(staging.resolve())
        except ValueError as exc:
            raise ToolboxError("INVALID_PARAMETERS", "候选文件不属于当前任务。") from exc
        if not source.is_file() or source.stat().st_size == 0:
            raise ToolboxError("MEDIA_UNAVAILABLE", "结果文件为空或不存在。")
        before = source.stat()
        kind = candidate.get("kind")
        if kind not in {"video", "excel", "text"}:
            raise ToolboxError("INVALID_PARAMETERS", "结果类型无效。")
        if kind == "video":
            if validate_video is None:
                raise ToolboxError("MEDIA_UNAVAILABLE", "视频检查器尚未就绪。")
            validate_video(source)
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if (source.stat().st_mtime_ns, source.stat().st_size) != (before.st_mtime_ns, before.st_size):
            raise ToolboxError('MEDIA_UNAVAILABLE', '候选文件仍在变化，请等待下载结束。')
        with self._lock:
            match = self._db.execute("SELECT * FROM artifacts WHERE kind='video' AND sha256=?", (digest,)).fetchone() if kind == "video" else None
        disposition = "exact_reuse" if match else "created"
        match_data = {}
        if not match and kind == "video" and task["toolId"] == "video-ranking":
            matched = visual_match(fingerprint) if visual_match else best_match(fingerprint, self.media_index())
            if matched:
                with self._lock:
                    match = self._db.execute("SELECT * FROM artifacts WHERE id=? AND kind='video' AND status='ready'", (matched["artifactId"],)).fetchone()
                if match and (matched_path := self.paths.resolve(match["relpath"])).is_file() and matched_path.stat().st_size == match['size']:
                    disposition = "visual_reuse"
                    match_data = {"matchReason": matched["matchReason"], "matchPercent": matched["matchPercent"]}
                else:
                    match = None
        artifact_id = match['id'] if match else uuid4().hex
        artifact_hash = match['sha256'] if match else digest
        text_suffix = source.suffix.lower() if source.suffix.lower() in {'.json', '.md'} else '.txt'
        suffix = {"video": ".mp4", "excel": ".xlsx", "text": text_suffix}[kind]
        relative = match['relpath'] if match else f"media/{digest}.mp4" if kind == 'video' else f"tasks/{task_id}/results/{artifact_id}{suffix}"
        destination = self.paths.resolve(relative)
        repair = match and disposition == 'exact_reuse' and (match['status'] != 'ready' or not destination.is_file() or destination.stat().st_size != match['size'])
        if not match or repair:
            destination.parent.mkdir(parents=True, exist_ok=True)
            journal = old_intent
            atomic_json(journal, {"source": candidate["relpath"], "destination": relative, "artifactId": artifact_id})
            atomic_copy(source, destination)
        result = {"artifactId": artifact_id, "disposition": disposition, "candidateSha256": digest,
                  "artifactSha256": artifact_hash, **match_data}
        if replace_role:
            result['registeredAttempt'] = attempt
        with self.transaction() as db:
            current = self.task(task_id)
            if current['attempt'] != attempt or current['state'] not in ACTIVE:
                raise ToolboxError('UNSUPPORTED_OPERATION', '结果不属于当前执行。')
            if not match:
                db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?)",
                           (artifact_id, kind, digest, relative, destination.stat().st_size,
                            mimetypes.guess_type(destination)[0], "ready", now()))
            elif repair:
                db.execute("UPDATE artifacts SET status='ready',size=? WHERE id=?", (destination.stat().st_size, artifact_id))
            if fingerprint and disposition != 'visual_reuse':
                db.execute('INSERT OR REPLACE INTO artifact_fingerprints VALUES(?,?,?)', (artifact_id, 1, encode(fingerprint)))
            if replace_role:
                db.execute('DELETE FROM task_artifacts WHERE task_id=? AND role=? AND artifact_id IN (SELECT id FROM artifacts WHERE kind=?)',
                           (task_id, candidate.get('role', kind), kind))
            elif repair_reference:
                db.execute('DELETE FROM task_artifacts WHERE task_id=? AND candidate_id=?', (task_id, candidate_id))
            db.execute("INSERT INTO task_artifacts VALUES(?,?,?,?,?,?,?)",
                       (task_id, artifact_id, candidate_id, candidate.get("role", kind),
                        display_name, metadata_json, encode(result)))
            if replace_role or repair_reference:
                db.execute("UPDATE artifacts SET status='delete_pending' WHERE NOT EXISTS(SELECT 1 FROM task_artifacts r WHERE r.artifact_id=artifacts.id)")
        # Never remove a candidate before its registration transaction is durable.
        try:
            source.unlink(missing_ok=True)
            if journal:
                journal.unlink(missing_ok=True)
        except OSError:
            pass  # Registration is durable; reconcile or cache cleanup retries the remainder.
        if replace_role or repair_reference:
            self.finish_deletions()
        return result

    def preview_delete(self, task_ids):
        if not isinstance(task_ids, list) or not task_ids or len(task_ids) > 100 or any(not isinstance(i, str) for i in task_ids):
            raise ToolboxError("INVALID_PARAMETERS", "请选择要删除的任务。")
        selected = set(task_ids)
        with self._lock:
            for task_id in selected:
                if self.task(task_id)["state"] in ACTIVE:
                    raise ToolboxError("UNSUPPORTED_OPERATION", "请先停止活动任务。")
            rows = self._db.execute("SELECT a.id,a.size,r.task_id FROM artifacts a JOIN task_artifacts r ON r.artifact_id=a.id").fetchall()
            references = {}
            for row in rows:
                entry = references.setdefault(row["id"], {"size": row["size"], "tasks": set()})
                entry["tasks"].add(row["task_id"])
            released = sum(e["size"] for e in references.values() if e["tasks"] <= selected)
            shared = sum(1 for e in references.values() if e["tasks"] & selected and not e["tasks"] <= selected)
            token = uuid4().hex
            self._previews = {k: v for k, v in self._previews.items() if v["expires"] > time.monotonic()}
            self._previews[token] = {"tasks": selected, "expires": time.monotonic() + 300}
            return {"token": token, "taskCount": len(selected), "releasableBytes": released, "sharedFiles": shared}

    @file_operation
    def confirm_delete(self, token):
        with self.transaction() as db:
            preview = self._previews.pop(token, None)
            if not preview or preview["expires"] <= time.monotonic():
                raise ToolboxError("INVALID_PARAMETERS", "删除预览已过期，请重新选择。")
            for task_id in preview["tasks"]:
                if self.task(task_id)["state"] in ACTIVE:
                    raise ToolboxError("UNSUPPORTED_OPERATION", "任务已恢复运行，请先停止。")
            for task_id in preview["tasks"]:
                db.execute("INSERT OR IGNORE INTO pending_task_deletions VALUES(?,?)", (task_id, now()))
                db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
            db.execute("UPDATE artifacts SET status='delete_pending' WHERE NOT EXISTS(SELECT 1 FROM task_artifacts r WHERE r.artifact_id=artifacts.id)")
        result = self.finish_deletions()
        return result

    @file_operation
    def finish_deletions(self):
        released, pending = 0, 0
        with self.transaction() as db:
            rows = db.execute("SELECT * FROM artifacts WHERE status='delete_pending'").fetchall()
            for row in rows:
                if db.execute("SELECT 1 FROM task_artifacts WHERE artifact_id=?", (row["id"],)).fetchone():
                    continue
                path = self.paths.resolve(row["relpath"])
                try:
                    existed = path.exists()
                    path.unlink(missing_ok=True)
                    released += row["size"] if existed else 0
                    db.execute("DELETE FROM artifacts WHERE id=?", (row["id"],))
                except OSError:
                    pending += 1
        pending_directories = 0
        with self.transaction() as db:
            task_ids = [r[0] for r in db.execute('SELECT task_id FROM pending_task_deletions')]
            for task_id in task_ids:
                if db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                    continue
                if db.execute("SELECT 1 FROM artifacts WHERE relpath LIKE ?", (f"tasks/{task_id}/%",)).fetchone():
                    pending_directories += 1
                    continue
                try:
                    for relative in (f'tasks/{task_id}', f'scratch/{task_id}'):
                        directory = self.paths.resolve(relative)
                        if directory.exists():
                            for child in directory.rglob('*'):
                                self.paths.relative(child)
                            shutil.rmtree(directory)
                    db.execute('DELETE FROM pending_task_deletions WHERE task_id=?', (task_id,))
                except (OSError, ToolboxError):
                    pending_directories += 1
        return {"releasedBytes": released, "pendingFiles": pending, "pendingDirectories": pending_directories}

    @file_operation
    def reconcile(self):
        self.finish_deletions()
        with self.transaction() as db:
            for journal in self.paths.resolve("tasks").glob("*/control/register-*.json"):
                self.paths.relative(journal)
                try:
                    intent = json.loads(journal.read_text(encoding='utf-8'))
                    source = self.paths.resolve(intent['source'])
                    destination = self.paths.resolve(intent['destination'])
                    task_root = journal.parent.parent
                    source.relative_to(task_root / 'staging')
                    if not (destination.parent == self.paths.resolve('media') or destination.parent == task_root / 'results'):
                        raise ValueError('invalid registration intent')
                    if db.execute("SELECT 1 FROM artifacts WHERE relpath=?", (intent['source'],)).fetchone():
                        raise ValueError('candidate is an artifact')
                    registered = db.execute("SELECT relpath,size,sha256 FROM artifacts WHERE id=?", (intent['artifactId'],)).fetchone()
                    destination_record = db.execute("SELECT id FROM artifacts WHERE relpath=?", (intent['destination'],)).fetchone()
                    if registered:
                        if registered['relpath'] != intent['destination']:
                            raise ValueError('registration identity mismatch')
                        valid = destination.is_file() and destination.stat().st_size == registered['size']
                        if valid:
                            with destination.open('rb') as stream:
                                valid = hashlib.file_digest(stream, 'sha256').hexdigest() == registered['sha256']
                        if not valid and source.is_file():
                            with source.open('rb') as stream:
                                source_valid = hashlib.file_digest(stream, 'sha256').hexdigest() == registered['sha256']
                            if source_valid:
                                atomic_copy(source, destination)
                                valid = True
                        if not valid:
                            continue
                        db.execute("UPDATE artifacts SET status='ready' WHERE id=?", (intent['artifactId'],))
                        source.unlink(missing_ok=True)
                    elif source.is_file():
                        # Candidate survived, so retry can register it without downloading again.
                        if not destination_record:
                            destination.unlink(missing_ok=True)
                    else:
                        # Preserve the only copy as a candidate instead of dropping an outcome.
                        source.parent.mkdir(parents=True, exist_ok=True)
                        if destination.is_file() and not destination_record:
                            os.replace(destination, source)
                    journal.unlink()
                except (OSError, ValueError, KeyError, ToolboxError):
                    continue  # Preserve an unreadable intent for diagnosis.
            rows = db.execute("SELECT id,relpath,size FROM artifacts WHERE status='ready'").fetchall()
            for row in rows:
                actual = self.paths.resolve(row['relpath'])
                if not actual.is_file() or actual.stat().st_size != row['size']:
                    db.execute("UPDATE artifacts SET status='missing' WHERE id=?", (row["id"],))

    def usage(self):
        result = {"results": 0, "media": 0, "recovery": 0, "cache": 0, "logs": 0, "browser": 0, "database": 0}
        for path in self.paths.root.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            relative = self.paths.relative(path)
            first = relative.split("/")[0]
            group = {"media": "media", "scratch": "cache", "logs": "logs", "browser-profile": "browser"}.get(first, "database")
            if first == "tasks":
                group = "results" if "/results/" in relative else "recovery"
            if first == "cost":
                group = ("costBackups" if path.name.endswith('.bak') or '/recovery/' in relative else
                         "costLogs" if '/logs/' in relative else
                         "costTemporary" if '/inputs/' in relative or '/tmp/' in relative else "cost")
                result.setdefault(group, 0)
            result[group] += path.stat().st_size
        return result
