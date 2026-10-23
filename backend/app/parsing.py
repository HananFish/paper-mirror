"""PDF 解析（行级重建）：

页面 → 提取文本行 → 过滤页眉页脚（页边带/页码/版权模板/跨页重复）
→ 栏检测 → 同行碎片合并（角标/引用上标）→ 分带段落聚类（行距/缩进/标点/字号）
→ 重叠块合并（图注多栏/作者区产生的交叠块）→ 分类 → 插入图片块。

段落完整性由行级聚类决定，不受 PyMuPDF 块切分影响。
坐标体系：PDF 点（pt），原点在页面左上角。
"""
from __future__ import annotations

import re
from collections import defaultdict
from statistics import median

import pymupdf

from .layout_yolo import detect_layout

MARGIN = 36.0
GUTTER_TOL = 6.0
LIST_PREFIX = re.compile(r"^\s*([•·▪◦‒–—-]|\(?\d{1,2}[.)]|[a-z][.)]|[ivxIVX]+[.)])\s+")
MATH_CHARS = set("+=^~|<>∫∮ΣΠ∏∂∇≈≠≤≥±×÷µλπσθΩωεδ")
_PUNCT_NO_SPACE = set(",.;:!?)]}”’")
CAPTION_PREFIX = re.compile(r"^\s*(?:(?:Fig(?:ure)?s?\.?|Tab(?:le)?s?\.?)\s*(?:[SA]?\.?\d+(?:[.-]\d+)*|[IVX]+|[A-Z](?=\s*[:.]))\b|[图表]\s*\d+)", re.I)
REFERENCE_HEADING = re.compile(r"^\s*(?:(?:\d+[.)]?|[IVX]+[.)]?)\s+)?(?:references|bibliography|literature cited|works cited|参考文献)\s*[:：]?\s*$", re.I)


def mark_reference_sections(blocks: list[dict]) -> None:
    """Preserve bibliography entries; resume translating appendix/body sections."""
    in_references = False
    for block in blocks:
        text = block.get("text", "").strip()
        if REFERENCE_HEADING.fullmatch(text):
            in_references = True
        elif in_references and len(text) < 160 and (re.match(r"^(?:appendix\b|appendices\b|supplementary (?:material|information)\b|附录)", text, re.I)
                or block.get("block_type") == "heading" and re.match(r"^(?:[A-Z][.)]?|\d+(?:\.\d+)*[.)]?)\s+\w", text)):
            in_references = False
        if in_references and text and block.get("block_type") not in {"image", "table", "formula", "caption"}:
            block["block_type"] = "reference"


def typography(item: dict, page_width: float, gutter: float | None = None) -> dict:
    left, _, right, _ = item["bbox"]
    col_left, col_right = 0, page_width
    if gutter is not None:
        if right <= gutter + GUTTER_TOL: col_right = gutter
        elif left >= gutter - GUTTER_TOL: col_left = gutter
    centered = abs((left + right)/2 - (col_left + col_right)/2) <= max(8, (col_right-col_left)*0.03)
    return {"font_weight": 700 if item.get("bold") else 400,
            "text_align": "center" if item.get("block_type") == "heading" and centered else "left",
            "line_count": item.get("line_count", 1)}


def _caption_groups(lines: list[dict], regions: list | None = None, tables: list | None = None) -> tuple[list[dict], list[dict]]:
    """Take detected captions and nearby wrapped lines out of figure suppression."""
    # PDF producers may emit the bold label and regular description as separate
    # lines at the same baseline. Join them before looking for caption prefixes.
    lines = _merge_same_line_fragments(lines, _find_gutter(lines, max((l["bbox"][2] for l in lines), default=559)+36))
    selected = set()
    groups = []
    ordered = sorted(enumerate(lines), key=lambda pair: (pair[1]["bbox"][1], pair[1]["bbox"][0]))
    for index, first in ordered:
        if index in selected: continue
        box = pymupdf.Rect(first["bbox"])
        detected = next((pymupdf.Rect(r) for r in (regions or []) if _rect_inter_area(first["bbox"], r) > box.get_area()*0.5), None)
        footnote = re.match(r"^\s*(?:notes?|source)\s*:", first["text"], re.I) and any(
            0 <= box.y0-pymupdf.Rect(t).y1 < 30 and box.x0 < pymupdf.Rect(t).x1 and box.x1 > pymupdf.Rect(t).x0 for t in (tables or []))
        if detected is None and not _caption_start(first["text"]) and not footnote: continue
        group = [first]; selected.add(index)
        for other_index, line in ordered:
            if other_index in selected or line["bbox"][1] < first["bbox"][1]: continue
            rect = pymupdf.Rect(line["bbox"])
            if detected is not None:
                if _rect_inter_area(line["bbox"], detected) > rect.get_area()*0.5:
                    group.append(line); selected.add(other_index)
                continue
            previous = pymupdf.Rect(group[-1]["bbox"])
            if rect.x1 <= box.x0 or rect.x0 >= box.x1: continue
            gap = rect.y0-previous.y1
            if gap < -2: continue
            if gap > previous.height*0.7 or abs(line["size"]-first["size"]) > .6 or CAPTION_PREFIX.match(line["text"]) or REFERENCE_HEADING.fullmatch(line["text"].strip()): break
            if group[-1]["text"].rstrip().endswith((".","!","?")) and previous.width < box.width*.8: break
            group.append(line); selected.add(other_index)
        item = _make_para(group)
        item["block_type"] = "caption"
        groups.append(item)
    return [line for i,line in enumerate(lines) if i not in selected], groups


