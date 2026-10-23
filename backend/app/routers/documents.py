from __future__ import annotations

import hashlib
import json
import re
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import and_, case, delete, func
from sqlmodel import select

from ..db import get_session
from ..models import Annotation, Block, Document, Note, Page, TranslationSegment, utcnow, TRANSLATABLE_TYPES
from ..settings_store import load_settings
from ..tasks import run_caption_recovery, run_figure_ocr, run_figures_ocr, run_parse, run_translation
from ..jobs import reserve_task, validate_provider
from ..validation import anchor, fields
from ..pdf_annotations import highlight_rects, straight_highlight

router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.post("/sample")
async def import_user_guide(background: BackgroundTasks, session=Depends(get_session)):
    """Import the shipped manual through the normal deduplicated upload path."""
    from ..config import REPO_ROOT
    guide = REPO_ROOT / "docs" / "UserGuide.pdf"
    if not guide.is_file():
        raise HTTPException(503,"使用说明书缺失，请运行 python scripts/make_user_guide.py docs/UserGuide.pdf")
    with guide.open("rb") as source:
        return await upload_document(background, UploadFile(filename="UserGuide.pdf",file=source), session)


@router.get("/sample.pdf")
def download_user_guide():
    from ..config import REPO_ROOT
    guide=REPO_ROOT/"docs"/"UserGuide.pdf"
    if not guide.is_file(): raise HTTPException(404,"使用说明书尚未生成")
    return FileResponse(guide,media_type="application/pdf",filename="UserGuide.pdf")

_SAFE_NAME = re.compile(r"[^\w.\-]+", re.UNICODE)


def _progress_by_document(session, doc_id: int | None = None) -> dict:
    # Both sides must describe the same current blocks and database snapshot.
    # Caption recovery / reference reclassification can change that set while
    # translation runs. The unique segment-per-block index prevents double counts.
    status_count = lambda status: func.sum(case((TranslationSegment.status == status, 1), else_=0))
    query = select(Block.document_id, func.count(Block.id),
                   status_count("done"), status_count("failed"), status_count("running"))
    query = query.outerjoin(TranslationSegment, and_(
        TranslationSegment.block_id == Block.id,
        TranslationSegment.document_id == Block.document_id,
    )).where(Block.block_type.in_(TRANSLATABLE_TYPES))
    if doc_id is not None:
        query = query.where(Block.document_id == doc_id)
    return {did: {"total_blocks": total, "translated": done,
                  "failed": failed, "running": running}
            for did, total, done, failed, running in session.exec(query.group_by(Block.document_id)).all()}


def _doc_progress(session, doc_id: int) -> dict:
    return _progress_by_document(session, doc_id).get(doc_id, {
        "total_blocks": 0, "translated": 0, "failed": 0, "running": 0,
    })


@router.post("")
async def upload_document(
    background: BackgroundTasks,
    file: UploadFile = File(...),
    session=Depends(get_session),
):
    from ..config import DOCS_DIR
    fd, tmp = tempfile.mkstemp(prefix="upload-", suffix=".tmp", dir=DOCS_DIR)
    digest, size = hashlib.sha256(), 0
    try:
        with os.fdopen(fd, "wb") as output:
            while chunk := await file.read(1024 * 1024):
                if size == 0 and not chunk.startswith(b"%PDF"):
                    raise HTTPException(400, "不是有效的 PDF 文件")
                size += len(chunk)
                if size > 300 * 1024 * 1024:
                    raise HTTPException(400, "文件超过 300MB 上限")
                digest.update(chunk)
                output.write(chunk)
        if size == 0:
            raise HTTPException(400, "文件为空")
        sha = digest.hexdigest()
        path = DOCS_DIR / f"{sha}.pdf"
        if not path.exists():
            os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    existing = session.exec(select(Document).where(Document.sha256 == sha)).first()
    if existing:
        if existing.status in ("parse_failed", "uploaded"):
            reserve_task(session, existing, "parsing")
            background.add_task(run_parse, existing.id)
        return existing

    safe_name = _SAFE_NAME.sub("_", file.filename or "document.pdf")[-80:] or "document.pdf"
    doc = Document(filename=safe_name, sha256=sha, file_path=str(path))
    session.add(doc)
    session.commit()
    session.refresh(doc)
    reserve_task(session, doc, "parsing")
    background.add_task(run_parse, doc.id)
    return doc


