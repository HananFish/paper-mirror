"""Optional, on-demand OCR.

Native PDF text remains the primary extraction path. OCR is only invoked for a
selected image/scan region, and is deliberately optional so normal PDFs do not
pay the model startup cost.
"""
from __future__ import annotations

import os
from threading import RLock
from typing import Any


def ocr_image(image_bytes: bytes, lang: str = "eng") -> dict[str, Any]:
    """Return OCR text and word boxes using the locally installed Tesseract.

    The dependency is optional. The caller gets an actionable error when OCR is
    requested without the Python package or the Tesseract executable.
    """
    try:
        import io
        import pytesseract
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError("按需 OCR 需要安装 pytesseract 与 Pillow") from exc

    configured = os.environ.get("TESSERACT_CMD", "").strip()
    if configured:
        pytesseract.pytesseract.tesseract_cmd = configured
    image = Image.open(io.BytesIO(image_bytes))
    try:
        data = pytesseract.image_to_data(image, lang=lang, output_type=pytesseract.Output.DICT)
    except (pytesseract.TesseractNotFoundError, pytesseract.TesseractError) as exc:
        raise RuntimeError("Tesseract 不可用，请检查安装与语言包") from exc
    words: list[dict[str, Any]] = []
    lines: dict[tuple[int, int], list[str]] = {}
    for i, raw in enumerate(data.get("text", [])):
        text = (raw or "").strip()
        if not text:
            continue
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = -1
        word = {
            "text": text,
            "confidence": conf,
            "bbox": [int(data["left"][i]), int(data["top"][i]),
                     int(data["left"][i]) + int(data["width"][i]),
                     int(data["top"][i]) + int(data["height"][i])],
        }
        words.append(word)
        key = (int(data["block_num"][i]), int(data["par_num"][i]), int(data["line_num"][i]))
        lines.setdefault(key, []).append(text)
    return {
        "text": "\n".join(" ".join(parts) for parts in lines.values()),
        "words": words,
        "engine": "tesseract",
    }


# ---------- RapidOCR 提字（无 Tesseract 依赖，离线即装即用） ----------

_ocr = None
_ocr_lock = RLock()


def _get_rapidocr():
    global _ocr
    with _ocr_lock:
        if _ocr is None:
            from rapidocr_onnxruntime import RapidOCR
            _ocr = RapidOCR()
        return _ocr


def _recognize_rapidocr_png(image_bytes):
    with _ocr_lock:
        result, _ = _get_rapidocr()(image_bytes)
    return [{"quad": item[0], "src": str(item[1] or "").strip(),
             "confidence": float(item[2]) if len(item) > 2 else 1.0}
            for item in (result or []) if str(item[1] or "").strip()]


def recognize_png(image_bytes):
    from .model_adapters import create_adapter
    return create_adapter('ocr', os.environ.get('OCR_ADAPTER', 'rapidocr'), {}, {})(image_bytes)


def extract_text_from_image(doc_path: str, page_number: int, bbox: list) -> str:
    return "\n".join(line["src"] for line in extract_lines_with_boxes(doc_path, page_number, bbox))


def _usable_native_text(text: str) -> bool:
    """Broken font maps can yield controls instead of the visible glyphs."""
    import unicodedata
    chars = [char for char in text if not char.isspace()]
    if not chars:
        return False
    bad = sum(char == '\ufffd' or unicodedata.category(char) in {'Cc', 'Cs', 'Co', 'Cn'} for char in chars)
    # PDF lines have no legitimate embedded line breaks or control characters.
    return not any(unicodedata.category(char) == 'Cc' for char in text) and bad / len(chars) < .1


def extract_lines_with_boxes(doc_path: str, page_number: int, bbox: list, dpi: int = 240) -> list[dict]:
    """Prefer vector text; fuse raster OCR with trustworthy native labels when needed."""
    import pymupdf
    with pymupdf.open(doc_path) as pdf:
        page = pdf[page_number - 1]
        rotation_matrix = page.rotation_matrix
        rect = pymupdf.Rect(bbox) * page.derotation_matrix
        page.set_rotation(0)
        rect &= page.rect
        if rect.is_empty:
            return []
        native = []
        damaged_native = False
        for block in page.get_text("dict", clip=rect).get("blocks", []):
            for line in block.get("lines", []):
                text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                box = pymupdf.Rect(line["bbox"]) & rect
                if text and not _usable_native_text(text):
                    damaged_native = True
                    continue
                if text and not box.is_empty:
                    native.append({"pbox": list(box * rotation_matrix), "src": text,
                                   "confidence": 1.0, "engine": "pdf-text"})
        raster = any((pymupdf.Rect(image["bbox"]) & rect).get_area() > rect.get_area() * 0.1
                     for image in page.get_image_info())
        if native and not raster and not damaged_native:
            return sorted(native, key=lambda item: (item["pbox"][1], item["pbox"][0]))
        scale = min(dpi / 72.0, (6_000_000 / rect.get_area()) ** 0.5)
        pix = page.get_pixmap(clip=rect, matrix=pymupdf.Matrix(scale, scale), alpha=False)
        origin_x, origin_y = pix.x, pix.y
        png = pix.tobytes("png")
    lines = list(native)
    for item in recognize_png(png):
        xs, ys = zip(*item["quad"])
        box = pymupdf.Rect((origin_x + min(xs))/scale, (origin_y + min(ys))/scale,
                           (origin_x + max(xs))/scale, (origin_y + max(ys))/scale) & rect
        if box.is_empty: continue
        visual = box * rotation_matrix
        # Native text wins over overlapping OCR; do not double-translate PDF labels.
        if any((visual & pymupdf.Rect(line["pbox"])).get_area() > visual.get_area() * 0.5 for line in native):
            continue
        lines.append({"pbox": [round(v, 2) for v in visual], "src": item["src"],
                      "confidence": item["confidence"], "engine": "rapidocr"})
    return sorted(lines, key=lambda item: (item["pbox"][1], item["pbox"][0]))
