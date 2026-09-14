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


BUILD = _compute_build()
