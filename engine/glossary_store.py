# -*- coding: utf-8 -*-
"""术语表：存储、匹配与 CSV 互转。

设计参考 BabelDOC 的 glossary（CSV 多语言词条 + 只注入当前文本命中的词条），
但去掉其对 hyperscan 的硬依赖（改为无依赖的最长优先匹配），并支持按语言过滤。

数据文件：engine/data/glossary.json
CSV 格式（与 BabelDOC 兼容）：source,target[,target_language]
"""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parent / "data"
_STORE = _DATA_DIR / "glossary.json"

_WS = re.compile(r"\s+")


def _norm(text: str) -> str:
    return _WS.sub(" ", text).strip().lower()


def load_entries() -> list[dict]:
    """读取术语表；文件不存在或损坏时返回空表。"""
    try:
        raw = _STORE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, list):
            return [e for e in data if isinstance(e, dict) and e.get("source") and e.get("target")]
    except FileNotFoundError:
        return []
    except Exception:  # noqa: BLE001
        return []
    return []


def save_entries(entries: list[dict]) -> int:
    """保存术语表（按源词去重，保留首次出现）。返回保存条数。"""
    seen: set[str] = set()
    clean: list[dict] = []
    for e in entries:
        src = str(e.get("source", "")).strip()
        tgt = str(e.get("target", "")).strip()
        if not src or not tgt:
            continue
        key = _norm(src)
        if key in seen:
            continue
        seen.add(key)
        item = {"source": src, "target": tgt}
        lang = str(e.get("targetLanguage", "")).strip()
        if lang:
            item["targetLanguage"] = lang
        clean.append(item)
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _STORE.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(clean)


def active_entries(text: str, target_lang: str | None = None) -> list[tuple[str, str]]:
    """返回 text 中真正出现的词条（源词, 目标词），最长源词优先。

    只注入命中的词条——与 BabelDOC 的做法一致，避免整表塞进提示词浪费 token。
    """
    if not text:
        return []
    haystack = _norm(text)
    hits: list[tuple[int, str, str]] = []
    for e in load_entries():
        lang = e.get("targetLanguage")
        if lang and target_lang and lang != target_lang:
            continue
        src = str(e["source"])
        needle = _norm(src)
        if not needle:
            continue
        pos = haystack.find(needle)
        if pos >= 0:
            hits.append((len(needle), src, str(e["target"])))
    hits.sort(key=lambda h: -h[0])
    return [(src, tgt) for _, src, tgt in hits]


def build_prompt_block(entries: list[tuple[str, str]]) -> str:
    """生成注入提示词的术语表格（措辞与 BabelDOC 对齐：强约束 + 表外自然翻译）。"""
    if not entries:
        return ""
    lines = [
        "## Glossary",
        "",
        "Always use the glossary's **Target Term** for any occurrence of its **Source Term** "
        "(including variants, inside tags, or broken across lines).",
        "Unlisted terms are translated naturally.",
        "",
        "| Source Term | Target Term |",
        "|-------------|-------------|",
    ]
    lines.extend(f"| {src} | {tgt} |" for src, tgt in entries)
    return "\n".join(lines)


def parse_csv(text: str) -> list[dict]:
    """解析 CSV（source,target[,target_language]），容忍表头与引号。"""
    reader = csv.reader(io.StringIO(text))
    out: list[dict] = []
    for row in reader:
        if not row:
            continue
        cells = [c.strip() for c in row]
        if len(cells) < 2:
            continue
        if cells[0].lower() in {"source", "源词", "原文"}:  # 表头
            continue
        item = {"source": cells[0], "target": cells[1]}
        if len(cells) >= 3 and cells[2]:
            item["targetLanguage"] = cells[2]
        out.append(item)
    return out


def to_csv(entries: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["source", "target", "target_language"])
    for e in entries:
        writer.writerow([e.get("source", ""), e.get("target", ""), e.get("targetLanguage", "")])
    return buf.getvalue()
