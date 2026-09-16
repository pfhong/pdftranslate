"""Transfer Reader 翻译引擎。"""

import hashlib
from pathlib import Path

__version__ = "0.3.0"


def _compute_build() -> str:
    """引擎源码指纹：任一实现文件变化都会改变此值（用于缓存失效与版本核查）。"""
    h = hashlib.sha1()
    for f in sorted(Path(__file__).parent.glob("*.py")):
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return h.hexdigest()[:10]


def compute_build() -> str:
    """现算一遍磁盘上源码的指纹。

    /health 会把它和进程内的 BUILD 一起返回：BUILD 是 import 时算的，
    这个值是磁盘现状，两者不同即说明这个常驻进程比源码旧、需要重启。
    """
    return _compute_build()


BUILD = _compute_build()
