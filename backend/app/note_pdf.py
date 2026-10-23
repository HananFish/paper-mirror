"""Visible, paginated reading notes plus links back to the original PDF pages."""
from functools import lru_cache
from itertools import groupby

import pymupdf


def append_notes(pdf, notes, annotations, blocks):
    original_pages = len(pdf)
    block_map = {b.id: b for b in blocks}
    page_annotations = {f"A{a.id}" for a in annotations if len(a.bbox) != 4}
    entries = []
    for note in notes:
        block = block_map.get(note.block_id)
        page_number = note.page_number or (block.page_number if block else None)
        point = None
        if page_number and 1 <= page_number <= original_pages:
            source = pdf[page_number - 1]
            visual = pymupdf.Rect(block.bbox) if block and len(block.bbox) == 4 else None
            if visual and source.rotation and (block.extra_meta or {}).get("coordinate_space") != "visual":
                visual = visual * source.rotation_matrix
            point = visual.tr if visual else pymupdf.Point(source.rect.x1 - 35, 48)
        entries.append((f"N{note.id}", note.title or "未命名笔记", note.quote, note.content, page_number, point))
    for annotation in annotations:
        if annotation.content or annotation.kind in {"note", "comment"}:
            point = pymupdf.Point(*annotation.bbox[:2]) if len(annotation.bbox) == 4 else None
            entries.append((f"A{annotation.id}", "页批注" if len(annotation.bbox) != 4 else "批注", annotation.selected_text, annotation.content or annotation.selected_text or "页批注",
                            annotation.page_number, point))
    if not entries:
        return

    font = pymupdf.Font("china-s")
    latin = pymupdf.Font("helv")
    def font_for(char):
        return ("helv", latin) if 32 <= ord(char) < 127 else ("china-s", font)
    @lru_cache(maxsize=4096)
    def width(char):
        return font_for(char)[1].text_length(char, fontsize=11)

    def draw_line(text, baseline, color):
        x = 48
        for name, chars in groupby(text, key=lambda char: font_for(char)[0]):
            run = "".join(chars)
            page.insert_text((x, baseline), run, fontname=name, fontsize=11, color=color)
            x += (latin if name == "helv" else font).text_length(run, fontsize=11)

    page = None
    y = 0
    destinations = {}
    def new_page():
        nonlocal page, y
        page = pdf.new_page(width=595, height=842)
        page.insert_text((48, 40), "阅读笔记与批注", fontname="china-s", fontsize=17, color=(0.12, 0.18, 0.3))
        page.insert_text((48, 820), f"笔记附录 {len(pdf) - original_pages}", fontname="china-s", fontsize=9)
        y = 72

    def lines(text, color=(0.15, 0.15, 0.15)):
        nonlocal y
        for paragraph in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            line, used = "", 0
            for char in paragraph.replace("\t", "    "):
                char_width = width(char)
                if used + char_width > 499 and line:
                    if y > 790: new_page()
                    draw_line(line, y, color)
                    y += 17
                    line, used = "", 0
                line += char; used += char_width
            if y > 790: new_page()
            if line: draw_line(line, y, color)
            y += 17

    new_page()
    for label, title, quote, content, source_page, point in entries:
        if y > 720: new_page()
        destinations[label] = (page.number, y - 12)
        lines(f"{label}  {title}", (0.12, 0.25, 0.65))
        location = f"原文第 {source_page} 页" if source_page else "整篇文献笔记（未关联具体页码）"
        location_y = y
        lines(location, (0.35, 0.35, 0.35))
        if source_page and 1 <= source_page <= original_pages:
            source = pdf[source_page - 1]
            page.insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(48, location_y-12, 280, location_y+4),
                              "page": source_page-1, "to": (point or source.rect.tl) * source.derotation_matrix})
        if quote: lines(f"摘录：{quote}", (0.35, 0.35, 0.35))
        lines(f"正文：{content}")
        y += 16

    # Draw discoverable note badges on original pages and link them to the appendix.
    occupied = {}
    for label, title, quote, content, source_page, point in entries:
        if not source_page or not 1 <= source_page <= original_pages:
            continue
        source = pdf[source_page - 1]
        # Use the page margin so a paragraph in a two-column PDF cannot cover its neighbour.
        x = 8
        y = min(max(12, point.y if point else 48), source.rect.y1 - 24)
        used = occupied.setdefault(source_page, [])
        while any(abs(y - previous) < 20 for previous in used) and y < source.rect.y1 - 44:
            y += 20
        used.append(y)
        badge = pymupdf.Rect(x, y, x + 28, y + 16) * source.derotation_matrix
        icon_point = pymupdf.Point(x + 31, y) * source.derotation_matrix
        if label.startswith("N") or label in page_annotations:
            native = source.add_text_annot(icon_point, f"{label} {title}\n{content}")
            native.set_info(title=f"{title} {label}", subject=quote)
            native.update()
        # PDF pages use unrotated coordinates for drawing and links.
        source.draw_rect(badge, fill=(0.15, 0.3, 0.8), color=(0.15, 0.3, 0.8))
        baseline = pymupdf.Point(x + 2, y + 12) * source.derotation_matrix
        source.insert_text(baseline, label, fontsize=8, color=(1, 1, 1), rotate=source.rotation)
        dest_page, dest_y = destinations[label]
        source.insert_link({"kind": pymupdf.LINK_GOTO, "from": badge, "page": dest_page, "to": pymupdf.Point(48, dest_y)})
    pdf.set_toc(pdf.get_toc() + [[1, "阅读笔记与批注", original_pages + 1]])
