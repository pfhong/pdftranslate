# -*- coding: utf-8 -*-
"""PP-OCRv6 (small) ONNX 推理：DB 检测 + CTC 识别。

实现参考 E:/core/tools/tongming/OcrTransDesktop/ocr.py（预处理与
PaddlePaddle 官方 inference.yml 对齐）。与原版的差异：本模块对外返回
「行框 + 文本」列表，供版面识别管线使用。
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

DET_SIDE = 736
REC_H = 48
REC_MAX_W = 2048
DB_THRESH = 0.2
DB_BOX_THRESH = 0.45
DB_UNCLIP = 1.4
MIN_AREA = 10
DET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
DET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# 分块检测参数：整页大图上检测器会截断远端文本，故分块
TILE_SIZE = 1100
TILE_OVERLAP = 100


def _tile_ranges(total: int, tile: int, overlap: int) -> list[tuple[int, int]]:
    """按固定步长切分区间，相邻块带 overlap 重叠。"""
    if total <= tile:
        return [(0, total)]
    step = max(1, tile - overlap)
    ranges: list[tuple[int, int]] = []
    start = 0
    while start < total:
        end = min(total, start + tile)
        ranges.append((start, end))
        if end >= total:
            break
        start += step
    return ranges


class PpOcr:
    def __init__(self, det_path: str | Path, rec_path: str | Path, dict_path: str | Path):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = min(8, os.cpu_count() or 4)
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.det = ort.InferenceSession(str(det_path), opts, providers=["CPUExecutionProvider"])
        self.rec = ort.InferenceSession(str(rec_path), opts, providers=["CPUExecutionProvider"])
        self.det_in = self.det.get_inputs()[0].name
        self.rec_in = self.rec.get_inputs()[0].name
        self.vocab = [c for c in Path(dict_path).read_text(encoding="utf-8").splitlines()]

    # ------------------------------------------------------------------ API

    def lines(
        self,
        bgr: np.ndarray,
        det_side: int = DET_SIDE,
        tile: int = TILE_SIZE,
        tile_overlap: int = TILE_OVERLAP,
    ) -> list[dict]:
        """输入 BGR uint8 页面图像，返回按阅读顺序的行列表：

        [{"box": (x0, y0, x1, y1), "text": str}]，坐标为输入图像像素。

        det_side：检测模型短边分辨率上限。
        分块：PP-OCRv6 检测器在整页大图上会**截断远端文本**（实测 1900px 宽页面
        每行右端约 24% 检测不到），故按 tile×tile 的重叠网格分块检测再合并去重。
        注意不要在大图上预降采样——那同样会丢失远端的密集小字。
        """
        # 超大图（>4000px，等效 400+ dpi）才降采样；分块本身已限制单块计算量
        if max(bgr.shape[:2]) > 4000:
            s = 4000 / max(bgr.shape[:2])
            bgr = cv2.resize(bgr, (int(bgr.shape[1] * s), int(bgr.shape[0] * s)))

        h, w = bgr.shape[:2]
        x_ranges = _tile_ranges(w, tile, tile_overlap)
        y_ranges = _tile_ranges(h, tile, tile_overlap)

        raw: list[tuple[float, float, float, float]] = []
        for y0, y1 in y_ranges:
            for x0, x1 in x_ranges:
                sub = bgr[y0:y1, x0:x1]
                if sub.size == 0:
                    continue
                for (bx0, by0, bx1, by1) in self._detect(sub, det_side):
                    raw.append((bx0 + x0, by0 + y0, bx1 + x0, by1 + y0))
        boxes = self._dedupe_boxes(raw)

        crops = []
        for (x0, y0, x1, y1) in boxes:
            crop = bgr[int(y0):int(y1), int(x0):int(x1)]
            if crop.size == 0:
                continue
            crops.append((crop, (x0, y0, x1, y1)))
        texts = self._recognize_batch([c for c, _ in crops])
        out: list[dict] = []
        for (_, box), text in zip(crops, texts):
            if text.strip():
                out.append({"box": box, "text": text.strip()})
        return out

    @staticmethod
    def _dedupe_boxes(
        boxes: list[tuple[float, float, float, float]],
    ) -> list[tuple[float, float, float, float]]:
        """合并分块重叠区的重复框：x/y 双向重叠均超过较小框的一半即判重，
        保留面积更大者（跨块边界被切断的框面积更小）。"""
        kept: list[tuple[float, float, float, float]] = []
        for box in sorted(boxes, key=lambda b: (b[1], b[0])):
            dup = False
            for i, k in enumerate(kept):
                ox = min(box[2], k[2]) - max(box[0], k[0])
                oy = min(box[3], k[3]) - max(box[1], k[1])
                if ox <= 0 or oy <= 0:
                    continue
                w_min = min(box[2] - box[0], k[2] - k[0])
                h_min = min(box[3] - box[1], k[3] - k[1])
                if ox > 0.5 * w_min and oy > 0.5 * h_min:
                    area_new = (box[2] - box[0]) * (box[3] - box[1])
                    area_old = (k[2] - k[0]) * (k[3] - k[1])
                    if area_new > area_old:
                        kept[i] = box
                    dup = True
                    break
            if not dup:
                kept.append(box)
        return kept

    # ------------------------------------------------------------------ 检测

    def _detect(self, bgr: np.ndarray, det_side: int = DET_SIDE) -> list[tuple[float, float, float, float]]:
        h0, w0 = bgr.shape[:2]
        ratio = det_side / min(h0, w0) if min(h0, w0) > det_side else 1.0
        rs_w = max(32, int(np.ceil(w0 * ratio / 32)) * 32)
        rs_h = max(32, int(np.ceil(h0 * ratio / 32)) * 32)
        img = cv2.resize(bgr, (rs_w, rs_h)) if (rs_w, rs_h) != (w0, h0) else bgr
        x = ((img.astype(np.float32) / 255.0 - DET_MEAN) / DET_STD).transpose(2, 0, 1)[None]
        prob = self.det.run(None, {self.det_in: x})[0][0, 0]
        return self._db_boxes(prob, rs_w / w0, rs_h / h0)

    def _db_boxes(self, prob: np.ndarray, rx: float, ry: float) -> list[tuple[float, float, float, float]]:
        h0, w0 = prob.shape
        binary = (prob > DB_THRESH).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
        boxes = []
        for i in range(1, n):
            x, y, w, h, area = stats[i]
            if area < MIN_AREA or w < 2 or h < 2:
                continue
            mask = labels[y:y + h, x:x + w] == i
            if float(prob[y:y + h, x:x + w][mask].mean()) < DB_BOX_THRESH:
                continue
            d = DB_UNCLIP * area / (2 * (w + h))  # unclip：矩形近似
            x0 = max(0.0, min((x - d) / rx, w0 - 1.0))
            x1 = max(0.0, min((x + w + d) / rx, w0))
            y0 = max(0.0, min((y - d) / ry, h0 - 1.0))
            y1 = max(0.0, min((y + h + d) / ry, h0))
            if x1 - x0 < 3 or y1 - y0 < 3:
                continue
            boxes.append((x0, y0, x1, y1))
        return self._order_boxes(boxes)

    # ------------------------------------------------------------------ 阅读顺序

    @staticmethod
    def _find_gap(intervals: list[tuple[float, float]], min_gap: float):
        """在已排序区间中找最宽的空隙，返回 (gap_start, gap_end)；无则 None。"""
        best = None
        end = intervals[0][1]
        for s, e in intervals[1:]:
            if s - end >= min_gap and (best is None or s - end > best[1] - best[0]):
                best = (end, s)
            end = max(end, e)
        return best

    @classmethod
    def _order_boxes(cls, boxes: list[tuple[float, float, float, float]], depth: int = 0) -> list[tuple[float, float, float, float]]:
        """XY 递归切分：比较横向/纵向最宽空隙，沿更宽的方向切开（栏距>行距，
        故先分栏后分行），兼容双栏/侧边栏版式；不可再切时按行聚类、行内从左到右。"""
        if len(boxes) <= 1 or depth > 8:
            return cls._sort_rows(boxes)
        h_gap = cls._find_gap(sorted((b[1], b[3]) for b in boxes), min_gap=12)
        v_gap = cls._find_gap(sorted((b[0], b[2]) for b in boxes), min_gap=12)
        use_h = h_gap is not None and (v_gap is None or
                                       h_gap[1] - h_gap[0] >= v_gap[1] - v_gap[0])
        if use_h:
            first = [b for b in boxes if b[3] <= h_gap[0]]
            second = [b for b in boxes if b[1] >= h_gap[1]]
        elif v_gap is not None:
            first = [b for b in boxes if b[2] <= v_gap[0]]
            second = [b for b in boxes if b[0] >= v_gap[1]]
        else:
            return cls._sort_rows(boxes)
        if not first or not second:
            return cls._sort_rows(boxes)
        return cls._order_boxes(first, depth + 1) + cls._order_boxes(second, depth + 1)

    @staticmethod
    def _sort_rows(boxes: list[tuple[float, float, float, float]]) -> list[tuple[float, float, float, float]]:
        """行聚类：按 y 区间重叠度分行（重叠 > 较小高度的 50% 才算同一行），
        行内按 x。注意不能用「y0 < 上一行 y1 + 半行高」判行距，行距大时会整段误并成一行。"""
        if not boxes:
            return []
        rows: list[list] = []  # 每项 [y0, y1, boxes]
        for b in sorted(boxes, key=lambda t: t[1]):
            h = b[3] - b[1]
            for row in rows:
                overlap = min(b[3], row[1]) - max(b[1], row[0])
                if overlap > 0.5 * min(h, row[1] - row[0]):
                    row[2].append(b)
                    row[0] = min(row[0], b[1])
                    row[1] = max(row[1], b[3])
                    break
            else:
                rows.append([b[1], b[3], [b]])
        rows.sort(key=lambda r: r[0])
        return [b for _, _, row in rows for b in sorted(row, key=lambda t: t[0])]

    # ------------------------------------------------------------------ 识别

    def _recognize_batch(self, crops: list[np.ndarray], batch_size: int = 16) -> list[str]:
        """批量识别：按宽度排序分桶（同桶 pad 到一致宽度），一次推理 batch_size 行。"""
        results = [""] * len(crops)
        order = sorted(range(len(crops)), key=lambda i: crops[i].shape[1], reverse=True)

        def decode(ids: np.ndarray) -> str:
            chars, prev = [], -1
            for t in ids:
                c = int(t)
                if c != 0 and c != prev:
                    chars.append(self.vocab[c - 1] if c <= len(self.vocab) else " ")
                prev = c
            return "".join(chars)

        for start in range(0, len(order), batch_size):
            idxs = order[start:start + batch_size]
            imgs = []
            for i in idxs:
                h, w = crops[i].shape[:2]
                w_out = min(max(int(w * REC_H / max(h, 1)), 16), REC_MAX_W)
                if w_out % 8:
                    w_out += 8 - w_out % 8
                imgs.append(cv2.resize(crops[i], (w_out, REC_H)))
            max_w = max(im.shape[1] for im in imgs)
            # pad 用归一化后的白色（1.0），与 PP-OCR 官方做法一致
            batch = np.full((len(imgs), 3, REC_H, max_w), 1.0, dtype=np.float32)
            for k, im in enumerate(imgs):
                x = ((im.astype(np.float32) / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)
                batch[k, :, :, : im.shape[1]] = x
            out = self.rec.run(None, {self.rec_in: batch})[0]  # [B, T, C]
            for k, i in enumerate(idxs):
                results[i] = decode(out[k].argmax(axis=1))
        return results

    def _recognize_line(self, crop: np.ndarray) -> str:
        h, w = crop.shape[:2]
        w_out = min(max(int(w * REC_H / max(h, 1)), 16), REC_MAX_W)
        if w_out % 8:
            w_out += 8 - w_out % 8
        img = cv2.resize(crop, (w_out, REC_H))
        x = ((img.astype(np.float32) / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None]
        out = self.rec.run(None, {self.rec_in: x})[0][0]  # [T, C]
        ids = out.argmax(axis=1)
        chars, prev = [], -1
        for t in ids:
            c = int(t)
            if c != 0 and c != prev:
                chars.append(self.vocab[c - 1] if c <= len(self.vocab) else " ")
            prev = c
        return "".join(chars)