def _caption_start(text: str) -> bool:
    match = CAPTION_PREFIX.match(text)
    if not match: return False
    tail = text[match.end():].lstrip()
    # A body sentence referring to a figure is not a caption. Keeping it in the
    # body also prevents it from stealing association from the actual caption.
    return not (tail.startswith(',') or re.match(r"^\([a-z]\)\s*,",tail,re.I) or
        re.match(r"^(?:shows?|illustrates?|depicts?|presents?|compares?|demonstrates?|provides?|reports?|summarizes?|is|are|was|were|has|have|can|will|and|or)\b",tail,re.I))


def _raster_captions(page, regions, native_items):
    """OCR only detected caption regions lacking a usable native text layer."""
    from .ocr import recognize_png
    items = []
    for region in regions:
        box = pymupdf.Rect(region) & page.rect
        if box.is_empty or any(_rect_inter_area(item["bbox"], box) > min(pymupdf.Rect(item["bbox"]).get_area(), box.get_area())*.5 for item in native_items):
            continue
        labels = recognize_png(page.get_pixmap(matrix=pymupdf.Matrix(3,3), clip=box, alpha=False).tobytes("png"))
        reliable = [label for label in labels if label.get("confidence", 0) >= .7]
        rows = []
        for label in sorted(reliable, key=lambda label: min(p[1] for p in label["quad"])):
            top, bottom = min(p[1] for p in label["quad"]), max(p[1] for p in label["quad"])
            center, height = (top+bottom)/2, bottom-top
            row = next((row for row in rows if abs(center-row["center"]) <= min(height,row["height"])*.6), None)
            if row is None:
                row = {"center":center,"height":height,"labels":[]};rows.append(row)
            row["labels"].append(label)
        text = " ".join(label["src"] for row in sorted(rows,key=lambda row:row["center"])
                        for label in sorted(row["labels"],key=lambda label:min(p[0] for p in label["quad"])))
        if text.strip():
            items.append({"bbox": list(box), "text": text, "font_size": max(6,min(12,box.height/max(1,len(rows))*.7)),
                          "bold": False, "line_count": len(rows), "block_type": "caption"})
    return items
# 页面顶部/底部 15% 内出现的出版模板文字（版权行、下载水印等）
_BOILERPLATE = re.compile(
    r"©|\(c\)\s*\d{4}|DOI\s+10\.|Authorized licensed use|Downloaded from|All rights reserved"
    r"|^\d{4}\s*[-–]\s*\d{4}/\d{2}|\$\d+\.\d{2}",
    re.IGNORECASE,
)


