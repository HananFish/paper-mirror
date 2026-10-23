"""Compatibility for parsed documents created before typography/reference metadata."""
from functools import lru_cache
from pathlib import Path

import pymupdf

from .parsing import _extract_lines, _make_para, _caption_groups, _raster_captions, mark_reference_sections, typography


def recover_captions(session, doc, page_numbers=None, *, raster=False):
    """Add missing captions without rebuilding blocks or invalidating user anchors.

    Native recovery is cheap and offline; raster recovery is restricted to pages
    whose images the user explicitly asks to recognize.
    """
    from sqlmodel import select
    from .models import Block, utcnow
    from .layout_yolo import detect_layout
    import re
    blocks = session.exec(select(Block).where(Block.document_id == doc.id).order_by(Block.reading_order)).all()
    recovered = []
    normalize = lambda text: re.sub(r"\s+", "", text).casefold()
    with pymupdf.open(doc.file_path) as pdf:
        for pno in (page_numbers if page_numbers is not None else range(1,len(pdf)+1)):
            page = pdf[pno-1]
            rotation = page.rotation_matrix
            angle = page.rotation
            page.set_rotation(0)
            lines = _extract_lines(page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)["blocks"])
            layout = (detect_layout(page) or []) if raster else []
            regions = [r["bbox"] for r in layout if r["name"] in {"figure_caption","table_caption","table_footnote","formula_caption"}]
            _, items = _caption_groups(lines, regions)
            if raster: items += _raster_captions(page, regions, items)
            for item in items:
                box = pymupdf.Rect(item["bbox"]) * rotation
                source = normalize(item["text"])
                matched = next((b for b in blocks if b.page_number == pno and b.block_type not in {"image","table","formula"}
                                and source in normalize(b.text)
                                and (box & (pymupdf.Rect(b.bbox) if (b.extra_meta or {}).get("coordinate_space") == "visual" else pymupdf.Rect(b.bbox)*rotation)).get_area() > 0),None)
                if matched:
                    if source == normalize(matched.text) and matched.block_type != "caption":
                        matched.block_type = "caption"; session.add(matched); recovered.append(matched)
                    continue
                block = Block(document_id=doc.id, page_number=pno, block_type="caption", bbox=list(box),
                              text=item["text"], font_size=item["font_size"],
                              extra_meta={**typography(item,page.rect.width), "coordinate_space":"visual","rotation":angle},
                              reading_order=max((b.reading_order for b in blocks), default=-1)+1)
                # Keep new captions beside their page, rather than at document end.
                session.add(block); blocks.append(block); recovered.append(block)
            page.set_rotation(angle)
        if recovered:
            def position(b):
                if (b.extra_meta or {}).get("coordinate_space") == "visual": return b.bbox[1]
                return (pymupdf.Rect(b.bbox)*pdf[b.page_number-1].rotation_matrix).y0
            # Preserve the existing two-column reading order; insert only new IDs.
            new = [b for b in recovered if b.id is None]
            ordered = [b for b in blocks if b not in new]
            for block in new:
                idx = next((i for i,b in enumerate(ordered) if b.page_number > block.page_number
                            or b.page_number == block.page_number and position(b) > position(block)),len(ordered))
                ordered.insert(idx,block)
            for i,b in enumerate(ordered): b.reading_order=i; session.add(b)
            doc.updated_at=utcnow();session.add(doc)
            session.flush()
    return recovered


def reference_types(blocks):
    items = [{"text": b.text, "block_type": b.block_type} for b in blocks]
    mark_reference_sections(items)
    return {block.id: item["block_type"] for block, item in zip(blocks, items)}


def adapt_reference_types(blocks):
    types = reference_types(blocks)
    for block in blocks:
        block.block_type = types[block.id]


@lru_cache(maxsize=64)
def _native_lines(path, page_number, modified):
    with pymupdf.open(path) as pdf:
        page = pdf[page_number - 1]
        rotation = page.rotation_matrix
        page.set_rotation(0)
        lines = _extract_lines(page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)["blocks"])
        return lines, page.rect.width, rotation


def legacy_typography(path, block):
    if "font_weight" in (block.extra_meta or {}) or not block.text:
        return {}
    lines, width, rotation = _native_lines(path, block.page_number, Path(path).stat().st_mtime_ns)
    box = pymupdf.Rect(block.bbox)
    if (block.extra_meta or {}).get("coordinate_space") == "visual":
        box *= ~rotation
    matched = [line for line in lines if (pymupdf.Rect(line["bbox"]) & box).get_area() > pymupdf.Rect(line["bbox"]).get_area()*0.5]
    if not matched: return {}
    item = _make_para(matched)
    item["block_type"] = block.block_type
    if item["bold"] and len(block.text) < 100 and item["line_count"] <= 2 and not block.text.rstrip().endswith((".", "!", "?")):
        item["block_type"] = "heading"
    return typography(item, width)
