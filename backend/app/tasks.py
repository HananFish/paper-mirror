"""后台任务：解析与翻译。由 FastAPI BackgroundTasks 在线程池中执行（同步函数）。"""
from __future__ import annotations

import hashlib
import json
import re
import time

from sqlalchemy.dialects.sqlite import insert
from sqlalchemy import delete, text
from sqlmodel import Session, select

from .db import engine
from .jobs import document_task
from .models import (
    Annotation,
    Block,
    Document,
    Note,
    Page,
    Term,
    TranslationMemory,
    TranslationSegment,
    TRANSLATABLE_TYPES,
    utcnow,
)
from .parsing import parse_pdf_file
from .document_semantics import adapt_reference_types, recover_captions
from .settings_store import load_settings
from .translators import cache_key, get_provider


def tm_key(lang: str, text: str, glossary=None) -> str:
    """翻译记忆键：目标语言 + 原文。不包含服务商/模型，任何来源的译文都可复用。"""
    h = hashlib.sha256()
    h.update(lang.encode())
    h.update(b"\n\x00\n")
    h.update(text.encode("utf-8"))
    if glossary:
        h.update(json.dumps(sorted(glossary), ensure_ascii=False).encode("utf-8"))
    return h.hexdigest()


def _tm_lookup(session: Session, keys: list[str]) -> dict[str, TranslationMemory]:
    if not keys:
        return {}
    rows = []
    for start in range(0, len(keys), 900):
        rows.extend(session.exec(select(TranslationMemory).where(
            TranslationMemory.src_hash.in_(keys[start:start+900]))).all())
    return {r.src_hash: r for r in rows}


def _tm_store(session: Session, lang: str, source: str, translation: str,
              provider: str, model: str, glossary=None) -> None:
    if provider == "mock" or not source.strip() or not translation.strip():
        return
    values = dict(src_hash=tm_key(lang, source, glossary), source_text=source,
                  translated_text=translation, provider=provider, model=model, lang=lang)
    session.execute(insert(TranslationMemory).values(**values).on_conflict_do_update(
        index_elements=["src_hash"], set_=values))


def _segment_key(settings, provider_name, model, source, glossary):
    cfg = settings.get("openai", {}) if provider_name == "openai" else {}
    return cache_key(provider_name, model, source, {
        "target_lang": settings.get("target_lang", "zh"),
        "base_url": cfg.get("base_url"), "protocol": cfg.get("protocol"),
        "adapter": cfg.get("adapter", "openai") if provider_name == "openai" else None,
        "glossary": sorted(glossary),
    })


def _touch(session, doc: Document, **fields) -> None:
    for k, v in fields.items():
        setattr(doc, k, v)
    from .models import utcnow

    doc.updated_at = utcnow()
    session.add(doc)


def _norm_text(s: str) -> str:
    """归一化引文/正文：去除全部空白，容忍换行与空格差异。"""
    import re

    return re.sub(r"\s+", "", s or "")


