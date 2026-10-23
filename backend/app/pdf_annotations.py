"""Line geometry and straight-edged native PDF highlight appearances."""
import pymupdf
import re


def highlight_rects(page, rects, split_paragraph=False):
    visual_rects = [pymupdf.Rect(r) & page.rect for r in rects if len(r) == 4]
    visual_rects = [r for r in visual_rects if not r.is_empty]
    if split_paragraph and len(visual_rects) == 1:
        selection = visual_rects[0]
        native = selection * page.derotation_matrix
        lines = []
        for block in page.get_text("dict", clip=native).get("blocks", []):
            for line in block.get("lines", []):
                candidate = (pymupdf.Rect(line["bbox"]) * page.rotation_matrix) & selection
                if not candidate.is_empty and any(span.get("text", "").strip() for span in line.get("spans", [])):
                    lines.append(candidate)
        if len(lines) > 1:
            visual_rects = lines
    return [list(r) for r in visual_rects]


def straight_highlight(page, rects, color, content):
    """Keep Highlight/QuadPoints semantics, replacing the curved appearance with rectangles."""
    native = [pymupdf.Rect(r) * page.derotation_matrix for r in rects]
    annot = page.add_highlight_annot([r.quad for r in native])
    annot.set_colors(stroke=color)
    annot.set_opacity(0.4)
    annot.set_info(content=content)
    annot.update()
    pdf = page.parent
    kind, reference = pdf.xref_get_key(annot.xref, "AP/N")
    if kind != "xref":
        raise ValueError("高亮外观生成失败")
    appearance = int(reference.split()[0])
    # MuPDF has already converted QuadPoints to PDF coordinates, including CropBox
    # offsets. Reusing them avoids the rotated CropBox transformation ambiguity.
    quad_string = pdf.xref_get_key(annot.xref, "QuadPoints")[1]
    coordinates = [float(v) for v in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", quad_string)]
    pdf_rects = []
    for index in range(0, len(coordinates), 8):
        quad = coordinates[index:index+8]
        pdf_rects.append(pymupdf.Rect(min(quad[::2]), min(quad[1::2]), max(quad[::2]), max(quad[1::2])))
    bounds = pymupdf.Rect(pdf_rects[0])
    for rect in pdf_rects[1:]: bounds |= rect
    rectangle = "[" + " ".join(f"{v:.6f}" for v in bounds) + "]"
    # Matching the annotation and appearance bounds prevents viewer rescaling.
    pdf.xref_set_key(annot.xref, "Rect", rectangle)
    pdf.xref_set_key(appearance, "BBox", rectangle)
    commands = ["q", "/H gs", " ".join(f"{v:.6f}" for v in color) + " rg"]
    for rect in pdf_rects:
        commands.append(f"{rect.x0:.6f} {rect.y0:.6f} {rect.width:.6f} {rect.height:.6f} re f")
    commands.append("Q")
    pdf.update_stream(appearance, "\n".join(commands).encode("ascii"))
    return annot