def parse_pdf_file(path: str) -> tuple[list[dict], list[dict]]:
    """返回 (pages, blocks)。blocks 按全文阅读顺序排列。"""
    pdf = pymupdf.open(path)
    pages_out: list[dict] = []
    blocks_out: list[dict] = []
    order = 0
    try:
        # 第一遍：提取行，统计跨页重复文本（每页同一位置出现的页眉/页脚/水印）
        page_data = []
        repeat_seen: dict[tuple[str, int], set[int]] = defaultdict(set)
        for pno, page in enumerate(pdf, start=1):
            rotation = page.rotation
            rotation_matrix = page.rotation_matrix
            display_rect = page.rect
            page.set_rotation(0)
            ph = page.rect.height
            pw = page.rect.width
            lines = _extract_lines(page.get_text("dict").get("blocks", []))
            lines = _drop_margin_junk(lines, ph, pw)
            for l in lines:
                if _in_band(l["bbox"], ph):
                    key = (re.sub(r"\d+", "#", l["text"].strip())[:120], round(l["bbox"][1] / 24))
                    repeat_seen[key].add(pno)
            page_data.append({"pno": pno, "page": page, "lines": lines, "ph": ph,
                              "rotation": rotation, "rotation_matrix": rotation_matrix,
                              "display_rect": display_rect})

        npages = len(page_data)
        repeat_threshold = 3 if npages >= 4 else 2
        repeated_keys = {k for k, pnos in repeat_seen.items() if len(pnos) >= repeat_threshold}

        for pd in page_data:
            pno, page, ph = pd["pno"], pd["page"], pd["ph"]
            pw = page.rect.width
            raw_text = page.get_text("text")
            lines = [l for l in pd["lines"] if not _is_repeated_furniture(l, ph, repeated_keys)]

            # 图形区域划分：优先用 DocLayout-YOLO（轻量版面检测，28MB 权重），
            # 模型不可用时回退启发式（位图+矢量簇+膨胀）。
            # 图/表/公式区域内的文字不进入翻译管线（它们属于图像与结构对象）。
            yolo = detect_layout(page)
            tables: list[dict] = []
            caption_regions = []
            if yolo is not None:
                def _rects_of(names: set[str], min_area: float = 1500) -> list[pymupdf.Rect]:
                    return [
                        pymupdf.Rect(r["bbox"])
                        for r in yolo
                        if r["name"] in names
                        and (r["bbox"][2] - r["bbox"][0]) * (r["bbox"][3] - r["bbox"][1]) >= min_area
                    ]

                fig_rects = _rects_of({"figure"})
                tab_rects = _rects_of({"table"})
                caption_regions = _rects_of({"figure_caption", "table_caption", "table_footnote", "formula_caption"}, min_area=40)
                lines, caption_items = _caption_groups(lines, caption_regions, tab_rects)
                caption_items += _raster_captions(page, caption_regions, caption_items)
                suppress_regions = fig_rects + tab_rects + _rects_of(
                    {"isolate_formula"},
                    min_area=600,
                )

                suppressed = [l for l in lines if _line_in_figure(l["bbox"], suppress_regions)]
                keep = [l for l in lines if l not in suppressed]
                # 表格块：区域内文字按行序拼成表格文本
                for tr in tab_rects:
                    tl = sorted(
                        (l for l in suppressed if _line_in_figure(l["bbox"], [tr])),
                        key=lambda l: (l["bbox"][1], l["bbox"][0]),
                    )
                    text = " | ".join(l["text"] for l in tl)
                    tables.append({
                        "block_type": "table",
                        "bbox": [round(v, 2) for v in (tr.x0, tr.y0, tr.x1, tr.y1)],
                        "text": text,
                        "font_size": 9.5,
                        "extra_meta": {},
                    })
                lines = keep
                fig_regions = [pymupdf.Rect(r) for r in fig_rects]
                imgs = [
                    r for r in _image_rects(page)
                    if not any(_contains_rect(reg, tuple(r)) for reg in suppress_regions)
                    and not (r.width < 140 and r.height < 70 and (r.y1 < ph * 0.12 or r.y0 > ph * 0.88))
                ]
                # figure 检测框作为图片块；与位图互相包含或彼此重叠时去重——
                # 否则同一张图会生成两个叠放的图片块，覆盖层互相干扰
                fig_cards: list[pymupdf.Rect] = []
                for fr in fig_rects:
                    if any(_contains_rect(fr, tuple(o)) or _contains_rect(o, tuple(fr)) for o in fig_cards):
                        continue
                    if any(_contains_rect(o, tuple(fr)) for o in imgs):
                        continue
                    fig_cards.append(fr)
                imgs = imgs + fig_cards
                fig_regions = []  # 已并入 imgs，避免 _build_reading_order 再次生成重复图片块
            else:
                tables = _detect_tables(page)
                table_regions = [pymupdf.Rect(t['bbox']) for t in tables]
                lines, caption_items = _caption_groups(lines, tables=table_regions)
                fig_regions = [r for r in _figure_regions(page) if not any(_contains_rect(t, r) for t in table_regions)]
                lines = [l for l in lines if not _line_in_figure(l['bbox'], table_regions)]
                lines = [l for l in lines if not _line_in_figure(l["bbox"], fig_regions)]
                imgs = [
                    r for r in _image_rects(page)
                    if not any(_contains_rect(reg, tuple(r)) for reg in fig_regions)
                    # 页眉页脚带内的小图（logo、图标）不算内容图
                    and not (r.width < 140 and r.height < 70 and (r.y1 < ph * 0.12 or r.y0 > ph * 0.88))
                ]

            gutter = _find_gutter(lines, pw)
            lines = _merge_same_line_fragments(lines, gutter)
            body_size = _body_font_size(lines)
            paragraphs = _build_reading_order(lines, imgs + list(fig_regions), gutter)

            page_blocks: list[dict] = []
            for item in paragraphs + caption_items:
                if item.get("is_image"):
                    btype, text, font_size = "image", "", 9.5
                else:
                    text = item["text"]
                    if not text.strip():
                        continue
                    btype = item.get("block_type") or _classify(item, body_size)
                    font_size = item["font_size"]
                page_blocks.append({
                    "page_number": pno,
                    "block_type": btype,
                    "bbox": [round(v, 2) for v in item["bbox"]],
                    "text": text,
                    "font_size": round(font_size, 2),
                    "extra_meta": typography({**item, "block_type": btype}, pw, gutter),
                })

            # 复杂区域（多栏图注、作者区）产生的交叠块并成一块，杜绝覆盖层互相压字；
            # 表格块先加入，让被表格 bbox 包住的图注/杂块被合并吸收；
            # 合并后按双栏规则重排（含图片块），保证阅读顺序不被打乱
            page_blocks = _merge_overlapping_text_blocks(
                page_blocks + [{
                    "page_number": pno, "block_type": "table", "bbox": t["bbox"],
                    "text": t["text"], "font_size": 9.5,
                    "extra_meta": {"rows": t.get("rows", []), "confidence": t.get("confidence", 0.0)},
                } for t in tables],
                gutter,
            )

            for b in page_blocks:
                visual = pymupdf.Rect(b["bbox"]) * pd["rotation_matrix"]
                b["bbox"] = [round(v, 2) for v in visual]
                b["extra_meta"].update(coordinate_space="visual", rotation=pd["rotation"])
                b["reading_order"] = order
                order += 1
            pages_out.append({
                "page_number": pno,
                "width": pd["display_rect"].width,
                "height": pd["display_rect"].height,
                "raw_text": raw_text,
            })
            blocks_out.extend(page_blocks)
        mark_reference_sections(blocks_out)
    finally:
        pdf.close()
    return pages_out, blocks_out