@document_task("parsing")
def run_parse(document_id: int) -> None:
    with engine.begin() as conn:
        pass  # 确保 WAL 已初始化
    with Session(engine) as session:
        doc = session.get(Document, document_id)
        if doc is None:
            return
        _touch(session, doc, status="parsing", error=None)
        session.commit()
        try:
            pages, blocks = parse_pdf_file(doc.file_path)
            # 批注先摘除挂接（否则外键阻止删除段落），解析完按引文重新挂接
            # 批注与笔记都外键引用 block，删除前一律摘除挂接，
            # 解析完成后按引文重新挂接（批注按 selected_text、笔记按 quote）
            session.execute(
                text("UPDATE annotation SET block_id = NULL WHERE document_id = :d"),
                {"d": document_id},
            )
            session.execute(
                text("UPDATE note SET block_id = NULL WHERE document_id = :d"),
                {"d": document_id},
            )
            # 重新解析会重建 blocks，旧译文随旧 block 一起删除（计划文档 §9：解析中间结果可检查可重建）
            session.execute(delete(TranslationSegment).where(TranslationSegment.document_id == document_id))
            session.execute(delete(Block).where(Block.document_id == document_id))
            session.execute(delete(Page).where(Page.document_id == document_id))
            for p in pages:
                session.add(Page(document_id=document_id, **p))
            for b in blocks:
                session.add(Block(document_id=document_id, **b))
            session.commit()

            # 批注重新挂接：页码一致且归一化引文出现在新段落中
            anns = session.exec(
                select(Annotation).where(
                    Annotation.document_id == document_id,
                    Annotation.block_id == None,  # noqa: E711
                )
            ).all()
            new_blocks = session.exec(
                select(Block).where(Block.document_id == document_id)
            ).all()
            notes = session.exec(
                select(Note).where(
                    Note.document_id == document_id,
                    Note.block_id == None,  # noqa: E711
                )
            ).all()
            reattached = 0
            for note in notes:
                q = _norm_text(note.quote)[:80]
                if not q:
                    continue
                for b in new_blocks:
                    if b.page_number == note.page_number and q in _norm_text(b.text):
                        note.block_id = b.id
                        session.add(note)
                        reattached += 1
                        break
            for ann in anns:
                q = _norm_text(ann.selected_text)[:80]
                if not q:
                    continue
                for b in new_blocks:
                    if b.page_number == ann.page_number and q in _norm_text(b.text):
                        ann.block_id = b.id
                        session.add(ann)
                        reattached += 1
                        break
            _touch(session, doc, status="ready", page_count=len(pages))
            session.commit()
            if anns:
                print(f"[parse] doc{document_id}: 批注 {len(anns)} 条，重新挂接 {reattached} 条")
        except Exception as e:  # noqa: BLE001
            session.rollback()
            doc = session.get(Document, document_id)
            if doc:
                _touch(session, doc, status="parse_failed", error=repr(e)[:1000])
                session.commit()
            return
        # 自动翻译：解析成功后按设置直接开翻（命中翻译记忆的段落零成本）
        if load_settings().get("auto_translate"):
            try:
                st = load_settings()
                run_translation(document_id, st.get("provider", "mock"), False)
            except Exception as e:  # noqa: BLE001
                # 翻译失败不影响解析结果；文档停在 ready，可手动重试
                print(f"[parse] doc{document_id}: 自动翻译启动失败 {e!r}")
                with Session(engine) as s2:
                    d2 = s2.get(Document, document_id)
                    if d2 and d2.status == "translating":
                        _touch(s2, d2, status="ready")
                        s2.commit()


def _ensure_segments(session, blocks: list[Block], doc_id: int, provider_name: str, model: str) -> None:
    existing = {
        s.block_id: s
        for s in session.exec(
            select(TranslationSegment).where(TranslationSegment.document_id == doc_id)
        ).all()
    }
    for b in blocks:
        seg = existing.get(b.id)
        key = cache_key(provider_name, model, b.text)
        if seg is None:
            session.add(
                TranslationSegment(
                    block_id=b.id, document_id=doc_id, status="pending", cache_key=key
                )
            )


