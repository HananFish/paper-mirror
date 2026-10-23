"""Offline onboarding and release checks, with no user library access."""
import asyncio
from pathlib import Path
import re
import unittest
from unittest.mock import patch

import test_regressions as fixtures
from app.main import index_no_cache
from app.routers import documents
from app.models import Annotation, Document
from fastapi import BackgroundTasks, HTTPException
from sqlmodel import Session, select
import setup as installer

ROOT=Path(__file__).resolve().parents[1]


class ReleaseTests(unittest.TestCase):
    setUp=fixtures.RegressionTests.setUp
    doc=fixtures.RegressionTests.doc

    def test_packaged_manual_import_deduplicates_and_parses(self):
        with Session(fixtures.engine) as session:
            background=BackgroundTasks()
            doc=asyncio.run(documents.import_user_guide(background,session))
            did=doc.id
            self.assertEqual(doc.filename,"UserGuide.pdf")
            self.assertEqual(len(background.tasks),1)
        with patch("app.parsing.detect_layout",return_value=None):fixtures.run_parse(did)
        with Session(fixtures.engine) as session:
            self.assertEqual(session.get(Document,did).page_count,4)
            second=BackgroundTasks()
            self.assertEqual(asyncio.run(documents.import_user_guide(second,session)).id,did)
            self.assertEqual(second.tasks,[])
            self.assertEqual(len(session.exec(select(Document)).all()),1)
        download=documents.download_user_guide()
        self.assertEqual(download.media_type,"application/pdf")
        self.assertIn("UserGuide.pdf",download.headers["content-disposition"])

    def test_missing_manual_has_actionable_error(self):
        with Session(fixtures.engine) as session,patch("app.config.REPO_ROOT",Path(fixtures.TEMP.name)):
            with self.assertRaises(HTTPException) as ctx:asyncio.run(documents.import_user_guide(BackgroundTasks(),session))
            self.assertEqual(ctx.exception.status_code,503)
            self.assertIn("make_user_guide.py",ctx.exception.detail)

    def test_manual_regeneration_preserves_upload_deduplication(self):
        from make_user_guide import make
        first=Path(fixtures.TEMP.name)/"guide-first.pdf"
        second=Path(fixtures.TEMP.name)/"guide-second.pdf"
        make(first);make(second)
        self.assertEqual(first.read_bytes(),second.read_bytes())

    def test_missing_frontend_has_setup_message(self):
        with patch("app.main.FRONTEND_DIST",Path(fixtures.TEMP.name)/"missing"):
            response=index_no_cache()
        self.assertEqual(response.status_code,503)
        self.assertIn("setup.py",response.body.decode())

    def test_installer_checks_node_before_mutating(self):
        with patch("setup.shutil.which",return_value=None),patch("setup.run") as run:
            with self.assertRaisesRegex(RuntimeError,"Node.js"):installer.prerequisites()
            run.assert_not_called()
        with patch("setup.shutil.which",side_effect=["node","npm"]),patch("setup.subprocess.check_output",return_value="v18.20.0"):
            with self.assertRaisesRegex(RuntimeError,"22"):installer.prerequisites()

    def test_mirror_bundle_import_dedupes_and_rejects_bad_pages(self):
        did,bid=self.doc()
        payload={
            "annotations":[{"page_number":1,"block_id":bid,"kind":"highlight","target":"source",
                            "bbox":[72,80,300,100],"rects":[[72,80,300,100]],
                            "selected_text":"An example","color":"#fef08a"}],
            "notes":[{"title":"想法","content":"保留原文","page_number":1,"block_id":bid,"quote":"An example"}],
        }
        with Session(fixtures.engine) as session:
            first=documents.import_mirror_bundle(did,payload,session)
            self.assertEqual((first["added_annotations"],first["added_notes"]),(1,1))
            second=documents.import_mirror_bundle(did,payload,session)
            self.assertEqual((second["added_annotations"],second["added_notes"]),(0,0))
            self.assertEqual((second["skipped_annotations"],second["skipped_notes"]),(1,1))
            for bad in ({"annotations":[{"page_number":99}]},
                        {"annotations":[{"page_number":1,"kind":"scribble"}]},
                        {"annotations":[{"page_number":1,"bbox":[1,2,3]}]},
                        {"annotations":"not-a-list"},
                        {"notes":[{"page_number":0}]}):
                with self.assertRaises(HTTPException) as ctx:
                    documents.import_mirror_bundle(did,bad,session)
                self.assertEqual(ctx.exception.status_code,400)
            self.assertEqual(len(session.exec(select(Annotation)).all()),1)
            # 一条合法 + 一条非法：整包拒绝，不留下半份备份
            with self.assertRaises(HTTPException):
                documents.import_mirror_bundle(did,{"annotations":[
                    {"page_number":2,"kind":"highlight","bbox":[72,80,300,100]},
                    {"page_number":99},
                ]},session)
            self.assertEqual(len(session.exec(select(Annotation)).all()),1)

    def test_publish_site_strips_local_paths(self):
        from publish_site import public_document
        entry={"id":1,"filename":"paper.pdf","file_path":"C:/Users/name/data/paper.pdf",
               "error":"open C:/Users/name/data/paper.pdf failed","status":"ready"}
        public=public_document(entry)
        self.assertNotIn("file_path",public)
        self.assertNotIn("C:/Users/name",str(public))
        self.assertIsNone(public["error"])
        self.assertEqual(entry["file_path"],"C:/Users/name/data/paper.pdf")

    def test_public_document_links_resolve(self):
        paths=[ROOT/"README.md",ROOT/"AGENTS.md",ROOT/"CONTRIBUTING.md",ROOT/"SECURITY.md",*sorted((ROOT/"docs").glob("*.md"))]
        for path in paths:
            text=path.read_text(encoding="utf-8-sig")
            for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)",text):
                if "://" in target or target.startswith("#"):continue
                local=target.split("#",1)[0]
                self.assertTrue((path.parent/local).exists(),f"Broken link: {path.name}: {target}")

    def test_parallel_documents_do_not_share_predictor_state(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Lock
        from types import SimpleNamespace
        import time
        from app.layout_yolo import detect_layout
        guard=Lock();state={"active":0,"maximum":0}
        class Predictor:
            names={}
            def predict(self,*args,**kwargs):
                with guard:
                    state["active"]+=1;state["maximum"]=max(state["maximum"],state["active"])
                time.sleep(.015)
                with guard:state["active"]-=1
                return []
        page=SimpleNamespace(get_pixmap=lambda **kw:SimpleNamespace(samples=b"\xff\xff\xff",height=1,width=1,n=3))
        with patch("app.layout_yolo._model",Predictor()),ThreadPoolExecutor(max_workers=6) as pool:
            self.assertEqual(list(pool.map(detect_layout,[page]*12)),[[]]*12)
        self.assertEqual(state["maximum"],1)

    def test_guide_update_backs_up_and_preserves_exact_translation(self):
        from sync_user_guide import sync
        from app.models import TranslationSegment
        did,bid=self.doc(name="UserGuide",source="Translator Reader User Guide")
        with Session(fixtures.engine) as session:
            session.add(TranslationSegment(document_id=did,block_id=bid,status="done",text="已保存的标题翻译",provider="mock"));session.commit()
        old_pdf=self.pdf.read_bytes()
        with patch("app.parsing.detect_layout",return_value=None):sync(did)
        self.assertEqual(self.pdf.read_bytes(),old_pdf)
        self.assertTrue(list(Path(fixtures.TEMP.name).glob("backups/guide-update-*/app.db")))
        with Session(fixtures.engine) as session:
            doc=session.get(Document,did)
            self.assertEqual(doc.page_count,4);self.assertEqual(doc.status,"ready")
            self.assertEqual(session.exec(select(TranslationSegment).where(TranslationSegment.document_id==did)).one().text,"已保存的标题翻译")

    def test_guide_update_refuses_to_move_saved_note_geometry(self):
        from sync_user_guide import sync
        from app.models import Note
        did,bid=self.doc(name="UserGuide")
        with Session(fixtures.engine) as session:
            session.add(Note(document_id=did,block_id=bid,content="保留原文定位"));session.commit()
        with self.assertRaisesRegex(ValueError,"reading records"):sync(did)
        with Session(fixtures.engine) as session:
            self.assertEqual(session.get(Document,did).file_path,str(self.pdf))
            self.assertIsNotNone(session.get(fixtures.Block,bid))


if __name__=="__main__":
    try:unittest.main(verbosity=2)
    finally:
        fixtures.engine.dispose();fixtures.TEMP.cleanup()
