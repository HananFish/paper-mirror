"""Offline regression suite. Every database and PDF belongs to a temporary directory."""
import asyncio
import logging
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))
(ROOT / "data").mkdir(exist_ok=True)
TEMP = tempfile.TemporaryDirectory(prefix="regression-", dir=ROOT / "data")
os.environ["APP_DATA_DIR"] = TEMP.name
logging.disable(logging.CRITICAL)

import pymupdf
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError
from sqlmodel import Session, SQLModel, select
from starlette.requests import Request
from starlette.responses import Response
from app.db import engine, init_db
from app.config import SETTINGS_PATH, DOCS_DIR
from app.models import Annotation, Block, Document, Note, Term, TranslationMemory, TranslationSegment
from app.routers import documents, misc, regions
from app.jobs import reserve_task
from app.parsing import parse_pdf_file
from app.security import access_guard
from app.settings_store import load_settings, save_settings
from app.tasks import run_parse, run_translation, run_retranslate_block, run_figures_ocr, run_figure_ocr, _cluster_ocr_lines, _translate_image_label, _translate_with_fallback, tm_key, _segment_key, _tm_store
from app.translators import _split_numbered, BatchParseError, OpenAICompatibleProvider, SYSTEM_PROMPT


class FakeProvider:
    name = "openai"
    model = "gpt-4o-mini"
    def __init__(self):
        self.calls = 0
    def translate(self, texts, glossary, context):
        self.calls += 1
        return ["真实译文" + str(glossary) for _ in texts]


