from __future__ import annotations

import os
import threading
import hashlib
from functools import wraps
from pathlib import Path


MANAGEMENT_MUTEX_PREFIX = "Local\\CostAssistant.Management"
_registry_guard = threading.Lock()
_thread_locks: dict[str, threading.RLock] = {}


def create_management_lock(database_path: str | Path) -> "InterprocessMutex":
    normalized = str(Path(database_path).resolve()).casefold().encode("utf-8")
    identity = hashlib.sha256(normalized).hexdigest()[:16]
    return InterprocessMutex(f"{MANAGEMENT_MUTEX_PREFIX}.{identity}")


def management_locked(function):
    @wraps(function)
    def wrapper(database_path, *args, **kwargs):
        with create_management_lock(database_path):
            return function(database_path, *args, **kwargs)

    return wrapper


class InterprocessMutex:
    """Reusable thread lock backed by a named Windows mutex."""

    def __init__(self, name: str, *, timeout_ms: int = 120_000) -> None:
        self.name = name
        self.timeout_ms = timeout_ms
        with _registry_guard:
            self._thread_lock = _thread_locks.setdefault(name, threading.RLock())
        self._handle = None

    def __enter__(self):
        self._thread_lock.acquire()
        if os.name != "nt":
            return self
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            create_mutex = kernel32.CreateMutexW
            create_mutex.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
            create_mutex.restype = wintypes.HANDLE
            wait_for_single_object = kernel32.WaitForSingleObject
            wait_for_single_object.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            wait_for_single_object.restype = wintypes.DWORD
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = [wintypes.HANDLE]
            close_handle.restype = wintypes.BOOL
            handle = create_mutex(None, False, self.name)
            if not handle:
                raise RuntimeError("无法创建成本助手操作锁")
            wait_result = int(wait_for_single_object(handle, self.timeout_ms))
            if wait_result not in (0x00000000, 0x00000080):
                close_handle(handle)
                raise RuntimeError("另一个成本助手仍在处理数据，请稍后重试")
            self._handle = handle
            return self
        except Exception:
            self._thread_lock.release()
            raise

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if os.name == "nt" and self._handle is not None:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            release_mutex = kernel32.ReleaseMutex
            release_mutex.argtypes = [wintypes.HANDLE]
            release_mutex.restype = wintypes.BOOL
            close_handle = kernel32.CloseHandle
            close_handle.argtypes = [wintypes.HANDLE]
            close_handle.restype = wintypes.BOOL
            release_mutex(self._handle)
            close_handle(self._handle)
            self._handle = None
        self._thread_lock.release()