# ---------- 行提取与预处理 ----------

def _extract_lines(raw_blocks: list[dict]) -> list[dict]:
    lines: list[dict] = []
    for b in raw_blocks:
        if b.get("type") != 0:
            continue
        for ln in b.get("lines", []):
            spans = [s for s in ln.get("spans", []) if s.get("text", "").strip()]
            if not spans:
                continue
            text = "".join(s.get("text", "") for s in ln.get("spans", []))
            x0, y0, x1, y1 = ln["bbox"]
            # 丢弃孤立标点等碎片
            if len(text.strip()) <= 1 and (x1 - x0) < 8:
                continue
            sizes = [s["size"] for s in spans]
            lines.append({
                "bbox": (x0, y0, x1, y1),
                "text": text.replace("\xa0", " ").replace("\xad", ""),
                "size": max(sizes),
                "bold": sum(len(s.get("text", "")) for s in spans if s.get("flags", 0) & 16) >= sum(len(s.get("text", "")) for s in spans)*0.5,
            })
    return lines


def _in_band(bbox: tuple, ph: float) -> bool:
    """是否位于页面顶部/底部 12% 区域（页眉页脚带）。"""
    return bbox[3] < ph * 0.12 or bbox[1] > ph * 0.88


def _in_wide_band(bbox: tuple, ph: float) -> bool:
    """更宽的边缘区域（15%），用于版权模板识别。"""
    return bbox[3] < ph * 0.15 or bbox[1] > ph * 0.85


def _drop_margin_junk(lines: list[dict], ph: float, pw: float | None = None) -> list[dict]:
    """单页即可判定的页眉页脚：贴边短行、纯页码、出版模板、左右竖排水印。"""
    out = []
    pw = pw or 612.0
    for l in lines:
        x0, y0, x1, y1 = l["bbox"]
        text = l["text"].strip()
        near_edge = y1 < MARGIN or y0 > ph - MARGIN
        if near_edge and len(text) < 120 and not CAPTION_PREFIX.match(text):
            continue
        if _in_band(l["bbox"], ph) and len(text.replace(".", "").strip()) <= 6 and text.replace(".", "").strip().isdigit():
            continue  # 页码
        if _in_wide_band(l["bbox"], ph) and _BOILERPLATE.search(text):
            continue  # 版权行 / 下载水印
        # 左右边缘竖排文字（arXiv 侧边水印、装订线等）：窄条、行高很大
        if (x1 < pw * 0.07 or x0 > pw * 0.93) and (y1 - y0) > 40:
            continue
        out.append(l)
    return out


def _is_repeated_furniture(l: dict, ph: float, repeated_keys: set) -> bool:
    """跨页重复：同一归一化文本出现在 ≥3 页（短文档 ≥2 页）的边缘带。"""
    if not repeated_keys or not _in_band(l["bbox"], ph) or CAPTION_PREFIX.match(l["text"]):
        return False
    key = (re.sub(r"\d+", "#", l["text"].strip())[:120], round(l["bbox"][1] / 24))
    return key in repeated_keys


def _figure_regions(page: "pymupdf.Page") -> list["pymupdf.Rect"]:
    """图形区域 = 位图 + 与位图相交的矢量图形簇（迭代并集成连通区域）。

    只抑制与位图伴生的图形区域内的文字（图内标签、流程图、示例问题等）——
    纯矢量图表/表格（不与位图相交）不抑制，避免吞掉表格正文。
    """
    img_rects = _image_rects(page)
    rects: list[pymupdf.Rect] = list(img_rects)
    try:
        clusters = page.cluster_drawings()
    except Exception:
        clusters = []
    # Do not let a large drawing cluster (page border/table rules) expand a tiny
    # bitmap into a whole-page figure. Pure vector charts need their own region.
    rects.extend(c for c in clusters if c.width > 40 and c.height > 30
                 and c.get_area() < page.rect.get_area() * 0.65)

    # 不动点合并：相交的矩形并成一个连通区域。
    # 合并时对矩形做 15pt 膨胀——图内标签/示例文字位于图元之间的空隙中，
    # 不膨胀的话这些空隙不会被任何区域覆盖，导致图内文字泄漏到翻译管线。
    INFLATE = 15.0

    def inflate(r: pymupdf.Rect) -> pymupdf.Rect:
        return pymupdf.Rect(
            max(0.0, r.x0 - INFLATE), max(0.0, r.y0 - INFLATE),
            min(page.rect.x1, r.x1 + INFLATE), min(page.rect.y1, r.y1 + INFLATE),
        )

    merged = [pymupdf.Rect(r) for r in rects]
    changed = True
    while changed:
        changed = False
        out: list[pymupdf.Rect] = []
        for r in merged:
            hit = None
            for i, m in enumerate(out):
                if inflate(r).intersects(inflate(m)):
                    hit = i
                    break
            if hit is None:
                out.append(pymupdf.Rect(r))
            else:
                out[hit] = out[hit] | r
                changed = True
        merged = out
    return [m & page.rect for m in merged if abs(m) > 1200 and abs(m) < page.rect.get_area() * 0.85]