@router.get("")
def list_documents(session=Depends(get_session)):
    docs = session.exec(select(Document).order_by(Document.updated_at.desc())).all()
    progress = _progress_by_document(session)
    return [
        {
            **doc.model_dump(),
            "progress": progress.get(doc.id, {"total_blocks": 0, "translated": 0,
                                              "failed": 0, "running": 0}),
        }
        for doc in docs
    ]


@router.get("/{doc_id}")
def get_document(doc_id: int, session=Depends(get_session)):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    return {**doc.model_dump(), "progress": _doc_progress(session, doc_id)}


@router.patch("/{doc_id}/last-page")
def set_last_page(doc_id: int, body: dict, session=Depends(get_session)):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    page = body.get("last_page", 1)
    if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= max(1, doc.page_count):
        raise HTTPException(400, "页码超出文档范围")
    doc.last_page = page
    session.add(doc)
    session.commit()
    return {"last_page": doc.last_page}


@router.delete("/{doc_id}")
def delete_document(doc_id: int, session=Depends(get_session), purge_file: bool = True):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    reserve_task(session, doc, "deleting")
    session.execute(delete(TranslationSegment).where(TranslationSegment.document_id == doc_id))
    session.execute(delete(Annotation).where(Annotation.document_id == doc_id))
    session.execute(delete(Note).where(Note.document_id == doc_id))
    session.execute(delete(Block).where(Block.document_id == doc_id))
    session.execute(delete(Page).where(Page.document_id == doc_id))
    session.delete(doc)
    session.commit()
    if purge_file:
        from ..config import DOCS_DIR
        path = Path(doc.file_path).resolve()
        remaining = session.exec(select(Document.id).where(Document.file_path == doc.file_path)).first()
        if path.parent == DOCS_DIR.resolve() and remaining is None:
            try:
                path.unlink(missing_ok=True)
                export_dir = path.parent / "exports"
                if export_dir.exists() and not export_dir.is_symlink():
                    for exported in export_dir.glob(f"{doc.sha256[:16]}-annotated.pdf"):
                        exported.unlink(missing_ok=True)
            except OSError:
                return {"deleted": doc_id, "warning": "文献记录已删除，但文件被占用，请稍后清理"}
    return {"deleted": doc_id}


@router.post("/{doc_id}/parse")
def reparse_document(doc_id: int, background: BackgroundTasks, session=Depends(get_session)):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    reserve_task(session, doc, "parsing")
    background.add_task(run_parse, doc_id)
    return {"started": True}


@router.post("/{doc_id}/translate")
def translate_document(
    doc_id: int,
    background: BackgroundTasks,
    body: dict | None = None,
    session=Depends(get_session),
):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    if doc.status == "translating":
        raise HTTPException(409, "已有翻译任务在进行中")
    if doc.status not in ("ready",):
        raise HTTPException(400, f"文档当前状态为 {doc.status}，请先完成解析")
    settings = load_settings()
    provider = (body or {}).get("provider") or settings.get("provider", "mock")
    force = (body or {}).get("force", False)
    if not isinstance(force, bool):
        raise HTTPException(400, "force 必须为布尔值")
    validate_provider(provider, settings)
    reserve_task(session, doc, "translating", ready_only=True)
    background.add_task(run_translation, doc_id, provider, force)
    return {"started": True, "provider": provider}


@router.post("/{doc_id}/recover-captions")
def repair_document_captions(doc_id: int, session=Depends(get_session)):
    doc=session.get(Document,doc_id)
    if doc is None: raise HTTPException(404,"文档不存在")
    reserve_task(session,doc,"translating",ready_only=True)
    result=run_caption_recovery(doc_id)
    if result is None: raise HTTPException(503,"图注整理失败，请检查文档状态中的错误")
    return result