@document_task("translating")
def run_translation(document_id: int, provider_name: str, force: bool = False) -> None:
    settings = load_settings()
    model = (
        settings["openai"]["model"] if provider_name == "openai" else "mock-1"
    )
    provider = get_provider(provider_name, settings)
    target_lang = settings.get("target_lang", "zh")

    with Session(engine) as session:
        doc = session.get(Document, document_id)
        if doc is None:
            return
        _touch(session, doc, status="translating")
        session.commit()

        recover_captions(session, doc)
        all_blocks = session.exec(
            select(Block)
            .where(Block.document_id == document_id)
            .order_by(Block.reading_order)
        ).all()
        adapt_reference_types(all_blocks)
        for block in all_blocks:
            session.add(block)
        blocks = [b for b in all_blocks if b.block_type in TRANSLATABLE_TYPES]
        _ensure_segments(session, blocks, document_id, provider_name, model)
        session.commit()

        glossary = [(t.source, t.target) for t in session.exec(select(Term).where(Term.forced == True)).all()]
        key = lambda b: _segment_key(settings, provider_name, model, b.text, glossary)
        segs = {
            s.block_id: s
            for s in session.exec(
                select(TranslationSegment).where(TranslationSegment.document_id == document_id)
            ).all()
        }

        # 翻译记忆：重解析/重复导入/跨文档重复内容直接复用，不调用翻译服务。
        # force=True 表示用户明确要求重翻，跳过记忆。
        if not force and provider_name != "mock":
            key_of = {b.id: tm_key(target_lang, b.text, glossary) for b in blocks}
            tm_rows = _tm_lookup(session, list(set(key_of.values())))
            tm_hits = 0
            for b in blocks:
                row = tm_rows.get(key_of[b.id])
                if row is None or row.provider == "mock":
                    continue
                seg = segs.get(b.id)
                if seg is None or (seg.status == "done" and seg.cache_key == key(b)):
                    continue
                seg.text = row.translated_text
                seg.status = "done"
                seg.provider = f"tm:{row.provider}"
                seg.model = row.model
                seg.cache_key = key(b)
                seg.char_count = len(row.translated_text)
                seg.error = None
                tm_hits += 1
            if tm_hits:
                session.commit()

        batch_size = max(1, int(settings.get("batch_size", 8)))
        for start in range(0, len(blocks), batch_size):
            batch = blocks[start : start + batch_size]
            todo = []
            for b in batch:
                seg = segs.get(b.id)
                if seg is None:
                    continue
                if not force and seg.status == "done" and seg.cache_key == key(b):
                    continue  # 缓存命中，不重复计费
                todo.append((b, seg))
            if not todo:
                continue
            for _, seg in todo:
                seg.status = "running"
                seg.error = None
            session.commit()

            texts = [b.text for b, _ in todo]
            ctx = "" if start == 0 else blocks[start - 1].text
            outputs = _translate_with_fallback(provider, texts, glossary, ctx)

            for (b, seg), out in zip(todo, outputs):
                if out is None:
                    seg.status = "failed"
                    seg.retry_count += 1
                    seg.error = getattr(provider, "last_error", "翻译失败，请检查配置并重试")
                else:
                    seg.text = out
                    seg.status = "done"
                    seg.provider = provider_name
                    seg.model = provider.model
                    seg.cache_key = key(b)
                    seg.char_count = len(out)
                    _tm_store(session, target_lang, b.text, out, provider_name, provider.model, glossary)
                seg.updated_at = utcnow()
            session.commit()

        _touch(session, doc, status="translating")
        session.commit()


def _translate_with_fallback(provider, texts, glossary, context) -> list[str | None]:
    """先整批翻译；失败（如编号对不上）则逐条重试。

    返回与 texts 等长的列表，失败位置为 None（已重试仍失败），其余为译文。
    """
    try:
        outputs = list(provider.translate(texts, glossary, context))
        if len(outputs) != len(texts) or any(t is not None and (not isinstance(t, str) or not t.strip()) for t in outputs):
            raise ValueError("翻译数量不匹配或包含空译文")
        return outputs
    except Exception as exc:
        provider.last_error = f"{type(exc).__name__}: {exc}"[:500]
        if len(texts) == 1:
            return [None]
    outputs: list[str | None] = []
    for t in texts:
        try:
            out = list(provider.translate([t], glossary, context))
            if len(out) != 1 or not isinstance(out[0], str) or not out[0].strip():
                raise ValueError("翻译返回空结果")
            outputs.append(out[0])
            time.sleep(0.2)
        except Exception as exc:  # noqa: BLE001
            provider.last_error = f"{type(exc).__name__}: {exc}"[:500]
            outputs.append(None)
    return outputs