def _detect_tables(page) -> list[dict]:
    """Recognize ruled tables before clustering prose; preserve cell boundaries."""
    try:
        # Strict lines first avoids false positives from two-column prose. If no
        # grid is found, the text strategy recovers borderless / three-line
        # academic tables by inferring aligned word columns.
        strategy = "lines_strict"
        detected = page.find_tables(strategy=strategy).tables
        if not detected:
            return []  # 无线框时不回退 text 策略：双栏正文的词列对齐几乎必然被误判成表
        result = []
        for table in detected:
            if table.row_count < 2 or table.col_count < 2:
                continue
            rows = table.extract()
            non_empty = sum(bool(cell and str(cell).strip()) for row in rows for cell in row)
            if non_empty < max(4, table.row_count * table.col_count * 0.35):
                continue
            text = '\n'.join(' | '.join((cell or '').replace('\n', ' ') for cell in row) for row in rows)
            result.append({'block_type': 'table', 'bbox': list(table.bbox), 'text': text,
                           'rows': rows, 'confidence': 0.9})
        return result
    except Exception:
        return []


def _line_in_figure(bbox: tuple, regions: list["pymupdf.Rect"]) -> bool:
    """文本行大部分面积落在图形区域（含 15pt 膨胀）内 → 图内文字。

    膨胀覆盖图元之间空隙里的标签；图注通常在区域外 15pt 以上，不受影响。
    """
    la = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    if la <= 0:
        return False
    INFLATE = 15.0
    for r in regions:
        ir = pymupdf.Rect(
            max(0.0, r.x0 - INFLATE), max(0.0, r.y0 - INFLATE),
            min(r.x1 + INFLATE, 1e9), min(r.y1 + INFLATE, 1e9),
        )
        w = min(bbox[2], ir.x1) - max(bbox[0], ir.x0)
        h = min(bbox[3], ir.y1) - max(bbox[1], ir.y0)
        if w > 0 and h > 0 and w * h >= 0.65 * la:
            return True
    return False


def _contains_rect(outer: "pymupdf.Rect", inner: tuple | "pymupdf.Rect") -> bool:
    ix0, iy0 = max(outer.x0, inner[0]), max(outer.y0, inner[1])
    ix1, iy1 = min(outer.x1, inner[2]), min(outer.y1, inner[3])
    ia = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    inner_area = max(0.0, inner[2] - inner[0]) * max(0.0, inner[3] - inner[1])
    return inner_area > 0 and ia >= 0.9 * inner_area


def _rect_area(b: list | tuple) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _rect_inter_area(a: list | tuple, b: list | tuple) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, w) * max(0.0, h)


def _order_placed_items(items: list[dict], gutter: float | None) -> list[dict]:
    """对已成块的 item 做双栏感知排序：全宽块为分带边界，栏内先左后右逐带穿插。

    与行级 _build_reading_order 的组装规则一致，供重叠合并后的重排复用。
    """
    for it in items:
        it["_side"] = _side(it["bbox"], gutter)
    full = sorted(
        (it for it in items if it["_side"] == "full"), key=lambda it: it["bbox"][1]
    )

    def band_of(y0: float) -> int:
        return sum(1 for f in full if f["bbox"][3] <= y0)

    left_by_band: dict[int, list] = defaultdict(list)
    right_by_band: dict[int, list] = defaultdict(list)
    for it in items:
        if it["_side"] == "full":
            continue
        (left_by_band if it["_side"] == "left" else right_by_band)[band_of(it["bbox"][1])].append(it)
    for d in (left_by_band, right_by_band):
        for v in d.values():
            v.sort(key=lambda it: it["bbox"][1])

    result: list[dict] = []
    for b in range(len(full) + 1):
        result.extend(left_by_band.get(b, []))
        result.extend(right_by_band.get(b, []))
        if b < len(full):
            result.append(full[b])
    for it in result:
        it.pop("_side", None)
    return result


