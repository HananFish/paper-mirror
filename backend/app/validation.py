"""Validate document anchors and user-editable fields before touching ORM rows."""
import math
import re

from fastapi import HTTPException

from .models import Block, Document


def anchor(session, doc_id, page=None, block_id=None):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    if doc.status in {"parsing", "deleting"}:
        raise HTTPException(409, "文档正在重建，请稍后再修改")
    if page is not None:
        if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= doc.page_count:
            raise HTTPException(400, "页码超出文档范围")
    if block_id is not None:
        if isinstance(block_id, bool) or not isinstance(block_id, int):
            raise HTTPException(400, "段落编号无效")
        block = session.get(Block, block_id)
        if block is None or block.document_id != doc_id:
            raise HTTPException(400, "段落不属于该文档")
        if page is not None and block.page_number != page:
            raise HTTPException(400, "段落与页码不一致")
    return doc


def rect(value):
    if not isinstance(value, list) or len(value) != 4 or any(
        isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value
    ) or value[0] >= value[2] or value[1] >= value[3] or min(value) < 0:
        raise HTTPException(400, "矩形坐标无效")
    return value


def fields(body):
    for key in ("content", "title", "quote", "selected_text", "target"):
        if key in body and (not isinstance(body[key], str) or len(body[key]) > (200 if key == "title" else 50000)):
            raise HTTPException(400, f"{key} 类型或长度无效")
    if "kind" in body and (not isinstance(body["kind"], str) or body["kind"] not in {"highlight", "underline", "comment", "note"}):
        raise HTTPException(400, "批注类型无效")
    if "target" in body and body["target"] not in {"source", "translation", "formula", "image", "table"}:
        raise HTTPException(400, "批注目标无效")
    if "color" in body and (not isinstance(body["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", body["color"])):
        raise HTTPException(400, "批注颜色无效")
    if "tags" in body and (not isinstance(body["tags"], list) or len(body["tags"]) > 50 or any(not isinstance(t, str) or len(t) > 100 for t in body["tags"])):
        raise HTTPException(400, "标签无效")
    if "bbox" in body and body["bbox"] != []:
        rect(body["bbox"])
    if "rects" in body:
        if not isinstance(body["rects"], list) or len(body["rects"]) > 1000:
            raise HTTPException(400, "选区矩形无效")
        for item in body["rects"]:
            rect(item)