@router.get("/{doc_id}/blocks")
def get_blocks(doc_id: int, session=Depends(get_session)):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    blocks = session.exec(
        select(Block).where(Block.document_id == doc_id).order_by(Block.reading_order)
    ).all()
    from ..document_semantics import reference_types, legacy_typography
    types = reference_types(blocks)
    segs = {
        s.block_id: s
        for s in session.exec(
            select(TranslationSegment).where(TranslationSegment.document_id == doc_id)
        ).all()
    }
    out = []
    legacy_matrices = {}
    legacy_rotations = {}
    if any((b.extra_meta or {}).get("coordinate_space") != "visual" for b in blocks):
        import pymupdf
        with pymupdf.open(doc.file_path) as pdf:
            legacy_matrices = {i + 1: page.rotation_matrix for i, page in enumerate(pdf)}
            legacy_rotations = {i + 1: page.rotation for i, page in enumerate(pdf)}
    for b in blocks:
        seg = segs.get(b.id)
        style = legacy_typography(doc.file_path, b)
        display_type = types[b.id]
        if display_type in {"paragraph", "list"} and style.get("font_weight") == 700 and style.get("line_count", 1) <= 2 and len(b.text) < 100 and not b.text.rstrip().endswith((".", "!", "?")):
            display_type = "heading"
        bbox = b.bbox
        if (b.extra_meta or {}).get("coordinate_space") != "visual" and b.page_number in legacy_matrices:
            bbox = list(pymupdf.Rect(bbox) * legacy_matrices[b.page_number])
        out.append(
            {
                "id": b.id,
                "page_number": b.page_number,
                "block_type": display_type,
                "bbox": bbox,
                "reading_order": b.reading_order,
                "text": b.text,
                "font_size": b.font_size,
                "ocr": (b.extra_meta or {}).get("ocr"),
                "metadata": {**style, **(b.extra_meta or {}), "rotation": (b.extra_meta or {}).get("rotation", legacy_rotations.get(b.page_number, 0))},
                "translation": (
                    {
                        "text": seg.text,
                        "status": seg.status,
                        "error": seg.error,
                        "provider": seg.provider,
                        "model": seg.model,
                    }
                    if seg and types[b.id] != "reference"
                    else None
                ),
            }
        )
    return out


@router.get("/{doc_id}/file")
def get_document_file(doc_id: int, session=Depends(get_session)):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    return FileResponse(doc.file_path, media_type="application/pdf", filename=doc.filename)


@router.get("/{doc_id}/export.json")
def export_json(doc_id: int, session=Depends(get_session)):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    blocks = session.exec(select(Block).where(Block.document_id == doc_id).order_by(Block.reading_order)).all()
    translations = session.exec(select(TranslationSegment).where(TranslationSegment.document_id == doc_id)).all()
    annotations = session.exec(select(Annotation).where(Annotation.document_id == doc_id)).all()
    notes = session.exec(select(Note).where(Note.document_id == doc_id).order_by(Note.updated_at)).all()
    payload = {
        "document": doc.model_dump(),
        "blocks": [b.model_dump() for b in blocks],
        "translations": [t.model_dump() for t in translations],
        "annotations": [a.model_dump() for a in annotations],
        "notes": [n.model_dump() for n in notes],
    }
    return JSONResponse(jsonable_encoder(payload), headers={"Content-Disposition": f'attachment; filename="document-{doc_id}.json"'})