@document_task("translating", block_task=True)
def run_retranslate_block(block_id: int, provider_name: str | None = None) -> None:
    with Session(engine) as session:
        block = session.get(Block, block_id)
        if block is not None:
            adapt_reference_types(session.exec(select(Block).where(Block.document_id == block.document_id).order_by(Block.reading_order)).all())
        if block is None or block.block_type not in TRANSLATABLE_TYPES:
            return
        settings = load_settings()
        provider_name = provider_name or settings.get("provider", "mock")
        provider = get_provider(provider_name, settings)
        seg = session.exec(
            select(TranslationSegment).where(TranslationSegment.block_id == block_id)
        ).first()
        if seg is None:
            seg = TranslationSegment(block_id=block_id, document_id=block.document_id)
        seg.status = "running"
        seg.error = None
        session.add(seg)
        session.commit()
        glossary = [(t.source, t.target) for t in session.exec(select(Term).where(Term.forced == True)).all()]
        try:
            out = provider.translate([block.text], glossary, "")[0]
            if not isinstance(out, str) or not out.strip():
                raise ValueError("翻译返回空结果")
            seg.text = out
            seg.status = "done"
            seg.provider = provider_name
            seg.model = provider.model
            seg.cache_key = _segment_key(settings, provider_name, provider.model, block.text, glossary)
            seg.char_count = len(out)
            _tm_store(session, settings.get("target_lang", "zh"), block.text, out,
                      provider_name, provider.model, glossary)
        except Exception as e:  # noqa: BLE001
            seg.status = "failed"
            seg.retry_count += 1
            seg.error = repr(e)[:500]
        from .models import utcnow

        seg.updated_at = utcnow()
        session.add(seg)
        session.commit()


# ---------- 图形区域 OCR：逐行坐标提字 + 逐行翻译，原位贴回 ----------



def _store_ocr(block_id: int, state: dict) -> None:
    with Session(engine) as session:
        block = session.get(Block, block_id)
        if block is None:
            return
        meta = dict(block.extra_meta or {})
        meta["ocr"] = state
        block.extra_meta = meta
        session.add(block)
        doc = session.get(Document, block.document_id)
        if doc:
            doc.updated_at = utcnow()
            session.add(doc)
        session.commit()


def _cluster_ocr_lines(raw_lines: list[dict]) -> list[dict]:
    """Conservatively join wrapped prose; keep chart labels/cells separate."""
    clusters = []
    for line in sorted(raw_lines, key=lambda item: (item["pbox"][1], item["pbox"][0])):
        box = line["pbox"]
        words = len(re.findall(r"[A-Za-z]+", line["src"]))
        previous = clusters[-1] if clusters else None
        if previous:
            last = previous["members"][-1]
            old = last["pbox"]
            height = min(box[3]-box[1], old[3]-old[1])
            gap = box[1]-old[3]
            join = (height > 0 and 0 <= gap <= height*0.4 and abs(box[0]-old[0]) < height*0.7
                    and words >= 4 and len(re.findall(r"[A-Za-z]+", last["src"])) >= 5
                    and not re.search(r"[.!?:;]$", last["src"].strip())
                    and min(line.get("confidence",1), last.get("confidence",1)) >= 0.7)
        else: join = False
        if join:
            previous["src"] += " " + line["src"]
            previous["pbox"] = [min(previous["pbox"][0],box[0]), previous["pbox"][1],
                                max(previous["pbox"][2],box[2]),box[3]]
            previous["nlines"] += 1
            previous["confidence"] = min(previous["confidence"],line.get("confidence",1))
            previous["members"].append(line)
        else:
            clusters.append({**line, "pbox": list(box), "nlines": 1, "confidence": line.get("confidence",1), "members": [line]})
    return [{key: value for key,value in cluster.items() if key != "members"} for cluster in clusters]


def _translate_image_label(text: str, target_lang: str) -> bool:
    if re.fullmatch(r"[\d\s.,+\-/%×]+(?:ms|s|mm|cm|m|kg|g|Hz|kHz|MHz|GHz|K|°C|dB|V|W)?", text.strip(), re.I):
        return False
    words = re.findall(r"[A-Za-z]{2,}", text)
    if not words:
        return not target_lang.lower().startswith("zh") and bool(re.search(r"[一-鿿]{2}",text))
    if re.search(r"[=<>≤≥∑∫^]|\\(?:frac|sum|alpha)", text) and len(words) <= 3:
        return False
    compact = text.strip()
    if compact.isupper() and len(compact) <= 6 and compact not in {"INPUT","OUTPUT","LOSS","LAYER","MODEL","TRAIN"}:
        return False
    return True