class RegressionTests(unittest.TestCase):
    def setUp(self):
        SQLModel.metadata.drop_all(engine)
        init_db()
        SETTINGS_PATH.unlink(missing_ok=True)
        self.pdf = DOCS_DIR / "fixture.pdf"
        with pymupdf.open() as pdf:
            for i in range(4):
                page = pdf.new_page()
                page.insert_text((72, 100), f"An example transformer paragraph. Page {i+1}.")
                page.insert_text((72, 150), "Second line for highlight testing.")
            pdf.save(self.pdf)

    def doc(self, name="fixture", source="An example transformer paragraph."):
        with Session(engine) as s:
            d = Document(filename=name + ".pdf", sha256=name, file_path=str(self.pdf), status="ready", page_count=4)
            s.add(d)
            s.commit()
            s.refresh(d)
            b = Block(document_id=d.id, page_number=1, text=source, bbox=[72, 80, 330, 110])
            s.add(b)
            s.commit()
            s.refresh(b)
            return d.id, b.id

    def segment(self, block_id):
        with Session(engine) as s:
            return s.exec(select(TranslationSegment).where(TranslationSegment.block_id == block_id)).one()

    def test_progress_uses_current_blocks_and_one_snapshot(self):
        did,bid=self.doc()
        with Session(engine) as s:
            s.add(TranslationSegment(document_id=did,block_id=bid,status="done"))
            for kind,status in (("heading","done"),("caption","failed"),("list","running"),
                                ("paragraph","pending"),("reference","done"),("image","done"),("table","done")):
                block=Block(document_id=did,page_number=1,block_type=kind,text=kind)
                s.add(block);s.flush()
                s.add(TranslationSegment(document_id=did,block_id=block.id,status=status))
            s.commit()
            expected={"total_blocks":5,"translated":2,"failed":1,"running":1}
            with patch.object(s,"exec",wraps=s.exec) as execute:
                self.assertEqual(documents._doc_progress(s,did),expected)
                self.assertEqual(execute.call_count,1)
            self.assertEqual(documents.get_document(did,s)["progress"],expected)
            self.assertEqual(documents.list_documents(s)[0]["progress"],expected)
            # Reference reclassification excludes its old successful translation;
            # a newly recovered caption participates even before a segment exists.
            s.get(Block,bid).block_type="reference"
            s.add(Block(document_id=did,page_number=1,block_type="caption",text="Fig. 2: recovered"))
            s.commit()
            expected["translated"]=1
            self.assertEqual(documents._doc_progress(s,did),expected)
            self.assertEqual(documents.list_documents(s)[0]["progress"],expected)

    def test_progress_ignores_mismatched_document_and_empty_documents(self):
        did,bid=self.doc("one")
        other,_=self.doc("two")
        with Session(engine) as s:
            s.add(TranslationSegment(document_id=other,block_id=bid,status="done"))
            empty=Document(filename="empty.pdf",sha256="empty",file_path=str(self.pdf),status="ready")
            s.add(empty);s.commit();s.refresh(empty)
            self.assertEqual(documents._doc_progress(s,did),{"total_blocks":1,"translated":0,"failed":0,"running":0})
            listed={d["id"]:d["progress"] for d in documents.list_documents(s)}
            self.assertEqual(listed[other]["translated"],0)
            self.assertEqual(listed[empty.id],documents._doc_progress(s,empty.id))
            self.assertEqual(listed[empty.id]["total_blocks"],0)

    def test_figure_native_text_avoids_ocr_and_preserves_rotated_coordinates(self):
        from app.ocr import extract_lines_with_boxes
        for rotation in (0, 90, 180, 270):
            path = DOCS_DIR / f"figure-native-{rotation}.pdf"
            with pymupdf.open() as pdf:
                page = pdf.new_page()
                page.insert_text((100, 100), "Input labels")
                page.set_rotation(rotation)
                box = list(pymupdf.Rect(90, 70, 220, 110) * page.rotation_matrix)
                pdf.save(path)
            with patch("app.ocr.recognize_png", side_effect=AssertionError("native text must not run OCR")):
                lines = extract_lines_with_boxes(str(path), 1, box)
            self.assertEqual(lines[0]["src"], "Input labels")
            self.assertEqual(lines[0]["confidence"], 1)
            self.assertTrue(pymupdf.Rect(box).contains(pymupdf.Rect(lines[0]["pbox"])))

    def test_raster_ocr_uses_pixel_origin_and_preserves_confidence(self):
        from app.ocr import extract_lines_with_boxes
        path = DOCS_DIR / "figure-raster.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page()
            page.set_rotation(90)
            box = list(pymupdf.Rect(72.2, 200.3, 200.7, 300.8) * page.rotation_matrix)
            pdf.save(path)
        line = {"quad": [[10, 20], [70, 20], [70, 40], [10, 40]], "src": "Output", "confidence": 0.61}
        with patch("app.ocr.recognize_png", return_value=[line]) as ocr:
            lines = extract_lines_with_boxes(str(path), 1, box, dpi=240)
        self.assertTrue(ocr.call_args.args[0].startswith(b"\x89PNG"))
        scale = 240 / 72
        expected = pymupdf.Rect((int(72.2*scale)+10)/scale, (int(200.3*scale)+20)/scale,
                                (int(72.2*scale)+70)/scale, (int(200.3*scale)+40)/scale)
        with pymupdf.open(path) as pdf:
            expected *= pdf[0].rotation_matrix
        for actual, wanted in zip(lines[0]["pbox"], expected):
            self.assertAlmostEqual(actual, wanted, places=2)
        self.assertEqual(lines[0]["confidence"], 0.61)

    def test_broken_native_font_map_falls_back_to_ocr_without_suppressing_labels(self):
        from app.ocr import extract_lines_with_boxes, _usable_native_text
        self.assertFalse(_usable_native_text('\u0011\u000f\u0012\r\u0013\u0004'))
        self.assertFalse(_usable_native_text('\ufffd' * 8))
        self.assertTrue(_usable_native_text('Input layer'))
        self.assertTrue(_usable_native_text('x = 2'))
        path = DOCS_DIR / 'broken-font-map.pdf'
        with pymupdf.open() as pdf:
            pdf.new_page().insert_text((100, 100), 'visible label')
            pdf.save(path)
        native = {'blocks': [{'lines': [
            {'bbox': [95, 85, 180, 105], 'spans': [{'text': '\u0011\u000f\u0012\u0013'}]},
            {'bbox': [190, 85, 250, 105], 'spans': [{'text': 'Output'}]},
        ]}]}
        recognized = [{'quad': [[18, 45], [280, 45], [280, 95], [18, 95]],
                       'src': 'Input layer', 'confidence': .99}]
        with patch.object(pymupdf.Page, 'get_text', return_value=native), patch('app.ocr.recognize_png', return_value=recognized) as ocr:
            lines = extract_lines_with_boxes(str(path), 1, [90, 70, 260, 110])
        ocr.assert_called_once()
        self.assertEqual({line['src'] for line in lines}, {'Input layer', 'Output'})
        self.assertTrue(all(_usable_native_text(line['src']) for line in lines))

    def test_chart_labels_are_separate_and_formulas_preserved(self):
        labels = [{"src": word, "pbox": [10, 10+i*12, 100, 20+i*12], "confidence": 0.99}
                  for i, word in enumerate(["Input", "Output", "Loss"])]
        self.assertEqual(len(_cluster_ocr_lines(labels)), 3)
        for label in ("x = 2", "0.25", "GPU", "100 ms", r"\frac{x}{y}"):
            self.assertFalse(_translate_image_label(label, "zh"), label)
        self.assertTrue(_translate_image_label("INPUT", "zh"))
        self.assertTrue(_translate_image_label("输入层", "English"))
        self.assertFalse(_translate_image_label("输入层", "zh"))

    def test_figure_batch_keeps_partial_success_and_cache_uses_glossary(self):
        did, _ = self.doc(source="Figure 1: architecture caption")
        with Session(engine) as s:
            block = Block(document_id=did, page_number=1, block_type="image", bbox=[72, 180, 300, 300])
            s.add(block); s.commit(); s.refresh(block); bid = block.id
            s.add(Term(source="Input", target="输入")); s.commit()
        labels = [{"src": word, "pbox": [10, 10+i*20, 90, 20+i*20], "confidence": score}
                  for i, (word,score) in enumerate([("Input",.99),("Output",.99),("Uncertain",.4),("x = 2",.99)])]
        provider = FakeProvider()
        with patch("app.ocr.extract_lines_with_boxes", return_value=labels), patch("app.tasks.get_provider", return_value=provider), patch("app.tasks._translate_with_fallback", return_value=["输入",None]) as translate:
            run_figure_ocr(did,bid)
        self.assertEqual(translate.call_args.args[1], ["Input","Output"])
        self.assertIn(("Input","输入"),translate.call_args.args[2])
        self.assertIn("architecture caption",translate.call_args.args[3])
        with Session(engine) as s: result = s.get(Block,bid).extra_meta["ocr"]
        self.assertEqual(result["status"],"partial")
        self.assertEqual([line["status"] for line in result["lines"]], ["translated","failed","review","preserved"])
        self.assertEqual(result["lines"][0]["dst"],"输入")
        self.assertEqual(result["lines"][1]["dst"],"Output")
        with patch("app.ocr.extract_lines_with_boxes",return_value=labels) as extract, patch("app.tasks.get_provider",return_value=provider), patch("app.tasks._translate_with_fallback", return_value=["输入","输出"]):
            run_figure_ocr(did,bid,force=False)  # Retry the partial result.
            run_figure_ocr(did,bid,force=False)  # Reuse the successful result.
            self.assertEqual(extract.call_count,1)
            with Session(engine) as s:
                term=s.exec(select(Term)).one();term.target="入口";s.add(term);s.commit()
            run_figure_ocr(did,bid,force=False)
            self.assertEqual(extract.call_count,2)

    def test_region_ocr_overrides_native_text_and_manual_text_skips_ocr(self):
        did,_ = self.doc()
        with Session(engine) as s, patch("app.routers.regions.recognize_png",return_value=[{"src":"Raster label","confidence":.6,"quad":[]}]) as ocr:
            result=regions.region_action(did,regions.Region(page_number=1,bbox=[70,80,400,110],mode="ocr"),s)
            self.assertEqual(result["source"],"Raster label")
            self.assertEqual(result["ocr"]["engine"],"rapidocr")
            self.assertTrue(result["warning"])
            ocr.reset_mock()
            regions.region_action(did,regions.Region(page_number=1,bbox=[70,200,400,300],mode="text",text="Corrected label"),s)
            ocr.assert_not_called()

    def test_legacy_figure_crop_is_adapted_to_visual_coordinates(self):
        rotated=DOCS_DIR / "legacy-figure.pdf"
        with pymupdf.open(self.pdf) as pdf:
            pdf[0].set_rotation(90);expected=list(pymupdf.Rect(72,180,300,300)*pdf[0].rotation_matrix);pdf.save(rotated)
        did,_=self.doc()
        with Session(engine) as s:
            doc=s.get(Document,did);doc.file_path=str(rotated);s.add(doc)
            block=Block(document_id=did,page_number=1,block_type="image",bbox=[72,180,300,300]);s.add(block);s.commit();s.refresh(block);bid=block.id
        with patch("app.ocr.extract_lines_with_boxes",return_value=[]) as extract:
            run_figure_ocr(did,bid)
        self.assertEqual(extract.call_args.args[2],expected)

    def test_vision_rejects_truncation_without_local_ocr(self):
        from unittest.mock import Mock
        did,_=self.doc()
        from app.vision import OpenAICompatibleVision
        provider=OpenAICompatibleVision('http://localhost','fake','fake')
        response=Mock();response.json.return_value={"choices":[{"finish_reason":"length","message":{"content":"truncated"}}]}
        with Session(engine) as s, patch("app.routers.regions.recognize_png") as ocr, patch("app.model_adapters.create_adapter",return_value=provider), patch("app.vision.http_post",return_value=response):
            with self.assertRaises(HTTPException) as error:
                regions.region_action(did,regions.Region(page_number=1,bbox=[70,200,400,300],mode="vision"),s)
            self.assertEqual(error.exception.status_code,502)
            ocr.assert_not_called()

    def test_simple_translation_receives_figure_caption_context(self):
        provider=OpenAICompatibleProvider("http://localhost","fake","test","simple")
        with patch.object(provider,"_chat",return_value="输入") as chat:
            provider.translate(["Input"],[],"Figure: encoder architecture")
        self.assertIn("encoder architecture",chat.call_args.args[0])

    def test_selections_in_same_block_keep_independent_colors_and_notes(self):
        did, bid = self.doc()
        with Session(engine) as s:
            body = {"page_number": 1, "block_id": bid, "kind": "highlight", "target": "source",
                    "bbox": [72, 80, 150, 100], "rects": [[72, 80, 150, 100]], "selected_text": "first"}
            first = documents.create_annotation(did, body, s)
            second = documents.create_annotation(did, {**body, "bbox": [160, 80, 240, 100],
                "rects": [[160, 80, 240, 100]], "selected_text": "second"}, s)
            self.assertNotEqual(first.id, second.id)
            documents.update_annotation(did, second.id, {"color": "#bbf7d0", "content": "独立附注", "kind": "comment"}, s)
            s.refresh(first)
            self.assertEqual(first.color, "#fef08a")
            self.assertEqual(first.selected_text, "first")
            self.assertEqual(first.content, "")
            exported = documents.export_annotated_pdf(did, s)
            with pymupdf.open(stream=exported.body, filetype="pdf") as pdf:
                annotations = list(pdf[0].annots())
                self.assertEqual(len(annotations), 2)
                self.assertNotEqual(annotations[0].colors["stroke"], annotations[1].colors["stroke"])
                self.assertEqual(annotations[1].info["content"], "独立附注")

    def test_task_initialization_failure_recovers(self):
        did, bid = self.doc()
        with patch("app.tasks.get_provider", side_effect=ValueError("missing key")):
            run_translation(did, "openai")
        with Session(engine) as s:
            d = s.get(Document, did)
            self.assertEqual(d.status, "ready")
            self.assertIn("missing key", d.error)
            reserve_task(s, d, "translating", ready_only=True)

    def test_pdf_export_includes_linked_and_global_reading_notes(self):
        did, bid = self.doc()
        with Session(engine) as s:
            linked = documents.create_note(did, {"block_id": bid, "page_number": 1, "title": "段落理解",
                "quote": "An example transformer paragraph.", "content": "这是一条有位置的中文阅读笔记。"}, s)
            documents.create_note(did, {"title": "全文总结", "content": "整篇文献的独立笔记。"}, s)
            # Multiple appended pages must retain all content, not shrink or truncate it.
            documents.create_note(did, {"page_number": 2, "title": "长笔记", "content": "分页中文段落。\n" * 130 + "长笔记最终结束。"}, s)
            exported = documents.export_annotated_pdf(did, s)
            with pymupdf.open(stream=exported.body, filetype="pdf") as pdf:
                self.assertGreater(len(pdf), 6)
                appendix = "".join(page.get_text() for page in list(pdf)[4:])
                for content in ("段落理解", "有位置的中文阅读笔记", "整篇文献的独立笔记", "长笔记最终结束"):
                    self.assertIn(content, appendix)
                original_notes = list(pdf[0].annots())
                self.assertTrue(any(f"N{linked.id}" in a.info["content"] for a in original_notes))
                self.assertIn(f"N{linked.id}", pdf[0].get_text())
                self.assertTrue(any(link["page"] >= 4 for link in pdf[0].get_links()))
                self.assertTrue(any(link["page"] == 0 for link in pdf[4].get_links()))
                self.assertEqual(pdf.get_toc()[-1][1], "阅读笔记与批注")

    def test_rotated_note_badges_stay_on_original_pages(self):
        for angle in (0, 90, 180, 270):
            with pymupdf.open(self.pdf) as pdf:
                pdf[0].set_rotation(angle)
                rotated = DOCS_DIR / f"note-{angle}.pdf"
                pdf.save(rotated)
            did, bid = self.doc(f"note-{angle}")
            with Session(engine) as s:
                d = s.get(Document, did); d.file_path = str(rotated); s.add(d); s.commit()
                documents.create_note(did, {"page_number": 1, "block_id": bid, "content": "旋转页面笔记"}, s)
                out = documents.export_annotated_pdf(did, s)
                with pymupdf.open(stream=out.body, filetype="pdf") as pdf:
                    self.assertGreater(len(pdf), 4)
                    self.assertIn("旋转页面笔记", pdf[4].get_text())
                    self.assertTrue(pdf[0].get_links())
                    for link in pdf[0].get_links():
                        self.assertTrue(pdf[0].rect.contains(link["from"]))

    def test_invalid_provider_is_rejected_before_reserving(self):
        did, _ = self.doc()
        with Session(engine) as s:
            with self.assertRaises(HTTPException) as raised:
                documents.translate_document(did, BackgroundTasks(), {"provider": "unknown"}, s)
            self.assertEqual(raised.exception.status_code, 400)
            self.assertEqual(s.get(Document, did).status, "ready")

    def test_mock_never_pollutes_real_memory(self):
        d1, b1 = self.doc("one")
        run_translation(d1, "mock")
        with Session(engine) as s:
            self.assertEqual(s.exec(select(TranslationMemory)).all(), [])
            # Simulate a pre-fix database containing mock memory.
            s.add(TranslationMemory(src_hash=tm_key("zh", "An example transformer paragraph."),
                                    source_text="An example transformer paragraph.", translated_text="【Mock译】bad", provider="mock"))
            s.commit()
        d2, b2 = self.doc("two")
        provider = FakeProvider()
        with patch("app.tasks.get_provider", return_value=provider):
            run_translation(d2, "openai")
        self.assertEqual(provider.calls, 1)
        self.assertTrue(self.segment(b2).text.startswith("真实译文"))

    def test_glossary_change_invalidates_segment_and_memory(self):
        d1, b1 = self.doc("one")
        provider = FakeProvider()
        with patch("app.tasks.get_provider", return_value=provider):
            run_translation(d1, "openai")
            run_translation(d1, "openai")
            self.assertEqual(provider.calls, 1)
            with Session(engine) as s:
                misc.add_term({"source": "transformer", "target": "变换器"}, s)
            run_translation(d1, "openai")
            self.assertEqual(provider.calls, 2)
            self.assertIn("变换器", self.segment(b1).text)
            d2, b2 = self.doc("two")
            run_translation(d2, "openai")
            self.assertEqual(provider.calls, 2)
            self.assertTrue(self.segment(b2).provider.startswith("tm:"))

    def test_provider_identity_invalidates_local_cache(self):
        did, _ = self.doc()
        provider = FakeProvider()
        with patch("app.tasks.get_provider", return_value=provider):
            run_translation(did, "openai", True)
            save_settings({"openai": {"base_url": "http://localhost:1234/v1"}})
            run_translation(did, "openai", True)
            self.assertEqual(provider.calls, 2)
        original = _segment_key({"openai": {"base_url": "http://one"}}, "openai", "model", "text", [])
        changed = _segment_key({"openai": {"base_url": "http://two"}}, "openai", "model", "text", [])
        self.assertNotEqual(original, changed)

    def test_single_segment_failure_is_visible_and_recoverable(self):
        did, bid = self.doc()
        with patch("app.tasks.get_provider", side_effect=ValueError("missing key")):
            run_retranslate_block(bid)
        with Session(engine) as s:
            self.assertEqual(s.get(Document, did).status, "ready")
            self.assertIn("missing key", s.get(Document, did).error)

    def test_running_job_blocks_parse_translate_and_delete(self):
        did, _ = self.doc()
        entered, release = threading.Event(), threading.Event()
        provider = FakeProvider()
        def delayed(texts, glossary, context):
            entered.set()
            release.wait(5)
            return ["译文" for _ in texts]
        provider.translate = delayed
        with patch("app.tasks.get_provider", return_value=provider):
            worker = threading.Thread(target=run_translation, args=(did, "openai"))
            worker.start()
            self.assertTrue(entered.wait(3))
            try:
                for action in (lambda s: documents.reparse_document(did, BackgroundTasks(), s),
                               lambda s: documents.delete_document(did, s)):
                    with Session(engine) as s, self.assertRaises(HTTPException) as raised:
                        action(s)
                    self.assertEqual(raised.exception.status_code, 409)
            finally:
                release.set()
                worker.join(5)
            self.assertFalse(worker.is_alive())
        self.assertEqual(self.segment(1).status, "done")

    def test_queued_parse_is_reserved_and_duplicate_rejected(self):
        did, _ = self.doc()
        background = BackgroundTasks()
        with Session(engine) as s:
            documents.reparse_document(did, background, s)
            self.assertEqual(s.get(Document, did).status, "parsing")
            with self.assertRaises(HTTPException):
                documents.reparse_document(did, BackgroundTasks(), s)
        self.assertEqual(len(background.tasks), 1)

    def test_cross_document_note_update_rejected(self):
        d1, b1 = self.doc("one")
        d2, b2 = self.doc("two")
        with Session(engine) as s:
            note = documents.create_note(d1, {"block_id": b1, "page_number": 1}, s)
            with self.assertRaises(HTTPException) as raised:
                documents.update_note(d1, note.id, {"block_id": b2}, s)
            self.assertEqual(raised.exception.status_code, 400)
            self.assertEqual(note.block_id, b1)
            documents.delete_document(d2, s, purge_file=False)

    def test_invalid_annotations_and_page_are_rejected(self):
        did, bid = self.doc()
        with Session(engine) as s:
            for body in ({"page_number": 8}, {"page_number": 1, "color": "red"},
                         {"page_number": 1, "bbox": [0, 0, float("nan"), 1]},
                         {"page_number": 1, "rects": None}, {"page_number": 2, "block_id": bid}):
                with self.assertRaises(HTTPException):
                    documents.create_annotation(did, body, s)
            with self.assertRaises(HTTPException):
                documents.set_last_page(did, {"last_page": "abc"}, s)

    def test_settings_validation_does_not_corrupt_file(self):
        saved = save_settings({"batch_size": 4})
        for body in ({"openai": None}, {"batch_size": "8"}, {"batch_size": 0},
                     {"provider": "bad"}, {"openai": {"base_url": "file:///tmp"}}, {"auto_translate": 1}):
            with self.assertRaises(ValidationError):
                save_settings(body)
            self.assertEqual(load_settings(), saved)
        first = load_settings()
        first["openai"]["model"] = "mutated"
        self.assertNotEqual(load_settings()["openai"]["model"], "mutated")
        SETTINGS_PATH.write_text("{broken", encoding="utf-8")
        self.assertEqual(load_settings()["provider"], "mock")
        save_settings({"provider": "mock"})
        self.assertEqual(load_settings()["provider"], "mock")

    def test_multiline_colored_chinese_note_export(self):
        did, _ = self.doc()
        with Session(engine) as s:
            documents.create_annotation(did, {"page_number": 1, "kind": "comment", "target": "source",
                "content": "中文附注测试", "color": "#bbf7d0", "bbox": [72, 80, 320, 155],
                "rects": [[72, 80, 220, 100], [72, 135, 160, 155]]}, s)
            documents.create_annotation(did, {"page_number": 1, "kind": "comment", "target": "image",
                "content": "区域附注", "bbox": [72, 200, 120, 240]}, s)
            result = documents.export_annotated_pdf(did, s)
        with pymupdf.open(stream=result.body, filetype="pdf") as pdf:
            page = pdf[0]
            anns = list(page.annots())
            self.assertEqual(anns[0].type[1], "Highlight")
            self.assertEqual(len(anns[0].vertices), 8)
            self.assertEqual(anns[0].info["content"], "中文附注测试")
            for actual, expected in zip(anns[0].colors["stroke"], [187/255, 247/255, 208/255]):
                self.assertAlmostEqual(actual, expected, places=4)
            self.assertEqual(anns[1].type[1], "Text")
            self.assertEqual(anns[1].info["content"], "区域附注")
            # Rendering catches invalid appearance streams, independently of metadata.
            self.assertGreater(len(page.get_pixmap().samples), 0)

    def test_paragraph_highlight_has_straight_edges_and_separate_lines(self):
        did, bid = self.doc()
        with Session(engine) as s:
            body = {"page_number": 1, "block_id": bid, "kind": "comment", "target": "source",
                    "content": "整段批注", "bbox": [70, 80, 400, 160], "rects": [[70, 80, 400, 160]]}
            created = documents.create_annotation(did, body, s)
            self.assertEqual(len(created.rects), 2)
            # An existing pre-fix record also needs line repair at export time.
            created.rects = [body["bbox"]]; s.add(created); s.commit()
            out = documents.export_annotated_pdf(did, s)
        with pymupdf.open(stream=out.body, filetype="pdf") as pdf:
            page = pdf[0]
            annot = next(page.annots())
            self.assertEqual(annot.type[1], "Highlight")
            self.assertEqual(len(annot.vertices), 8)
            ref = int(pdf.xref_get_key(annot.xref, "AP/N")[1].split()[0])
            stream = pdf.xref_stream(ref).decode()
            self.assertEqual(stream.count(" re f"), 2)
            self.assertNotIn(" c", stream)
            # Straight corners stay within the selected line extents; the gap stays white.
            image = page.get_pixmap(alpha=False)
            self.assertEqual(image.pixel(65, 120), (255, 255, 255))
            self.assertEqual(image.pixel(80, 120), (255, 255, 255))
            self.assertNotEqual(image.pixel(75, 95), (255, 255, 255))

    def test_straight_highlight_rendering_matches_rotated_selection(self):
        from app.pdf_annotations import highlight_rects, straight_highlight
        for crop in (None, pymupdf.Rect(20, 30, 575, 812)):
            for angle in (0, 90, 180, 270):
                with pymupdf.open(self.pdf) as pdf:
                    page = pdf[0]
                    if crop: page.set_cropbox(crop)
                    page.set_rotation(angle)
                    dx, dy = (crop.x0, crop.y0) if crop else (0, 0)
                    visual = list(pymupdf.Rect(70-dx, 80-dy, 400-dx, 160-dy) * page.rotation_matrix)
                    rects = highlight_rects(page, [visual], split_paragraph=True)
                    self.assertEqual(len(rects), 2)
                    straight_highlight(page, rects, (1, 1, 0), "旋转整段")
                    image = page.get_pixmap(alpha=False)
                    inside = pymupdf.Point(75-dx, 95-dy) * page.rotation_matrix
                    gap = pymupdf.Point(80-dx, 120-dy) * page.rotation_matrix
                    self.assertNotEqual(image.pixel(int(inside.x), int(inside.y)), (255, 255, 255))
                    self.assertEqual(image.pixel(int(gap.x), int(gap.y)), (255, 255, 255))

    def test_page_annotation_without_rect_is_visible_and_linked_in_pdf(self):
        did, _ = self.doc()
        for angle in (0, 90, 180, 270):
            with pymupdf.open(self.pdf) as p:
                p[1].set_rotation(angle)
                rotated = DOCS_DIR / f"page-note-{angle}.pdf"; p.save(rotated)
            with Session(engine) as s:
                d = s.get(Document, did); d.file_path = str(rotated); s.add(d); s.commit()
                page_note = documents.create_annotation(did, {"page_number": 2, "kind": "note",
                    "bbox": [], "content": f"第2页页批注不会消失 {angle}"}, s)
                out = documents.export_annotated_pdf(did, s)
            with pymupdf.open(stream=out.body, filetype="pdf") as pdf:
                source = pdf[1]
                self.assertTrue(any(a.info["content"].endswith(str(angle)) for a in source.annots()))
                self.assertIn(f"A{page_note.id}", source.get_text())
                self.assertTrue(any(link["page"] >= 4 for link in source.get_links()))
                self.assertIn(f"第2页页批注不会消失 {angle}", "".join(p.get_text() for p in list(pdf)[4:]))
                self.assertGreater(len(source.get_pixmap().samples), 0)

    def test_rotated_pdf_parse_crop_and_export(self):
        for rotation in (0, 90, 180, 270):
            rotated = DOCS_DIR / f"rotation-{rotation}.pdf"
            with pymupdf.open(self.pdf) as pdf:
                pdf[0].set_rotation(rotation)
                pdf.save(rotated)
            with patch("app.parsing.detect_layout", return_value=None):
                pages, blocks = parse_pdf_file(str(rotated))
            b = next(b for b in blocks if "example" in b["text"])
            with pymupdf.open(rotated) as pdf:
                raw = pdf[0].get_text("blocks")[0][:4]
                visual = pymupdf.Rect(raw) * pdf[0].rotation_matrix
                for actual, expected in zip(b["bbox"], visual):
                    self.assertAlmostEqual(actual, expected, places=1)
                self.assertEqual(pages[0]["width"], pdf[0].rect.width)
            did, _ = self.doc(f"r{rotation}")
            with Session(engine) as s:
                d = s.get(Document, did)
                d.file_path = str(rotated)
                s.add(d)
                s.commit()
                png, text = regions.crop(did, regions.Region(page_number=1, bbox=b["bbox"]), s)
                self.assertTrue(png.startswith(b"\x89PNG"))
                self.assertIn("example", text)
                documents.create_annotation(did, {"page_number": 1, "kind": "highlight", "bbox": b["bbox"]}, s)
                out = documents.export_annotated_pdf(did, s)
            with pymupdf.open(stream=out.body, filetype="pdf") as pdf:
                page = pdf[0]
                annot = next(page.annots())
                self.assertGreater(len(annot.vertices), 0)
                self.assertGreater(len(page.get_pixmap().samples), 0)

    def test_numbered_protocol_validates_duplicate_empty_and_count(self):
        self.assertIn("<<<0>>>", SYSTEM_PROMPT)
        self.assertEqual(_split_numbered("<<<0>>>\n一\n<<<1>>>\n二", 2), ["一", "二"])
        for text in ("<<<0>>>一<<<0>>>二", "<<<0>>>一<<<1>>>", "<<<0>>>一"):
            with self.assertRaises(BatchParseError):
                _split_numbered(text, 2)
        provider = FakeProvider()
        provider.translate = lambda *args: []
        self.assertEqual(_translate_with_fallback(provider, ["x", "y"], [], ""), [None, None])

    def test_target_language_is_passed_to_prompt(self):
        provider = OpenAICompatibleProvider("http://localhost", "fake", "test", "simple", "French")
        with patch.object(provider, "_chat", return_value="texte") as chat:
            provider.translate(["text"], [], "")
            self.assertIn("French", chat.call_args.args[0])

    def test_simple_protocol_preserves_successes_on_partial_failure(self):
        provider = OpenAICompatibleProvider("http://localhost", "fake", "test", "simple")
        with patch.object(provider, "_translate_simple", side_effect=["译文", ValueError("bad paragraph")]) as call:
            self.assertEqual(_translate_with_fallback(provider, ["good", "bad"], [], ""), ["译文", None])
            self.assertEqual(call.call_count, 2)
            self.assertIn("bad paragraph", provider.last_error)

    def test_transient_http_errors_retry_with_bounded_backoff(self):
        import httpx
        provider = OpenAICompatibleProvider("http://localhost", "fake", "test")
        request = httpx.Request("POST", "http://localhost/chat/completions")
        responses = [httpx.Response(429, request=request), httpx.Response(200, request=request,
            json={"choices": [{"finish_reason": "stop", "message": {"content": "译文"}}]})]
        with patch("app.translators.http_post", side_effect=responses) as post, patch("app.translators.time.sleep") as sleep:
            self.assertEqual(provider._chat("s", "u"), "译文")
            self.assertEqual(post.call_count, 2)
            sleep.assert_called_once_with(0.5)

    def test_memory_upsert_same_source_is_atomic(self):
        with Session(engine) as s:
            _tm_store(s, "zh", "source", "first", "openai", "model")
            _tm_store(s, "zh", "source", "second", "openai", "model")
            s.commit()
            rows = s.exec(select(TranslationMemory)).all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].translated_text, "second")

    def test_parse_auto_translation_keeps_valid_anchors(self):
        did, bid = self.doc()
        with Session(engine) as s:
            note = documents.create_note(did, {"page_number": 1, "block_id": bid, "quote": "example transformer"}, s)
            note_id = note.id
        save_settings({"auto_translate": True})
        with patch("app.parsing.detect_layout", return_value=None):
            run_parse(did)
        with Session(engine) as s:
            self.assertEqual(s.get(Document, did).status, "ready")
            self.assertIsNotNone(s.get(Note, note_id).block_id)
            segs = s.exec(select(TranslationSegment).where(TranslationSegment.document_id == did)).all()
            self.assertTrue(segs and all(seg.status == "done" for seg in segs))

    def test_legacy_rotated_blocks_are_adapted_without_reparse(self):
        did, bid = self.doc()
        with pymupdf.open(self.pdf) as pdf:
            pdf[0].set_rotation(90)
            rotated = DOCS_DIR / "legacy-rotated.pdf"
            pdf.save(rotated)
            expected = list(pymupdf.Rect(72, 80, 330, 110) * pdf[0].rotation_matrix)
        with Session(engine) as s:
            doc = s.get(Document, did)
            doc.file_path = str(rotated)
            s.add(doc)
            s.commit()
            out = documents.get_blocks(did, s)
            self.assertEqual(out[0]["bbox"], expected)
            self.assertEqual(out[0]["metadata"]["rotation"], 90)
            self.assertEqual(s.get(Block, bid).bbox, [72, 80, 330, 110])

    def test_startup_recovers_jobs_and_removes_mock_memory(self):
        did, bid = self.doc()
        with Session(engine) as s:
            d = s.get(Document, did)
            d.status = "parsing"
            s.add(d)
            b = s.get(Block, bid)
            b.extra_meta = {"ocr": {"status": "running"}}
            s.add(b)
            s.add(TranslationSegment(block_id=bid, document_id=did, status="running"))
            s.add(TranslationMemory(src_hash="old-mock", source_text="x", translated_text="bad", provider="mock"))
            s.commit()
        init_db()
        with Session(engine) as s:
            self.assertEqual(s.get(Document, did).status, "parse_failed")
            self.assertEqual(s.get(Block, bid).extra_meta["ocr"]["status"], "failed")
            self.assertEqual(s.exec(select(TranslationMemory)).all(), [])
        self.assertEqual(self.segment(bid).status, "failed")

    def test_ocr_batch_keeps_document_busy_until_last_figure(self):
        did, _ = self.doc()
        with Session(engine) as s:
            for i in range(2):
                s.add(Block(document_id=did, page_number=1, block_type="image", bbox=[72, 200, 200, 300]))
            s.commit()
        seen = []
        def extract(*args):
            with Session(engine) as s:
                seen.append(s.get(Document, did).status)
            return []
        with patch("app.ocr.extract_lines_with_boxes", side_effect=extract), patch("app.tasks.time.sleep"):
            run_figures_ocr(did)
        self.assertEqual(seen, ["translating", "translating"])
        with Session(engine) as s:
            self.assertEqual(s.get(Document, did).status, "ready")

    def test_origin_and_lan_token_security(self):
        async def response(_):
            return Response("ok")
        def request(client="127.0.0.1", origin=None, cookie=None, query=b"", path="/api/health"):
            headers = [(b"host", b"localhost:8000")]
            if origin:
                headers.append((b"origin", origin.encode()))
            if cookie:
                headers.append((b"cookie", f"reader_access={cookie}".encode()))
            return Request({"type": "http", "method": "GET", "scheme": "http", "path": path,
                "raw_path": path.encode(), "query_string": query, "headers": headers,
                "client": (client, 1234), "server": ("localhost", 8000)})
        self.assertEqual(asyncio.run(access_guard(request(origin="https://evil.example"), response)).status_code, 403)
        self.assertEqual(asyncio.run(access_guard(request(origin="http://localhost:5173"), response)).status_code, 200)
        with patch.dict(os.environ, {"APP_ACCESS_TOKEN": "test-pair-token"}):
            self.assertEqual(asyncio.run(access_guard(request("192.168.1.2"), response)).status_code, 401)
            self.assertEqual(asyncio.run(access_guard(request("192.168.1.2", cookie="test-pair-token"), response)).status_code, 200)
            paired = asyncio.run(access_guard(request("192.168.1.2", query=b"token=test-pair-token", path="/"), response))
            self.assertEqual(paired.status_code, 303)
            self.assertIn("HttpOnly", paired.headers["set-cookie"])

    def test_generated_sample_quality(self):
        from make_user_guide import make
        sample = Path(TEMP.name) / "sample.pdf"
        make(sample)
        with patch("app.parsing.detect_layout", return_value=None):
            pages, blocks = parse_pdf_file(str(sample))
        self.assertEqual(len(pages), 4)
        self.assertTrue(50 <= len(blocks) <= 100, len(blocks))
        self.assertIn("User Guide", blocks[0]["text"])
        text = " ".join(b["text"] for b in blocks)
        self.assertNotIn("Translator Reader / User Guide", text)
        self.assertIn("N_hit", text)
        self.assertIn("×", text)
        self.assertTrue(any(b["block_type"] == "image" for b in blocks))


if __name__ == "__main__":
    try:
        program = unittest.main(verbosity=2, exit=False)
    finally:
        engine.dispose()
        TEMP.cleanup()
    sys.exit(0 if program.result.wasSuccessful() else 1)