@router.get("/{doc_id}/export.md")
def export_markdown(doc_id: int, mode: str = "bilingual", session=Depends(get_session)):
    """导出 Markdown。mode: bilingual=译文+原文对照 / zh=纯译文 / source=纯原文。"""
    if mode not in ("bilingual", "zh", "source"):
        raise HTTPException(400, "mode 仅支持 bilingual / zh / source")
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    blocks = session.exec(select(Block).where(Block.document_id == doc_id).order_by(Block.reading_order)).all()
    from ..document_semantics import reference_types
    types = reference_types(blocks)
    translations = {t.block_id: t for t in session.exec(select(TranslationSegment).where(TranslationSegment.document_id == doc_id)).all()}
    annotations = session.exec(select(Annotation).where(Annotation.document_id == doc_id).order_by(Annotation.page_number)).all()
    notes = session.exec(select(Note).where(Note.document_id == doc_id).order_by(Note.updated_at)).all()

    def prefix_of(block_type: str) -> str:
        return "### " if block_type == "heading" else ("- " if block_type == "list" else "")

    lines = [f"# {doc.filename}", "", f"> 页数：{doc.page_count} · 导出自文献双栏翻译阅读器", ""]
    cur_page: int | None = None
    for b in blocks:
        block_type = types[b.id]
        if block_type not in TRANSLATABLE_TYPES and block_type != "reference":
            continue
        if b.page_number != cur_page:
            cur_page = b.page_number
            lines += ["---", "", f"## 第 {cur_page} 页", ""]
        tr = translations.get(b.id)
        t = tr.text if tr and tr.status == "done" else None
        pre = prefix_of(block_type)
        if block_type == "reference":
            lines += [b.text, ""]
        elif mode == "source":
            lines.append(f"{pre}{b.text}")
            lines.append("")
        elif mode == "zh":
            lines.append(f"{pre}{t}" if t else f"{pre}*（未译）* {b.text}")
            lines.append("")
        else:  # bilingual：译文在前，原文引用块在后
            if t:
                lines.append(f"{pre}{t}")
                lines.append("")
                lines.append(f"> {b.text}")
            else:
                lines.append(f"> {b.text}")
            lines.append("")
    if annotations:
        lines += ["---", "", "## 批注", ""]
        for a in annotations:
            lines.append(f"- 第 {a.page_number} 页 · {a.kind}：{a.content or a.selected_text}")
    if notes:
        lines += ["", "## 笔记", ""]
        for n in notes:
            lines.append(f"### {n.title}")
            if n.page_number:
                lines.append(f"第 {n.page_number} 页")
            if n.quote:
                lines.append(f"> {n.quote}")
            lines.append(n.content)
            lines.append("")
    return Response(
        "\n".join(lines),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="document-{doc_id}-{mode}.md"'},
    )


def annotated_pdf_bytes(doc_id: int, session):
    """导出核心：原生高亮/批注写入 PDF 副本并附笔记附录。路由与发布脚本共用。"""
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    import pymupdf
    annotations = session.exec(select(Annotation).where(Annotation.document_id == doc_id)).all()
    notes = session.exec(select(Note).where(Note.document_id == doc_id).order_by(Note.id)).all()
    blocks = session.exec(select(Block).where(Block.document_id == doc_id)).all()
    with pymupdf.open(doc.file_path) as pdf:
        for item in annotations:
            if not (1 <= item.page_number <= len(pdf)) or len(item.bbox) != 4:
                continue
            page = pdf[item.page_number - 1]
            visual = pymupdf.Rect(item.bbox) & page.rect
            if visual.is_empty:
                continue
            rects = highlight_rects(page, item.rects or [item.bbox], split_paragraph=item.block_id is not None)
            if not rects:
                continue
            quads = [pymupdf.Rect(r).quad * page.derotation_matrix for r in rects]
            hex_color = item.color.lstrip("#")
            color = tuple(int(hex_color[i:i+2], 16) / 255 for i in (0, 2, 4)) if re.fullmatch(r"[0-9a-fA-F]{6}", hex_color) else (1, 1, 0)
            if item.kind == "highlight" or (item.kind == "comment" and item.target == "source"):
                straight_highlight(page, rects, color, item.content or item.selected_text)
                continue  # Updating again would recreate MuPDF's curved appearance.
            elif item.kind == "underline":
                annot = page.add_underline_annot(quads)
            else:
                annot = page.add_text_annot(visual.tl * page.derotation_matrix,
                                            item.content or item.selected_text or "批注")
            if annot:
                color = item.color.lstrip("#")
                if re.fullmatch(r"[0-9a-fA-F]{6}", color):
                    annot.set_colors(stroke=tuple(int(color[i:i+2], 16) / 255 for i in (0, 2, 4)))
                annot.set_info(content=item.content or item.selected_text)
                annot.update()
        from ..note_pdf import append_notes
        append_notes(pdf, notes, annotations, blocks)
        return pdf.tobytes(garbage=4, deflate=True)


