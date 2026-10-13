import ctypes
import hashlib
import threading
from ctypes import wintypes


class SingleInstance:
    def __init__(self, identity):
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        for name in ('CreateMutexW', 'CreateEventW'):
            getattr(self.kernel, name).restype = wintypes.HANDLE
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.SetEvent.argtypes = [wintypes.HANDLE]
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        name = 'Local\\ScriptAllToolbox-' + hashlib.sha256(str(identity).encode()).hexdigest()[:24]
        self.event = self.kernel.CreateEventW(None, False, False, name + '-show')
        self.mutex = self.kernel.CreateMutexW(None, False, name)
        existed = ctypes.get_last_error() == 183
        self.install_guard = self.kernel.CreateMutexW(None, False, r'Local\ScriptAllToolbox.InstallGuard')
        if not self.event or not self.mutex or not self.install_guard:
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())
        self.primary = not existed
        self._closed = threading.Event()
        self._thread = None
        if not self.primary:
            self.kernel.SetEvent(self.event)

    def watch(self, callback):
        def run():
            while not self._closed.is_set():
                if self.kernel.WaitForSingleObject(self.event, 200) == 0:
                    callback()
        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def close(self):
        if hasattr(self, '_closed'):
            self._closed.set()
        if getattr(self, '_thread', None):
            self._thread.join(1)
        for name in ('install_guard', 'mutex', 'event'):
            if handle := getattr(self, name, None):
                self.kernel.CloseHandle(handle)
                setattr(self, name, None)