def _merge_overlapping_text_blocks(page_blocks: list[dict], gutter: float | None) -> list[dict]:
    """合并 bbox 相互交叠的文本块（多栏图注、作者区等复杂区域的聚类副产物）。

    面积大的块优先保留，交叠超过较小块面积 25% 即并入；图片块不参与合并但参与排序。
    """
    texts = [b for b in page_blocks if b["block_type"] != "image"]
    images = [b for b in page_blocks if b["block_type"] == "image"]
    texts.sort(key=lambda b: -_rect_area(b["bbox"]))

    out: list[dict] = []
    for b in texts:
        target = None
        b_area = _rect_area(b["bbox"])
        if b_area <= 0:
            continue
        for o in out:
            if (o['block_type'] == "caption" or b['block_type'] == "caption") and o['block_type'] != b['block_type']:
                continue
            ia = _rect_inter_area(o["bbox"], b["bbox"])
            if ia <= 0.25 * b_area:
                continue
            # 同类型同侧的部分交叠 → 合并；完全包含（≥90%）→ 无条件合并
            # （作者区的机构碎片整体落在横跨全宽的作者行内，侧别不同但归属明确）
            contained = ia >= 0.9 * b_area
            if contained or (o['block_type'] == b['block_type'] and _side(o['bbox'], gutter) == _side(b['bbox'], gutter)):
                target = o
                break
        if target is not None:
            target["text"] = _join_fragment(target["text"], b["text"])
            tb = target["bbox"]
            bb = b["bbox"]
            target["bbox"] = [
                min(tb[0], bb[0]), min(tb[1], bb[1]),
                max(tb[2], bb[2]), max(tb[3], bb[3]),
            ]
        else:
            out.append(dict(b))

    # 合并会打乱原有顺序，必须按双栏规则重排（含图片块）
    return _order_placed_items(out + images, gutter)


def _body_font_size(lines: list[dict]) -> float:
    weighted = [(round(l["size"], 1), len(l["text"])) for l in lines if len(l["text"]) >= 2]
    if not weighted:
        return 10.0
    total = sum(n for _, n in weighted)
    acc = 0
    for size, n in sorted(weighted):
        acc += n
        if acc >= total / 2:
            return size
    return weighted[-1][0]


def _side(bbox: tuple, gutter: float | None) -> str:
    if gutter is None:
        return "full"
    x0, _, x1, _ = bbox
    if x1 <= gutter + GUTTER_TOL:
        return "left"
    if x0 >= gutter - GUTTER_TOL:
        return "right"
    return "full"


# ---------- 栏检测 ----------

def _find_gutter(lines: list[dict], pw: float) -> float | None:
    """在页面中部搜索一条被最少文本穿过的竖直分栏线（按字符数加权）。"""
    if len(lines) < 6:
        return None
    n_chars = sum(len(l["text"]) for l in lines) or 1
    best: tuple[float, float] | None = None  # (cross_ratio, gutter_x)
    lo, hi, steps = pw * 0.32, pw * 0.68, 72
    for i in range(steps + 1):
        c = lo + (hi - lo) * i / steps
        cross = left_c = right_c = 0
        for l in lines:
            x0, _, x1, _ = l["bbox"]
            n = len(l["text"])
            if x0 < c - GUTTER_TOL and x1 > c + GUTTER_TOL:
                cross += n
            elif x1 <= c + GUTTER_TOL:
                left_c += n
            else:
                right_c += n
        if left_c < n_chars * 0.2 or right_c < n_chars * 0.2:
            continue
        ratio = cross / n_chars
        if best is None or ratio < best[0] - 1e-9 or (
            abs(ratio - best[0]) < 1e-9 and abs(c - pw / 2) < abs(best[1] - pw / 2)
        ):
            best = (ratio, c)
    if best and best[0] <= 0.25:
        return best[1]
    return None


# ---------- 同行碎片合并 ----------

def _merge_same_line_fragments(lines: list[dict], gutter: float | None) -> list[dict]:
    """同一视觉行上的碎片（角标、行内引用上标、断开的词）按 x 顺序合并。"""
    lines = sorted(lines, key=lambda l: (round(l["bbox"][1] / 4), l["bbox"][0]))
    out: list[dict] = []
    for l in lines:
        if out and _same_visual_line(out[-1], l, gutter):
            prev = out[-1]
            prev["text"] = _join_fragment(prev["text"], l["text"])
            prev["bbox"] = (
                min(prev["bbox"][0], l["bbox"][0]),
                min(prev["bbox"][1], l["bbox"][1]),
                max(prev["bbox"][2], l["bbox"][2]),
                max(prev["bbox"][3], l["bbox"][3]),
            )
            prev["size"] = max(prev["size"], l["size"])
            prev["bold"] = prev["bold"] or l["bold"]
        else:
            out.append(dict(l))
    return out


def _same_visual_line(a: dict, b: dict, gutter: float | None) -> bool:
    if _side(a["bbox"], gutter) != _side(b["bbox"], gutter):
        return False
    ay0, ay1 = a["bbox"][1], a["bbox"][3]
    by0, by1 = b["bbox"][1], b["bbox"][3]
    overlap = min(ay1, by1) - max(ay0, by0)
    if overlap <= 0.55 * min(ay1 - ay0, by1 - by0):
        return False
    if abs(a["size"] - b["size"]) > 3:
        return False
    gap_x = (b["bbox"][0] - a["bbox"][2]) if b["bbox"][0] >= a["bbox"][2] else (a["bbox"][0] - b["bbox"][2])
    return gap_x < 28


def _join_fragment(a: str, b: str) -> str:
    a = a.rstrip()
    b = b.strip()
    if not a:
        return b
    if not b:
        return a
    if a.endswith("-") and b[0].islower():
        return a[:-1] + b
    if b[0] in _PUNCT_NO_SPACE:
        return a + b
    return a + " " + b


# ---------- 段落聚类与阅读顺序 ----------

