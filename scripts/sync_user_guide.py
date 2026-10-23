"""Update an unannotated UserGuide library entry, with an online SQLite backup.

Never translates or deletes the old source PDF. Entries with notes/annotations
are refused: import the new guide separately so their original geometry stays valid.
"""
import argparse
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import shutil
import sqlite3
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend"))
from sqlalchemy import delete
from sqlmodel import Session,select
from app.config import DATA_DIR, DB_PATH, DOCS_DIR
from app.db import engine
from app.jobs import reserve_task
from app.models import Annotation,Block,Document,Note,Page,TranslationSegment,utcnow
from app.parsing import parse_pdf_file


def sync(document_id):
    guide=ROOT/"docs/UserGuide.pdf"
    with Session(engine) as session:
        doc=session.get(Document,document_id)
        if doc is None or doc.filename.casefold()!="userguide.pdf":raise ValueError("Expected an existing UserGuide.pdf entry")
        if doc.status!="ready":raise ValueError("Wait for the document's active task to finish")
        for model in (Annotation,Note):
            if session.exec(select(model).where(model.document_id==document_id)).first():
                raise ValueError("This guide has reading records. Import the new guide separately to preserve them.")
    pages,blocks=parse_pdf_file(str(guide))
    sha=hashlib.sha256(guide.read_bytes()).hexdigest()
    backup=DATA_DIR/"backups"/("guide-update-"+datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f"))
    backup.mkdir(parents=True)
    # SQLite backup includes the live WAL; copying app.db alone would not.
    with sqlite3.connect(f"file:{DB_PATH}?mode=ro",uri=True) as source,sqlite3.connect(backup/"app.db") as target:
        source.backup(target)
    path=DOCS_DIR/f"{sha}.pdf"
    if not path.exists():shutil.copyfile(guide,path)
    with Session(engine) as session:
        doc=session.get(Document,document_id)
        reserve_task(session,doc,"parsing",ready_only=True)
        try:
            for model in (Annotation,Note):
                if session.exec(select(model).where(model.document_id==document_id)).first():raise ValueError("Reading records changed; update cancelled")
            old_blocks={b.id:b.text for b in session.exec(select(Block).where(Block.document_id==document_id)).all()}
            translations={old_blocks[s.block_id]:s.model_dump(exclude={"id","block_id"}) for s in session.exec(select(TranslationSegment).where(TranslationSegment.document_id==document_id,TranslationSegment.status=="done")).all() if s.block_id in old_blocks}
            for model in (TranslationSegment,Block,Page):session.execute(delete(model).where(model.document_id==document_id))
            for item in pages:session.add(Page(document_id=document_id,**item))
            reused=0
            for item in blocks:
                block=Block(document_id=document_id,**item);session.add(block);session.flush()
                if block.text in translations:
                    session.add(TranslationSegment(block_id=block.id,**translations[block.text]));reused+=1
            doc.file_path=str(path);doc.sha256=sha;doc.page_count=len(pages)
            doc.last_page=min(doc.last_page,len(pages));doc.status="ready";doc.error=None;doc.updated_at=utcnow();session.add(doc)
            session.commit()
        except Exception:
            session.rollback();doc=session.get(Document,document_id);doc.status="ready";doc.updated_at=utcnow();session.add(doc);session.commit();raise
    print(f"Updated guide {document_id}: {len(pages)} pages, {len(blocks)} blocks, {reused} exact translations reused.")
    print(f"Backup: {backup}. Old PDF retained. No translation requests made.")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("document_id",type=int)
    try:sync(parser.parse_args().document_id)
    finally:engine.dispose()