@document_task("translating")
def run_figure_ocr(document_id: int, block_id: int, force: bool = True) -> None:
    caption_result = _translate_figure_captions(document_id, block_id)
    with Session(engine) as session:
        block = session.get(Block, block_id)
        doc = session.get(Document, document_id)
        if block is None or doc is None or block.document_id != document_id: return
        doc_path, page_number, bbox = doc.file_path, block.page_number, list(block.bbox)
        settings = load_settings()
        provider_name = settings.get("provider","mock")
        glossary = [(t.source,t.target) for t in session.exec(select(Term).where(Term.forced == True)).all()]
        neighbours = session.exec(select(Block).where(Block.document_id==document_id, Block.page_number==page_number).order_by(Block.reading_order)).all()
        # Old parsed blocks use unrotated PDF coordinates; extraction expects visual coordinates.
        if any((b.extra_meta or {}).get("coordinate_space") != "visual" for b in [block, *neighbours]):
            import pymupdf
            with pymupdf.open(doc_path) as pdf:
                rotation = pdf[page_number - 1].rotation_matrix
            if (block.extra_meta or {}).get("coordinate_space") != "visual":
                bbox = list(pymupdf.Rect(bbox) * rotation)
            neighbour_boxes = {b.id: list(pymupdf.Rect(b.bbox) * rotation) if (b.extra_meta or {}).get("coordinate_space") != "visual" else b.bbox
                               for b in neighbours if len(b.bbox or []) == 4}
        else:
            neighbour_boxes = {b.id: b.bbox for b in neighbours if len(b.bbox or []) == 4}
        # Captions nearest the figure are more useful than unrelated page/header text.
        neighbours = sorted((b for b in neighbours if b.block_type in TRANSLATABLE_TYPES and len(b.bbox or []) == 4),
                            key=lambda b: min(abs(neighbour_boxes[b.id][1]-bbox[3]),abs(neighbour_boxes[b.id][3]-bbox[1])))
        context = "\n".join(b.text for b in neighbours[:2])[-600:]
        model = settings.get(provider_name,{}).get("model","mock")
        import os
        ocr_adapter = os.environ.get('OCR_ADAPTER', 'rapidocr')
        signature = _segment_key(settings,provider_name,model,f"image-v4:{ocr_adapter}:{doc.sha256}:{page_number}:{bbox}:{context}",glossary)
        old = (block.extra_meta or {}).get("ocr",{})
        if not force and old.get("status")=="done" and old.get("cache_key")==signature:
            _store_ocr(block_id,{**old,"captions":caption_result,"status":"partial" if caption_result["failed"] else "done"})
            return
    out = []
    _store_ocr(block_id,{"status":"running","lines":[],"phase":"recognizing"})
    from .ocr import extract_lines_with_boxes
    try:
        clusters = _cluster_ocr_lines(extract_lines_with_boxes(doc_path,page_number,bbox))
        if not clusters:
            _store_ocr(block_id,{"status":"partial" if caption_result["failed"] else "done","lines":[],
                "captions":caption_result,"warning":"未识别到图内文字；图注单独处理。请尝试框选区域或视觉识别", "cache_key":signature})
            return
        out = [{**cl,"dst":cl["src"],"status":"preserved"} for cl in clusters]
        indices = []
        for i, line in enumerate(out):
            if line["confidence"] < 0.7: line["status"]="review"
            elif _translate_image_label(line["src"],settings["target_lang"]):
                line["status"]="pending"; indices.append(i)
        provider = get_provider(provider_name,settings) if indices else None
        chunk_size = settings["batch_size"]
        for start in range(0,len(indices),chunk_size):
            batch = indices[start:start+chunk_size]
            _store_ocr(block_id,{"status":"running","phase":"translating","lines":list(out),"total":len(indices),"completed":start})
            translated = _translate_with_fallback(provider,[out[i]["src"] for i in batch],glossary,
                "图中文字/图表标签：保持数字、单位、变量与公式，不补全无法辨认内容。图注上下文："+context)
            for i, dst in zip(batch,translated):
                if dst is None:
                    out[i]["status"]="failed"; out[i]["error"]=getattr(provider,"last_error","翻译失败")
                else: out[i]["dst"]=dst; out[i]["status"]="translated"
        failed = sum(line["status"]=="failed" for line in out)
        review = sum(line["status"]=="review" for line in out)
        _store_ocr(block_id,{"status":"partial" if failed or caption_result["failed"] else "done","lines":out,"translator":provider_name,
            "captions":caption_result,
            "engine":f"pdf-text/{ocr_adapter}","failed":failed,"review":review,"completed":len(indices),"total":len(indices),
            "cache_key":signature,"warning":f"{review} 项识别不确定，{failed} 项翻译失败；原文已保留" if review or failed else ""})
    except Exception as exc:
        _store_ocr(block_id,{"status":"failed","lines":out,"captions":caption_result,"error":str(exc)[:300]})