def _build_reading_order(
    lines: list[dict], images: list["pymupdf.Rect"], gutter: float | None
) -> list[dict]:
    """返回按阅读顺序排列的段落/图片 item。全宽项为分带边界，栏内按带聚类。"""
    for l in lines:
        l["side"] = _side(l["bbox"], gutter)

    # 全宽内容：聚类成段（多行标题/摘要），作为分带项
    full_lines = sorted((l for l in lines if l["side"] == "full"), key=lambda l: l["bbox"][1])
    full_items = _cluster_paragraphs(full_lines)

    def image_item(r: "pymupdf.Rect") -> dict:
        return {
            "is_image": True,
            "bbox": (r.x0, r.y0, r.x1, r.y1),
            "text": "",
            "font_size": 9.5,
            "side": _side((r.x0, r.y0, r.x1, r.y1), gutter),
        }

    full_items += [image_item(r) for r in images if _side((r.x0, r.y0, r.x1, r.y1), gutter) == "full"]
    full_items.sort(key=lambda it: it["bbox"][1])

    def band_of(y0: float) -> int:
        return sum(1 for it in full_items if it["bbox"][3] <= y0)

    groups: dict[tuple[int, str], list] = {}
    for l in lines:
        side = l["side"]
        if side == "full":
            continue
        groups.setdefault((band_of(l["bbox"][1]), side), []).append(l)
    for r in images:
        side = _side((r.x0, r.y0, r.x1, r.y1), gutter)
        if side == "full":
            continue
        groups.setdefault((band_of(r.y0), side), []).append(image_item(r))

    left_by_band: dict[int, list] = {}
    right_by_band: dict[int, list] = {}
    for (band, side), items in groups.items():
        lines_only = [it for it in items if not it.get("is_image")]
        imgs = [it for it in items if it.get("is_image")]
        merged = _cluster_paragraphs(sorted(lines_only, key=lambda it: it["bbox"][1])) + imgs
        merged.sort(key=lambda it: it["bbox"][1])
        (left_by_band if side == "left" else right_by_band)[band] = merged

    result: list[dict] = []
    for b in range(len(full_items) + 1):
        result.extend(left_by_band.get(b, []))
        result.extend(right_by_band.get(b, []))
        if b < len(full_items):
            result.append(full_items[b])

    # 记录分组来源，桥接“短末行落到邻栏”造成的断段，然后剥离元数据
    for it in result:
        it["_band"] = 0
        it["_side"] = "full"
    for b, items in left_by_band.items():
        for it in items:
            it["_band"], it["_side"] = b, "left"
    for b, items in right_by_band.items():
        for it in items:
            it["_band"], it["_side"] = b, "right"
    for idx, it in enumerate(full_items):
        it["_band"], it["_side"] = idx, "full"

    result = _bridge_continuations(result)
    for it in result:
        it.pop("_band", None)
        it.pop("_side", None)
    return result


def _bridge_continuations(items: list[dict]) -> list[dict]:
    """跨分组的紧邻续段合并：上一段（通常为全宽段）下方贴着、左对齐、同字号的
    短段（因未跨栏而被分到栏组）并回上一段。"""
    out: list[dict] = []
    for it in items:
        if out and _can_bridge(out[-1], it) and not _opposite_column_content(items, out[-1], it):
            prev = out[-1]
            prev["text"] = _join_fragment(prev["text"], it["text"])
            prev["bbox"] = (
                min(prev["bbox"][0], it["bbox"][0]),
                min(prev["bbox"][1], it["bbox"][1]),
                max(prev["bbox"][2], it["bbox"][2]),
                max(prev["bbox"][3], it["bbox"][3]),
            )
        else:
            out.append(it)
    return out


def _opposite_column_content(all_items: list[dict], prev: dict, cur: dict) -> bool:
    """cur 所在栏的对侧栏在 prev.y1 与 cur.y1 之间已有正文 → 此处已是分栏区，
    cur 是栏内正文而非全宽段的续行（全宽图注紧贴左栏正文的情况）。"""
    side = cur.get("_side")
    if side not in ("left", "right"):
        return False
    opp = "right" if side == "left" else "left"
    y_from, y_to = prev["bbox"][3], cur["bbox"][1]
    for it in all_items:
        if it is prev or it is cur or it.get("is_image"):
            continue
        if it.get("_side") == opp and y_from - 5 <= it["bbox"][1] <= y_to + 5:
            return True
    return False


def _can_bridge(prev: dict, cur: dict) -> bool:
    if prev.get("is_image") or cur.get("is_image"):
        return False
    if (prev.get("_band"), prev.get("_side")) == (cur.get("_band"), cur.get("_side")):
        return False  # 同组内的拆分是聚类规则有意为之
    gap = cur["bbox"][1] - prev["bbox"][3]
    h = min(prev["bbox"][3] - prev["bbox"][1], cur["bbox"][3] - cur["bbox"][1])
    if gap < -2 or gap > max(6, 0.9 * h):
        return False
    if cur["bbox"][0] < prev["bbox"][0] - 3:
        return False
    if abs(cur["font_size"] - prev["font_size"]) > 1.2:
        return False
    # A caption/title is never a continuation of the following body paragraph.
    if re.match(r'^(?:Fig(?:ure)?\.?|Table)\s*\d', prev['text'], re.I):
        return False
    return not prev['text'].rstrip().endswith(('.', '!', '?'))


