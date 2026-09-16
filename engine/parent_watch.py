# -*- coding: utf-8 -*-
"""父进程守望：引擎归属于拉起它的桌面应用，应用退出引擎也随之退出。

桌面端拉起引擎时会通过环境变量 TR_PARENT_PID 告知应用进程号，
这里起一个守护线程盯着它。这样即使应用是被强杀（任务管理器结束进程）
也能保证不留孤儿引擎；手动启动（无该环境变量）时不启用守望，
因为那属于开发者自己的进程，应用不该插手。

注意 Windows 上不能用 os.kill(pid, 0) 判断存活——那会直接
TerminateProcess 掉目标进程。这里改用 OpenProcess + WaitForSingleObject。
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable

logger = logging.getLogger(__name__)

ENV_PARENT_PID = "TR_PARENT_PID"
POLL_SECONDS = 2.0

_WAIT_TIMEOUT = 0x00000102
_SYNCHRONIZE = 0x00100000


def _is_alive_windows(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    handle = kernel32.OpenProcess(_SYNCHRONIZE, False, pid)
    if not handle:
        return False  # 打不开（进程不存在或无权限）视为已退出
    try:
        return kernel32.WaitForSingleObject(handle, 0) == _WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


def _is_alive_posix(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def is_alive(pid: int) -> bool:
    """父进程是否还活着；判断不了时按"活着"处理，避免误杀自己。"""
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            return _is_alive_windows(pid)
        return _is_alive_posix(pid)
    except Exception:  # noqa: BLE001
        logger.exception("判断父进程 %s 存活状态失败，先按存活处理", pid)
        return True


def parent_pid_from_env() -> int | None:
    raw = os.environ.get(ENV_PARENT_PID, "").strip()
    if not raw.isdigit():
        return None
    pid = int(raw)
    return pid if pid > 0 else None


def watch(parent_pid: int, on_exit: Callable[[], None] | None = None) -> None:
    """后台守望父进程；它消失后先清理（如关掉本地模型），再退出本进程。"""

    def loop() -> None:
        while True:
            time.sleep(POLL_SECONDS)
            if is_alive(parent_pid):
                continue
            logger.warning("父进程 %s 已退出，引擎随之关闭", parent_pid)
            if on_exit is not None:
                try:
                    on_exit()
                except Exception:  # noqa: BLE001
                    logger.exception("退出清理失败")
            # 请求可能还在处理中，但父进程已消失，直接退出即可
            os._exit(0)

    threading.Thread(target=loop, name="parent-watch", daemon=True).start()


def start_from_env(on_exit: Callable[[], None] | None = None) -> int | None:
    """按环境变量启动守望，返回被守望的父进程号（未启用时为 None）。"""
    pid = parent_pid_from_env()
    if pid is None:
        return None
    watch(pid, on_exit)
    logger.info("已守望父进程 %s：它退出时本进程一并退出", pid)
    return pid
