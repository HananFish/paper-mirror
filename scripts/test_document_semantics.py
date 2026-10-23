"""Offline typography, caption and bibliography regressions with isolated data."""
import unittest
from unittest.mock import patch

import test_regressions as fixtures
from test_regressions import (FakeProvider, DOCS_DIR, Session, engine,
                              Block, TranslationSegment, select, pymupdf, documents,
                              parse_pdf_file, run_parse, run_translation, misc, BackgroundTasks, HTTPException)
from app.parsing import mark_reference_sections
from app.document_semantics import recover_captions
from app.tasks import run_figure_ocr


class DocumentSemanticsTests(unittest.TestCase):
    setUp = fixtures.RegressionTests.setUp
    doc = fixtures.RegressionTests.doc

    def test_open_old_paper_repairs_captions_without_provider_or_anchor_changes(self):
        from app.models import Note
        self.pdf=self.paper();did,bid=self.doc(source="Preserved body text")
        with Session(engine) as s:
            note=Note(document_id=did,block_id=bid,content="Keep this note")
            s.add(note);s.add(TranslationSegment(document_id=did,block_id=bid,status="done",text="Keep this translation"))
            s.commit();nid=note.id
            with patch("app.tasks.get_provider",side_effect=AssertionError("repair must not translate")),patch("app.ocr.recognize_png",side_effect=AssertionError("native repair must not OCR")):
                repaired=documents.repair_document_captions(did,s)
                self.assertGreaterEqual(repaired["recovered"],2)
                s.expire_all()
                self.assertEqual(documents.repair_document_captions(did,s)["recovered"],0)
            s.expire_all()
            self.assertEqual(s.get(fixtures.Document,did).status,"ready")
            self.assertEqual(s.get(Note,nid).block_id,bid)
            self.assertEqual(s.get(Block,bid).text,"Preserved body text")
            self.assertEqual(s.exec(select(TranslationSegment).where(TranslationSegment.block_id==bid)).one().text,"Keep this translation")
            exposed=documents.get_blocks(did,s)
            caption=next(b for b in exposed if b["text"].startswith("Figure 1"))
            self.assertEqual(caption["block_type"],"caption");self.assertIsNone(caption["translation"])
            self.assertGreater(documents._doc_progress(s,did)["total_blocks"],1)

    def test_body_figure_references_do_not_steal_caption_association(self):
        from app.parsing import _caption_start
        for text in ("Figure 3 shows the number of questions.","Figure 6 (a), this analysis pinpoints the problem.","Figures 3 and 4 demonstrate the method."):
            self.assertFalse(_caption_start(text),text)
        for text in ("Figure 3. Results of the experiment.","Fig. S.1: Architecture.","Figure 2 (a) Inputs. (b) Outputs."):
            self.assertTrue(_caption_start(text),text)

    def test_caption_failure_is_reported_even_if_image_ocr_is_empty(self):
        self.pdf=self.paper();did,_=self.doc()
        with Session(engine) as s:
            image=Block(document_id=did,page_number=1,block_type="image",bbox=[72,200,500,260])
            s.add(image);s.commit();s.refresh(image);bid=image.id
        provider=FakeProvider();provider.translate=lambda *args: (_ for _ in ()).throw(RuntimeError("caption provider unavailable"))
        with patch("app.layout_yolo.detect_layout",return_value=None),patch("app.ocr.extract_lines_with_boxes",return_value=[]),patch("app.tasks.get_provider",return_value=provider):
            run_figure_ocr(did,bid)
        with Session(engine) as s:
            state=s.get(Block,bid).extra_meta["ocr"]
            self.assertEqual(state["status"],"partial")
            self.assertEqual(state["captions"]["total"],1)
            self.assertEqual(state["captions"]["failed"],1)
            self.assertIn("caption provider unavailable",state["captions"]["error"])

    def test_caption_recovery_failure_releases_reservation(self):
        did,_=self.doc()
        with Session(engine) as s,patch("app.tasks.recover_captions",side_effect=RuntimeError("broken PDF")):
            with self.assertRaises(HTTPException) as ctx:documents.repair_document_captions(did,s)
            self.assertEqual(ctx.exception.status_code,503)
            s.expire_all();self.assertEqual(s.get(fixtures.Document,did).status,"ready")

    def paper(self):
        path = DOCS_DIR / "semantics.pdf"
        with pymupdf.open() as pdf:
            page = pdf.new_page()
            title = "Document Structure"
            width = pymupdf.get_text_length(title, fontname="hebo", fontsize=22)
            page.insert_text(((page.rect.width-width)/2,80),title,fontname="hebo",fontsize=22)
            page.insert_text((72,130),"1. Introduction",fontname="hebo",fontsize=12)
            page.insert_textbox(pymupdf.Rect(72,160,510,220),"This is an ordinary body paragraph explaining the experiment and the scientific results. "*3,fontsize=12)
            page.draw_rect(pymupdf.Rect(72,260,500,345))
            page.insert_text((90,300),"Diagram labels",fontsize=10)
            page.insert_text((72,363),"Figure 1: Experimental architecture with detailed labels.",fontsize=9)
            page.insert_text((72,375),"The second caption line explains the input and output.",fontsize=9)
            page.insert_text((72,420),"Table 1: Results of the experiment.",fontsize=9)
            for x in (72,280,500):page.draw_line((x,435),(x,495))
            for y in (435,455,475,495):page.draw_line((72,y),(500,y))
            for y in (449,469,489):
                page.insert_text((80,y),"Method",fontsize=9);page.insert_text((300,y),"Accuracy",fontsize=9)
            page.insert_text((72,513),"Note: Scores are averaged over three runs.",fontsize=9)
            page=pdf.new_page()
            page.insert_text((72,100),"References",fontname="hebo",fontsize=12)
            page.insert_text((72,135),"[1] Alice Smith. An unrelated paper title. 2024.",fontsize=10)
            page.insert_text((72,155),"Proceedings of a scientific conference, pages 100-110.",fontsize=10)
            page=pdf.new_page()
            page.insert_text((72,100),"[2] Bob Jones. Another unrelated paper. 2025.",fontsize=10)
            page.insert_text((72,200),"Appendix A: Further Experiments",fontname="hebo",fontsize=14)
            page.insert_text((72,235),"This appendix paragraph must still be translated.",fontsize=10)
            pdf.save(path)
        return path

    def test_split_caption_label_supplement_number_and_margin(self):
        from app.parsing import _caption_groups, _drop_margin_junk, _is_repeated_furniture
        lines=[{"text":"Fig. S.1:","bbox":[72,790,111,802],"size":9,"bold":True},
               {"text":"Detailed architecture description.","bbox":[112,790,360,802],"size":9,"bold":False}]
        _,groups=_caption_groups(lines)
        self.assertEqual(len(groups),1)
        self.assertIn("Detailed architecture",groups[0]["text"])
        self.assertEqual(len(_drop_margin_junk([lines[0]],810,595)),1)
        self.assertFalse(_is_repeated_furniture(lines[0],810,{("Fig. S.#:",33)}))

    def test_caption_recovery_preserves_ids_translations_notes_and_rotation(self):
        from app.models import Note
        self.pdf=self.paper()
        with pymupdf.open(self.pdf) as pdf:
            pdf[0].set_rotation(90);rotated=DOCS_DIR/"caption-rotated.pdf";pdf.save(rotated)
        self.pdf=rotated;did,bid=self.doc()
        with Session(engine) as s:
            s.add(TranslationSegment(document_id=did,block_id=bid,status="done",text="已有译文"))
            note=Note(document_id=did,block_id=bid,content="已有笔记");s.add(note);s.commit();nid=note.id
            recovered=recover_captions(s,s.get(fixtures.Document,did));s.commit()
            figure=next(b for b in recovered if b.text.startswith("Figure 1"))
            self.assertEqual(figure.extra_meta["rotation"],90)
            with pymupdf.open(rotated) as pdf:
                expected=pdf[0].search_for("Figure 1")[0]*pdf[0].rotation_matrix
            self.assertAlmostEqual(figure.bbox[0],expected.x0-12,delta=2)
            self.assertEqual(recover_captions(s,s.get(fixtures.Document,did)),[])
            self.assertIsNotNone(s.get(Block,bid));self.assertEqual(s.get(Note,nid).block_id,bid)
            self.assertEqual(s.exec(select(TranslationSegment).where(TranslationSegment.block_id==bid)).one().text,"已有译文")

    def test_image_action_recovers_and_translates_caption_outside_crop_once(self):
        self.pdf=self.paper()
        with pymupdf.open(self.pdf) as pdf:
            pdf[0].set_rotation(90);rotated=DOCS_DIR/"image-caption-rotated.pdf";pdf.save(rotated)
        self.pdf=rotated;did,_=self.doc()
        with Session(engine) as s:
            image=Block(document_id=did,page_number=1,block_type="image",bbox=[72,260,500,345])
            s.add(image);s.commit();s.refresh(image);bid=image.id
        calls=[];provider=FakeProvider()
        provider.model="mock-1"
        provider.translate=lambda texts,glossary,context:calls.extend(texts) or ["图注译文" for _ in texts]
        with patch("app.layout_yolo.detect_layout",return_value=None),patch("app.ocr.extract_lines_with_boxes",return_value=[]),patch("app.tasks.get_provider",return_value=provider):
            run_figure_ocr(did,bid);run_figure_ocr(did,bid)
        self.assertEqual(len(calls),1,calls)
        self.assertIn("second caption line",calls[0])
        with Session(engine) as s:
            caption=s.exec(select(Block).where(Block.document_id==did,Block.block_type=="caption")).all()
            c=next(b for b in caption if b.text.startswith("Figure 1"))
            self.assertEqual(s.exec(select(TranslationSegment).where(TranslationSegment.block_id==c.id)).one().text,"图注译文")
            md=documents.export_markdown(did,"zh",s).body.decode("utf-8")
            self.assertIn("图注译文",md)

    def test_raster_only_detected_caption_becomes_translatable_block(self):
        path=DOCS_DIR/"raster-caption.pdf"
        with pymupdf.open() as pdf:
            pdf.new_page();pdf.save(path)
        layout=[{"name":"figure_caption","bbox":[72,350,500,390]}]
        labels=[{"src":"Figure 2: Raster-only caption description.","confidence":.98,"quad":[[0,0],[900,0],[900,30],[0,30]]}]
        with patch("app.parsing.detect_layout",return_value=layout),patch("app.ocr.recognize_png",return_value=labels):
            _,blocks=parse_pdf_file(str(path))
        self.assertEqual([b["text"] for b in blocks if b["block_type"]=="caption"],[labels[0]["src"]])
        self.pdf=path;did,_=self.doc()
        with Session(engine) as s,patch("app.layout_yolo.detect_layout",return_value=layout),patch("app.ocr.recognize_png",return_value=labels):
            self.assertEqual(len(recover_captions(s,s.get(fixtures.Document,did),[1],raster=True)),1)
            s.commit()
            self.assertEqual(recover_captions(s,s.get(fixtures.Document,did),[1],raster=True),[])

    def test_real_rapidocr_reads_caption_baked_into_image(self):
        path=DOCS_DIR/"real-raster-caption.pdf"
        with pymupdf.open() as source:
            page=source.new_page(width=440,height=60)
            page.insert_text((10,20),"Figure 2: Experimental architecture.",fontsize=12)
            page.insert_text((10,40),"Input and output layers are shown.",fontsize=12)
            png=page.get_pixmap(matrix=pymupdf.Matrix(3,3),alpha=False).tobytes("png")
        with pymupdf.open() as pdf:
            page=pdf.new_page();page.insert_image(pymupdf.Rect(72,350,512,410),stream=png);pdf.save(path)
        layout=[{"name":"figure_caption","bbox":[72,350,512,410]}]
        with patch("app.parsing.detect_layout",return_value=layout):
            _,blocks=parse_pdf_file(str(path))
        caption=next(b for b in blocks if b["block_type"]=="caption")
        self.assertIn("Figure 2",caption["text"])
        self.assertIn("output layers",caption["text"])

    def test_fallback_preserves_caption_continuations_and_table_notes(self):
        with patch("app.parsing.detect_layout",return_value=None):
            _,blocks=parse_pdf_file(str(self.paper()))
        captions=[b["text"] for b in blocks if b["block_type"]=="caption"]
        self.assertTrue(any("second caption line" in text and text.startswith("Figure 1") for text in captions),captions)
        self.assertTrue(any(text.startswith("Table 1") for text in captions),captions)
        self.assertTrue(any(text.startswith("Note:") for text in captions),captions)
        self.assertFalse(any("Figure 1" in b["text"] for b in blocks if b["block_type"]=="table"))

    def test_detected_captions_and_footnotes_are_not_suppressed_or_absorbed(self):
        layout=[{"name":"figure","bbox":[72,260,500,345]},
                {"name":"figure_caption","bbox":[70,351,505,380]},
                {"name":"table","bbox":[72,435,500,495]},
                {"name":"table_caption","bbox":[70,408,500,423]},
                {"name":"table_footnote","bbox":[70,501,500,517]}]
        with patch("app.parsing.detect_layout",side_effect=lambda page:layout if page.number==0 else []):
            _,blocks=parse_pdf_file(str(self.paper()))
        captions=[b for b in blocks if b["block_type"]=="caption"]
        self.assertEqual(len(captions),3,[b["text"] for b in captions])
        self.assertTrue(any("second caption line" in b["text"] for b in captions))
        self.assertTrue(all(b["extra_meta"]["font_weight"]==400 for b in captions))
        figure=next(b for b in blocks if b["block_type"]=="image")
        self.assertEqual(figure["bbox"][3],345)

    def test_main_title_and_same_size_bold_subheading_keep_source_style(self):
        with patch("app.parsing.detect_layout",return_value=None):
            _,blocks=parse_pdf_file(str(self.paper()))
        title=next(b for b in blocks if b["text"]=="Document Structure")
        sub=next(b for b in blocks if b["text"]=="1. Introduction")
        self.assertEqual(title["font_size"],22);self.assertEqual(title["extra_meta"]["font_weight"],700)
        self.assertEqual(title["extra_meta"]["text_align"],"center")
        self.assertEqual(sub["font_size"],12);self.assertEqual(sub["block_type"],"heading")
        self.assertEqual(sub["extra_meta"]["font_weight"],700);self.assertEqual(sub["extra_meta"]["text_align"],"left")

    def test_references_continue_across_pages_and_appendix_resumes(self):
        with patch("app.parsing.detect_layout",return_value=None):
            _,blocks=parse_pdf_file(str(self.paper()))
        refs=[b for b in blocks if b["block_type"]=="reference"]
        self.assertTrue(any("Alice Smith" in b["text"] for b in refs))
        self.assertTrue(any("Bob Jones" in b["text"] for b in refs))
        self.assertFalse(any("appendix paragraph" in b["text"] for b in refs))
        ordinary=[{"text":"Our references to prior work are important.","block_type":"paragraph"}]
        mark_reference_sections(ordinary)
        self.assertEqual(ordinary[0]["block_type"],"paragraph")

    def test_translation_includes_captions_but_never_bibliography(self):
        self.pdf=self.paper();did,_=self.doc()
        with patch("app.parsing.detect_layout",return_value=None):run_parse(did)
        provider=FakeProvider();calls=[]
        provider.translate=lambda texts,glossary,context: calls.extend(texts) or ["译文" for _ in texts]
        with patch("app.tasks.get_provider",return_value=provider):run_translation(did,"mock")
        self.assertTrue(any("Figure 1" in text for text in calls))
        self.assertTrue(any("Note: Scores" in text for text in calls))
        self.assertTrue(any("appendix paragraph" in text for text in calls))
        self.assertFalse(any("Alice Smith" in text or "Bob Jones" in text for text in calls))
        with Session(engine) as s:
            refs=s.exec(select(Block).where(Block.document_id==did,Block.block_type=="reference")).all()
            self.assertTrue(all(s.exec(select(TranslationSegment).where(TranslationSegment.block_id==b.id)).first() is None for b in refs))
            eligible=s.exec(select(Block).where(Block.document_id==did,Block.block_type.in_({"paragraph","heading","list","caption"}))).all()
            progress=documents._doc_progress(s,did)
            self.assertEqual(progress["total_blocks"],len(eligible))
            self.assertEqual(progress["translated"],len(eligible))

    def test_old_bibliography_translations_are_hidden_and_exports_keep_source(self):
        did,_=self.doc(source="References")
        with Session(engine) as s:
            ref=Block(document_id=did,page_number=1,reading_order=1,text="[1] Alice Smith. Useless reference title.",bbox=[72,140,500,160])
            s.add(ref);s.commit();s.refresh(ref)
            s.add(TranslationSegment(document_id=did,block_id=ref.id,status="done",text="旧的无用文献翻译"));s.commit()
            blocks=documents.get_blocks(did,s)
            item=next(b for b in blocks if b["id"]==ref.id)
            self.assertEqual(item["block_type"],"reference");self.assertIsNone(item["translation"])
            with self.assertRaises(HTTPException):misc.retranslate_block(ref.id,BackgroundTasks(),session=s)
            result=documents.export_markdown(did,"zh",s).body.decode("utf-8")
            self.assertIn("Alice Smith",result);self.assertNotIn("旧的无用文献翻译",result)

    def test_old_title_metadata_is_recovered_without_reparse(self):
        self.pdf=self.paper();did,bid=self.doc(source="Document Structure")
        with pymupdf.open(self.pdf) as pdf:
            box=list(pdf[0].search_for("Document Structure")[0])
        with Session(engine) as s:
            block=s.get(Block,bid);block.bbox=box;block.block_type="heading";block.font_size=22;s.add(block);s.commit()
            item=documents.get_blocks(did,s)[0]
            self.assertEqual(item["metadata"]["font_weight"],700)
            self.assertEqual(item["metadata"]["text_align"],"center")
            with pymupdf.open(self.pdf) as pdf:
                sub_box=list(pdf[0].search_for("1. Introduction")[0])
            block=s.get(Block,bid);block.text="1. Introduction";block.block_type="list";block.bbox=sub_box;block.font_size=12;s.add(block);s.commit()
            sub=documents.get_blocks(did,s)[0]
            self.assertEqual(sub["block_type"],"heading")
            self.assertEqual(sub["metadata"]["font_weight"],700)

    def test_plain_title_and_mixed_bold_caption_label_do_not_gain_boldness(self):
        from app.parsing import _extract_lines, _make_para
        lines=_extract_lines([{"type":0,"lines":[{"bbox":[72,90,400,110],"spans":[
            {"text":"Figure 1: ","size":9,"flags":16},
            {"text":"A longer caption description in normal weight.","size":9,"flags":0}]}]}])
        self.assertFalse(_make_para(lines)["bold"])
        plain=DOCS_DIR / "plain-title.pdf"
        with pymupdf.open() as pdf:
            page=pdf.new_page();page.insert_text((72,100),"A Plain Title",fontsize=20);page.insert_text((72,160),"Body text in normal weight.",fontsize=10);pdf.save(plain)
        with patch("app.parsing.detect_layout",return_value=None):
            _,blocks=parse_pdf_file(str(plain))
        title=next(b for b in blocks if b["text"]=="A Plain Title")
        self.assertEqual(title["extra_meta"]["font_weight"],400)
        self.assertEqual(title["font_size"],20)


if __name__=="__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        engine.dispose()
        fixtures.TEMP.cleanup()