def _translate_figure_captions(document_id, block_id):
    """An image action includes its nearby caption, even when outside the crop."""
    import pymupdf
    with Session(engine) as session:
        doc, image = session.get(Document,document_id), session.get(Block,block_id)
        if doc is None or image is None or image.document_id != document_id or image.block_type != "image":
            return {"total":0,"translated":0,"failed":0,"block_ids":[]}
        recover_captions(session,doc,[image.page_number],raster=True)
        session.commit()
        blocks = session.exec(select(Block).where(Block.document_id==document_id,Block.page_number==image.page_number)).all()
        with pymupdf.open(doc.file_path) as pdf: rotation=pdf[image.page_number-1].rotation_matrix
        def box(b):
            rect=pymupdf.Rect(b.bbox)
            # Association is based on the paper's reading direction, before
            # display rotation (a caption below a figure may appear beside it).
            return rect*~rotation if (b.extra_meta or {}).get("coordinate_space")=="visual" else rect
        def distance(caption, figure):
            c,f=box(caption),box(figure)
            overlap=max(0,min(c.x1,f.x1)-max(c.x0,f.x0))
            if overlap < min(c.width,f.width)*.3: return float("inf")
            return max(0,c.y0-f.y1,f.y0-c.y1)
        images=[b for b in blocks if b.block_type=="image"]
        ids=[]; associated=[]
        settings=load_settings();name=settings["provider"]
        model=settings["openai"]["model"] if name=="openai" else "mock-1"
        glossary=[(t.source,t.target) for t in session.exec(select(Term).where(Term.forced==True)).all()]
        for caption in blocks:
            if caption.block_type!="caption" or re.match(r"^\s*(?:Tab(?:le)?\.?|[表])",caption.text,re.I): continue
            nearest=min(images,key=lambda b:distance(caption,b))
            if nearest.id!=block_id or distance(caption,nearest)>max(120,box(nearest).height*.25): continue
            associated.append(caption.id)
            seg=session.exec(select(TranslationSegment).where(TranslationSegment.block_id==caption.id)).first()
            if seg and seg.status=="done" and seg.cache_key==_segment_key(settings,name,model,caption.text,glossary): continue
            ids.append(caption.id)
    for bid in ids: run_retranslate_block(bid,name)
    with Session(engine) as session:
        segments=session.exec(select(TranslationSegment).where(TranslationSegment.block_id.in_(associated))).all() if associated else []
        return {"total":len(associated),"translated":sum(s.status=="done" for s in segments),
                "failed":len(associated)-sum(s.status=="done" for s in segments),"block_ids":associated,
                "error":next((s.error for s in segments if s.status!="done" and s.error),None)}


@document_task("translating")
def run_caption_recovery(document_id: int):
    """Repair old native captions without provider requests or rebuilding anchors."""
    with Session(engine) as session:
        doc=session.get(Document,document_id)
        if doc is None: return None
        recovered=recover_captions(session,doc)
        session.commit()
        return {"recovered":len(recovered)}


@document_task("translating")
def run_figures_ocr(document_id: int) -> None:
    """批量：对文档内全部图形区域执行 OCR 贴回翻译。"""
    with Session(engine) as session:
        ids = session.exec(
            select(Block.id).where(
                Block.document_id == document_id, Block.block_type == "image"
            )
        ).all()
    for bid in ids:
        run_figure_ocr(document_id, bid, force=False)
        time.sleep(0.3)