@router.get("/{doc_id}/export-annotated.pdf")
def export_annotated_pdf(doc_id: int, session=Depends(get_session)):
    """Write native PDF annotations onto a copy of the original document."""
    try:
        data = annotated_pdf_bytes(doc_id, session)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"导出 PDF 失败：{exc}") from exc
    return Response(data, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="document-{doc_id}-annotated.pdf"'})


@router.get("/{doc_id}/annotations")
def list_annotations(doc_id: int, session=Depends(get_session)):
    if session.get(Document, doc_id) is None:
        raise HTTPException(404, "文档不存在")
    return session.exec(
        select(Annotation).where(Annotation.document_id == doc_id).order_by(Annotation.created_at)
    ).all()


@router.post("/{doc_id}/import-mirror")
def import_mirror_bundle(doc_id: int, body: dict, session=Depends(get_session)):
    """合并平板镜像站导出的批注/笔记备份；内容完全相同的记录跳过。

    平板数据可能被手工编辑，因此逐条校验类型、页码、颜色和矩形，任何一条
    非法即整体拒绝（不写入半份备份）。
    """
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    if not isinstance(body, dict):
        raise HTTPException(400, "备份格式无效")
    incoming_annotations = body.get("annotations") or []
    incoming_notes = body.get("notes") or []
    if not isinstance(incoming_annotations, list) or not isinstance(incoming_notes, list):
        raise HTTPException(400, "批注和笔记必须是数组")
    if len(incoming_annotations) > 20000 or len(incoming_notes) > 20000:
        raise HTTPException(400, "备份记录数量超出限制")

    valid_blocks = set(session.exec(select(Block.id).where(Block.document_id == doc_id)).all())

    def block_ref(value):
        return value if isinstance(value, int) and not isinstance(value, bool) and value in valid_blocks else None

    def page_ref(value):
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= max(1, doc.page_count):
            raise HTTPException(400, "页码超出文档范围")
        return value

    # 先完整校验并构造记录，再写入；任何一条非法都不会留下半份备份。
    prepared_annotations: list[Annotation] = []
    for item in incoming_annotations:
        if not isinstance(item, dict):
            raise HTTPException(400, "批注记录格式无效")
        fields(item)
        prepared_annotations.append(Annotation(
            document_id=doc_id,
            block_id=block_ref(item.get("block_id")),
            page_number=page_ref(item.get("page_number", 1)),
            kind=item.get("kind") or "highlight",
            target=item.get("target") or "source",
            bbox=list(item.get("bbox") or []),
            rects=list(item.get("rects") or []),
            selected_text=str(item.get("selected_text") or ""),
            content=str(item.get("content") or ""),
            color=str(item.get("color") or "#fef08a"),
            tags=list(item.get("tags") or []),
        ))

    prepared_notes: list[Note] = []
    for item in incoming_notes:
        if not isinstance(item, dict):
            raise HTTPException(400, "笔记记录格式无效")
        fields(item)
        page = item.get("page_number")
        prepared_notes.append(Note(
            document_id=doc_id,
            title=str(item.get("title") or ""),
            content=str(item.get("content") or ""),
            page_number=page_ref(page) if page is not None else None,
            block_id=block_ref(item.get("block_id")),
            quote=str(item.get("quote") or ""),
            tags=list(item.get("tags") or []),
        ))

    added_annotations = skipped_annotations = added_notes = skipped_notes = 0
    existing_annotations = session.exec(
        select(Annotation).where(Annotation.document_id == doc_id)
    ).all()

    def annotation_fingerprint(a) -> tuple:
        return (a.page_number, a.kind, a.target, json.dumps(a.rects or []), a.selected_text or "", a.content or "", a.color or "")

    seen = {annotation_fingerprint(a) for a in existing_annotations}
    for annotation in prepared_annotations:
        fingerprint = annotation_fingerprint(annotation)
        if fingerprint in seen:
            skipped_annotations += 1
            continue
        seen.add(fingerprint)
        session.add(annotation)
        added_annotations += 1

    existing_notes = session.exec(select(Note).where(Note.document_id == doc_id)).all()

    def note_fingerprint(n) -> tuple:
        return (n.title or "", n.quote or "", n.content or "", n.page_number)

    seen_notes = {note_fingerprint(n) for n in existing_notes}
    for note in prepared_notes:
        fingerprint = note_fingerprint(note)
        if fingerprint in seen_notes:
            skipped_notes += 1
            continue
        seen_notes.add(fingerprint)
        session.add(note)
        added_notes += 1

    session.commit()
    return {
        "added_annotations": added_annotations,
        "skipped_annotations": skipped_annotations,
        "added_notes": added_notes,
        "skipped_notes": skipped_notes,
    }


def _merge_rect_list(rects: list) -> list:
    """合并相交/相邻（1.5pt 容差）的矩形为并集，用于划选高亮按段落归并。"""
    items = [list(map(float, r)) for r in rects if isinstance(r, (list, tuple)) and len(r) == 4]
    changed = True
    while changed:
        changed = False
        out: list[list[float]] = []
        for r in items:
            hit = -1
            for i, o in enumerate(out):
                same_line = min(r[3], o[3]) - max(r[1], o[1]) > 0.8 * min(r[3]-r[1], o[3]-o[1])
                if same_line and r[0] <= o[2] + 1.5 and r[2] >= o[0] - 1.5:
                    hit = i
                    break
            if hit < 0:
                out.append(r)
            else:
                o = out[hit]
                out[hit] = [min(o[0], r[0]), min(o[1], r[1]), max(o[2], r[2]), max(o[3], r[3])]
                changed = True
        items = out
    return [list(map(lambda v: round(v, 2), r)) for r in items]


@router.post("/{doc_id}/annotations")
def create_annotation(doc_id: int, body: dict, session=Depends(get_session)):
    fields(body)
    anchor(session, doc_id, body.get("page_number"), body.get("block_id"))
    if session.get(Document, doc_id) is None:
        raise HTTPException(404, "文档不存在")
    page = int(body.get("page_number") or 0)
    if page < 1:
        raise HTTPException(400, "页码无效")
    block_id = body.get("block_id")
    if block_id is not None:
        block = session.get(Block, int(block_id))
        if block is None or block.document_id != doc_id:
            raise HTTPException(400, "段落不属于该文档")
    kind = str(body.get("kind") or "comment")
    if kind not in {"highlight", "underline", "comment", "note"}:
        raise HTTPException(400, "批注类型无效")
    incoming_rects = [r for r in (body.get("rects") or []) if isinstance(r, list) and len(r) == 4]
    selected_text = str(body.get("selected_text") or "")[:20000]
    content = str(body.get("content") or "")[:20000]
    bid = int(block_id) if block_id is not None else None

    # 每次划选独立保存；同段落的不同选区可以有各自的颜色和附注。
    # 新批注：选区矩形缺失时退回段落 bbox，保证高亮可渲染
    rects = _merge_rect_list(incoming_rects) or ([list(body.get("bbox"))] if body.get("bbox") else [])
    if bid is not None and kind in {"highlight", "comment"} and body.get("target", "source") == "source" and len(rects) == 1:
        import pymupdf
        doc = session.get(Document, doc_id)
        with pymupdf.open(doc.file_path) as pdf:
            rects = highlight_rects(pdf[page - 1], rects, split_paragraph=True)
    annotation = Annotation(
        document_id=doc_id,
        block_id=bid,
        page_number=page,
        kind=kind,
        target=str(body.get("target") or "source"),
        bbox=list(body.get("bbox") or (rects[0] if rects else [])),
        rects=rects,
        selected_text=selected_text,
        content=content,
        color=str(body.get("color") or "#fef08a"),
        tags=list(body.get("tags") or []),
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    return annotation


@router.patch("/{doc_id}/annotations/{annotation_id}")
def update_annotation(doc_id: int, annotation_id: int, body: dict, session=Depends(get_session)):
    fields(body)
    annotation = session.get(Annotation, annotation_id)
    if annotation is None or annotation.document_id != doc_id:
        raise HTTPException(404, "批注不存在")
    for key in ("kind", "target", "content", "color", "selected_text", "tags", "bbox", "rects"):
        if key in body:
            setattr(annotation, key, body[key])
    annotation.updated_at = utcnow()
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    return annotation


@router.delete("/{doc_id}/annotations/{annotation_id}")
def delete_annotation(doc_id: int, annotation_id: int, session=Depends(get_session)):
    annotation = session.get(Annotation, annotation_id)
    if annotation is None or annotation.document_id != doc_id:
        raise HTTPException(404, "批注不存在")
    session.delete(annotation)
    session.commit()
    return {"deleted": annotation_id}


@router.get("/{doc_id}/notes")
def list_notes(doc_id: int, session=Depends(get_session)):
    if session.get(Document, doc_id) is None:
        raise HTTPException(404, "文档不存在")
    return session.exec(select(Note).where(Note.document_id == doc_id).order_by(Note.updated_at.desc())).all()


@router.post("/{doc_id}/notes")
def create_note(doc_id: int, body: dict, session=Depends(get_session)):
    fields(body)
    anchor(session, doc_id, body.get("page_number"), body.get("block_id"))
    if session.get(Document, doc_id) is None:
        raise HTTPException(404, "文档不存在")
    block_id = body.get("block_id")
    if block_id is not None:
        block = session.get(Block, int(block_id))
        if block is None or block.document_id != doc_id:
            raise HTTPException(400, "段落不属于该文档")
    note = Note(
        document_id=doc_id,
        title=str(body.get("title") or "未命名笔记")[:200],
        content=str(body.get("content") or "")[:50000],
        page_number=int(body["page_number"]) if body.get("page_number") else None,
        block_id=int(block_id) if block_id is not None else None,
        quote=str(body.get("quote") or "")[:20000],
        tags=list(body.get("tags") or []),
    )
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.patch("/{doc_id}/notes/{note_id}")
def update_note(doc_id: int, note_id: int, body: dict, session=Depends(get_session)):
    note = session.get(Note, note_id)
    if note is None or note.document_id != doc_id:
        raise HTTPException(404, "笔记不存在")
    fields(body)
    anchor(session, doc_id, body.get("page_number", note.page_number), body.get("block_id", note.block_id))
    for key in ("title", "content", "quote", "tags", "page_number", "block_id"):
        if key in body:
            setattr(note, key, body[key])
    note.updated_at = utcnow()
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.delete("/{doc_id}/notes/{note_id}")
def delete_note(doc_id: int, note_id: int, session=Depends(get_session)):
    note = session.get(Note, note_id)
    if note is None or note.document_id != doc_id:
        raise HTTPException(404, "笔记不存在")
    session.delete(note)
    session.commit()
    return {"deleted": note_id}




@router.post("/{doc_id}/figures/translate")
def translate_all_figures(
    doc_id: int,
    background: BackgroundTasks,
    session=Depends(get_session),
):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在")
    settings = load_settings()
    validate_provider(settings["provider"], settings)
    reserve_task(session, doc, "translating", ready_only=True)
    background.add_task(run_figures_ocr, doc_id)
    return {"started": True}


@router.post("/{doc_id}/blocks/{block_id}/ocr")
def ocr_figure(
    doc_id: int,
    block_id: int,
    background: BackgroundTasks,
    session=Depends(get_session),
):
    block = session.get(Block, block_id)
    if block is None or block.document_id != doc_id:
        raise HTTPException(404, "图形区域不存在")
    if block.block_type != "image":
        raise HTTPException(400, "仅图形区域支持 OCR")
    settings = load_settings()
    validate_provider(settings["provider"], settings)
    reserve_task(session, session.get(Document, doc_id), "translating", ready_only=True)
    background.add_task(run_figure_ocr, doc_id, block_id)
    return {"started": True}
