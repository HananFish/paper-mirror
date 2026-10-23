from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlmodel import select

from ..db import get_session
from ..models import Block, Document, Term, TranslationSegment
from ..settings_store import load_settings, save_settings
from ..tasks import run_retranslate_block
from ..jobs import reserve_task, validate_provider
from ..models import TRANSLATABLE_TYPES
from pydantic import ValidationError

router = APIRouter(prefix="/api", tags=["misc"])


@router.get("/health")
def health():
    return {"ok": True}


@router.get('/model-adapters')
def model_adapters():
    from ..model_adapters import adapter_catalog
    return adapter_catalog()


# ---------- 跨文档全文搜索 ----------

def _snippet(text: str, q: str, width: int = 120) -> str:
    idx = text.lower().find(q.lower())
    if idx < 0:
        return text[:width]
    start = max(0, idx - 40)
    end = min(len(text), idx + len(q) + width - 40)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return f"{prefix}{text[start:end]}{suffix}"


@router.get("/search")
def fulltext_search(q: str, limit: int = 40, session=Depends(get_session)):
    """跨文档搜索原文与译文，返回带文档/页码/片段的结果，供文献库跳转定位。"""
    q = (q or "").strip()
    if len(q) < 2:
        raise HTTPException(400, "请至少输入 2 个字符")
    limit = max(1, min(limit, 100))
    out: list[dict] = []

    src_rows = session.exec(
        select(Block, Document)
        .join(Document, Document.id == Block.document_id)
        .where(Block.text.contains(q, autoescape=True))
        .order_by(Document.updated_at.desc(), Block.reading_order)
        .limit(limit)
    ).all()
    for b, d in src_rows:
        out.append({
            "document_id": d.id,
            "doc_filename": d.filename,
            "block_id": b.id,
            "page_number": b.page_number,
            "kind": "source",
            "snippet": _snippet(b.text, q),
        })

    tr_rows = session.exec(
        select(TranslationSegment, Block, Document)
        .join(Block, Block.id == TranslationSegment.block_id)
        .join(Document, Document.id == TranslationSegment.document_id)
        .where(
            TranslationSegment.text.contains(q, autoescape=True),
            TranslationSegment.status == "done",
        )
        .order_by(Document.updated_at.desc(), Block.reading_order)
        .limit(limit)
    ).all()
    for seg, b, d in tr_rows:
        out.append({
            "document_id": d.id,
            "doc_filename": d.filename,
            "block_id": b.id,
            "page_number": b.page_number,
            "kind": "translation",
            "snippet": _snippet(seg.text, q),
        })

    # 文档新者优先，同文档内按页码
    ranked_docs = session.exec(select(Document.id).order_by(Document.updated_at.desc())).all()
    rank = {doc_id: i for i, doc_id in enumerate(ranked_docs)}
    out.sort(key=lambda r: (rank[r["document_id"]], r["page_number"], r["block_id"]))
    return out[: limit * 2]


# ---------- 术语表 ----------

@router.get("/terms")
def list_terms(session=Depends(get_session)):
    return session.exec(select(Term).order_by(Term.created_at.desc())).all()


@router.post("/terms")
def add_term(body: dict, session=Depends(get_session)):
    if any(key in body and not isinstance(body[key], str) for key in ("source", "target", "note")):
        raise HTTPException(400, "术语字段必须为文本")
    source = (body.get("source") or "").strip()
    target = (body.get("target") or "").strip()
    if not source or not target:
        raise HTTPException(400, "原词和译法都不能为空")
    term = session.exec(select(Term).where(Term.source == source)).first()
    if term is None:
        term = Term(source=source, target=target)
    term.target = target
    term.note = (body.get("note") or "").strip()
    session.add(term)
    session.commit()
    session.refresh(term)
    return term


@router.delete("/terms/{term_id}")
def delete_term(term_id: int, session=Depends(get_session)):
    term = session.get(Term, term_id)
    if term is None:
        raise HTTPException(404, "术语不存在")
    session.delete(term)
    session.commit()
    return {"deleted": term_id}


# ---------- 单段重译 ----------

@router.post("/blocks/{block_id}/retranslate")
def retranslate_block(
    block_id: int,
    background: BackgroundTasks,
    body: dict | None = None,
    session=Depends(get_session),
):
    block = session.get(Block, block_id)
    if block is None:
        raise HTTPException(404, "段落不存在")
    from ..document_semantics import reference_types
    types = reference_types(session.exec(select(Block).where(Block.document_id == block.document_id).order_by(Block.reading_order)).all())
    if types[block.id] not in TRANSLATABLE_TYPES:
        raise HTTPException(400, "此区域不支持段落重译")
    settings = load_settings()
    provider = (body or {}).get("provider") or settings["provider"]
    validate_provider(provider, settings)
    reserve_task(session, session.get(Document, block.document_id), "translating", ready_only=True)
    background.add_task(run_retranslate_block, block_id, provider)
    return {"started": True}


# ---------- 设置 ----------

@router.get("/settings")
def get_settings():
    return load_settings()


@router.put("/settings")
def put_settings(body: dict):
    try:
        return save_settings(body)
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
