"""Single-process document jobs: atomic reservation and exception recovery."""
from functools import wraps
from threading import Lock, RLock, local

from fastapi import HTTPException
from sqlalchemy import update
from sqlmodel import Session, select

from .db import engine
from .models import Block, Document, TranslationSegment, utcnow

BUSY = {"parsing", "translating"}
_registry_lock = Lock()
_locks: dict[int, RLock] = {}
_depth = local()


def reserve_task(session, doc, status, *, ready_only=False):
    with _registry_lock:
        lock = _locks.setdefault(doc.id, RLock())
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "文档已有任务进行中")
    try:
        _reserve(session, doc, status, ready_only=ready_only)
    finally:
        lock.release()


def _reserve(session, doc, status, *, ready_only=False):
    allowed = {"ready"} if ready_only else {"ready", "uploaded", "parse_failed"}
    result = session.execute(update(Document).where(
        Document.id == doc.id, Document.status.in_(allowed)
    ).values(status=status, error=None, updated_at=utcnow()))
    if result.rowcount != 1:
        session.rollback()
        raise HTTPException(409, "文档已有任务进行中，或尚未完成解析")
    if status != "deleting":
        session.commit()
        session.refresh(doc)


def validate_provider(name, settings):
    from .translators import get_provider
    try:
        return get_provider(name, settings)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


def document_task(status, *, block_task=False):
    def decorate(fn):
        @wraps(fn)
        def guarded(*args, **kwargs):
            doc_id = args[0]
            if block_task:
                with Session(engine) as session:
                    block = session.get(Block, doc_id)
                    if block is None:
                        return
                    doc_id = block.document_id
            with _registry_lock:
                lock = _locks.setdefault(doc_id, RLock())
            if not lock.acquire(blocking=False):
                return
            depths = getattr(_depth, "jobs", {})
            _depth.jobs = depths
            outer = depths.get(doc_id, 0) == 0
            depths[doc_id] = depths.get(doc_id, 0) + 1
            error = None
            try:
                with Session(engine) as session:
                    doc = session.get(Document, doc_id)
                    if doc is None:
                        return
                    doc.status, doc.error = status, None
                    doc.updated_at = utcnow()
                    session.add(doc)
                    session.commit()
                return fn(*args, **kwargs)
            except Exception as exc:
                import logging
                logging.getLogger(__name__).exception("文档 %s 任务失败", doc_id)
                error = f"{type(exc).__name__}: {exc}"[:1000]
            finally:
                try:
                    with Session(engine) as session:
                        doc = session.get(Document, doc_id)
                        if doc and outer:
                            if doc.status in BUSY:
                                doc.status = "parse_failed" if status == "parsing" and error else "ready"
                            if error:
                                doc.error = error
                            doc.updated_at = utcnow()
                            session.add(doc)
                            for segment in session.exec(select(TranslationSegment).where(
                                TranslationSegment.document_id == doc_id,
                                TranslationSegment.status == "running",
                            )).all():
                                segment.status = "failed"
                                segment.error = error or "任务中断，请重试"
                                session.add(segment)
                            session.commit()
                finally:
                    depths[doc_id] -= 1
                    lock.release()
        return guarded
    return decorate