def _cluster_paragraphs(lines: list[dict]) -> list[dict]:
    """把同一栏内（y 已排序）的行聚成段落：行距跳变/字号变化/段首缩进/短行收尾分段。"""
    if not lines:
        return []
    x0 = min(l["bbox"][0] for l in lines)
    x1 = max(l["bbox"][2] for l in lines)
    col_w = max(1.0, x1 - x0)

    groups: list[list[dict]] = [[lines[0]]]
    for ln in lines[1:]:
        prev = groups[-1][-1]
        px0, py0, px1, py1 = prev["bbox"]
        cx0, cy0, cx1, cy1 = ln["bbox"]
        h = max(py1 - py0, 1.0)
        gap = cy0 - py1
        size_diff = abs(ln["size"] - prev["size"])
        indent = cx0 - x0
        prev_indent = px0 - x0
        prev_text = prev["text"].rstrip()
        ends_punct = prev_text.endswith((".", "!", "?", ":", ";", ")"))
        prev_right_gap = x1 - px1
        # 居中行（标题续行、图注等）：缩进与右侧留白近似对称
        cur_centered = indent > 12 and abs(indent - (x1 - cx1)) < 12

        new_para = False
        starts_special = bool(LIST_PREFIX.match(ln['text']) or CAPTION_PREFIX.match(ln['text']) or REFERENCE_HEADING.fullmatch(ln['text'].strip()) or REFERENCE_HEADING.fullmatch(prev_text))
        if starts_special or (ln['bold'] != prev['bold'] and size_diff > 0.5):
            new_para = True
        elif gap > 0.7 * h:
            new_para = True
        elif size_diff > 1.2:
            new_para = True
        elif (5 < indent < 0.25 * col_w and ends_punct and prev_indent < 5) or (
            indent > 12 and prev_indent < 5 and indent < 0.4 * col_w and not cur_centered
        ):
            # 段首缩进：上一行贴页边距、当前行缩进（跃迁才算，悬挂缩进的图注不算）
            new_para = True
        elif ends_punct and prev_right_gap > 0.12 * col_w and gap > 3:
            new_para = True

        if new_para:
            groups.append([ln])
        else:
            groups[-1].append(ln)

    paras: list[dict] = []
    for ls in groups:
        paras.append(_make_para(ls))
    return paras


def _make_para(ls: list[dict]) -> dict:
    text = ""
    for l in ls:
        t = l["text"].strip()
        if not t:
            continue
        if text and text.endswith("-") and t[0].islower():
            text = text[:-1] + t
        elif text and t[0] in _PUNCT_NO_SPACE:
            text += t
        else:
            text = (text + " " + t) if text else t
    return {
        "bbox": (
            min(l["bbox"][0] for l in ls),
            min(l["bbox"][1] for l in ls),
            max(l["bbox"][2] for l in ls),
            max(l["bbox"][3] for l in ls),
        ),
        "text": text,
        "font_size": median(l["size"] for l in ls),
        "bold": sum(len(l["text"]) for l in ls if l["bold"]) >= sum(len(l["text"]) for l in ls)*0.5,
        "line_count": len(ls),
    }


# ---------- 分类 ----------

def _classify(item: dict, body_size: float) -> str:
    text = item["text"]
    size = item["font_size"]
    if CAPTION_PREFIX.match(text):
        return "caption"
    if (size >= body_size * 1.18 and len(text) < 200) or (item.get("bold") and len(text) < 100 and item.get("line_count", 1) <= 2 and not text.rstrip().endswith((".","!","?"))):
        return "heading"
    stripped = text.lstrip()
    if LIST_PREFIX.match(stripped) and item["bbox"][3] - item["bbox"][1] < 160:
        return "list"
    if _math_density(text) > 0.22 and len(text) < 500:
        return "formula"
    return "paragraph"


def _math_density(text: str) -> float:
    if not text:
        return 0.0
    math_n = sum(1 for ch in text if ch in MATH_CHARS)
    alpha_n = sum(1 for ch in text if ch.isalpha())
    return math_n / max(1, math_n + alpha_n)


def _image_rects(page: "pymupdf.Page") -> list["pymupdf.Rect"]:
    rects: list[pymupdf.Rect] = []
    seen: set[int] = set()
    for img in page.get_images(full=True):
        xref = img[0]
        if xref in seen:
            continue
        seen.add(xref)
        try:
            rects.extend(page.get_image_rects(xref))
        except Exception:
            continue
    merged: list[pymupdf.Rect] = []
    for r in sorted(rects, key=lambda r: -abs(r)):
        drop = False
        for i, m in enumerate(merged):
            inter = r & m
            if not inter.is_empty and inter.get_area() > 0.5 * min(r.get_area(), m.get_area()):
                merged[i] = m | r
                drop = True
                break
        if not drop:
            merged.append(r)
    return [r for r in merged if r.width >= 50 and r.height >= 35]
