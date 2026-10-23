"""Reproducible four-page user manual and two-column PDF practice fixture.
No system fonts, screenshots, network or translation keys are required.
Usage: python scripts/make_user_guide.py [output.pdf]
"""
from pathlib import Path
import sys
import pymupdf

REPO = Path(__file__).resolve().parents[1]
PAGE_COUNT = 4
W, H = 595, 842
INK, MUTED, ACCENT = (.12,.17,.25), (.36,.41,.48), (.22,.30,.66)
LEFT, RIGHT = (42,284), (311,553)
BOTTOM = 778
TITLE = "Translator Reader User Guide"


def write(page, text, column, y, *, size=10, bold=False, color=INK, bottom=BOTTOM):
    """Use actual text height; fail instead of clipping or overlapping blocks."""
    rect = pymupdf.Rect(column[0],y,column[1],bottom)
    remaining = page.insert_textbox(rect,text,fontsize=size,fontname="hebo" if bold else "helv",
                                    color=color,lineheight=1.4)
    if remaining < 0: raise ValueError(f"Guide overflow on page {page.number+1}: {text[:70]}")
    return y + rect.height-remaining+8


def section(page, title, texts, column, y):
    y=write(page,title,column,y,size=12,bold=True,color=ACCENT)+3
    for text in texts: y=write(page,text,column,y)
    return y+6


def header(doc, number, title):
    page=doc.new_page(width=W,height=H)
    write(page,"Translator Reader / User Guide",(42,400),18,size=8,color=MUTED,bottom=40)
    page.draw_line((42,42),(553,42),color=(.83,.86,.90),width=.7)
    write(page,title,(42,553),57,size=18,bold=True)
    page.insert_text((42,812),"Local-first academic PDF reading",fontsize=8,color=MUTED)
    page.insert_text((521,812),f"{number} / {PAGE_COUNT}",fontsize=8,color=MUTED)
    return page


def workflow(page, column, y):
    with pymupdf.open() as illustration:
        fig=illustration.new_page(width=480,height=180)
        for i,label in enumerate(("Import","Parse","Translate","Annotate","Export")):
            x=8+i*95
            fig.draw_rect(pymupdf.Rect(x,40,x+84,95),color=ACCENT,fill=(.94,.96,1),width=1)
            fig.insert_textbox(pymupdf.Rect(x,58,x+84,83),label,fontsize=11,fontname="hebo",align=1,color=ACCENT)
            if i<4:fig.draw_line((x+84,67),(x+94,67),color=ACCENT,width=1.5)
        fig.insert_textbox(pymupdf.Rect(12,116,470,164),"Your PDFs and reading notes stay on your machine.\nOnly configured translation requests contact a provider.",fontsize=11,align=1,color=MUTED)
        height=(column[1]-column[0])*180/480
        page.insert_image(pymupdf.Rect(column[0],y,column[1],y+height),pixmap=fig.get_pixmap(matrix=pymupdf.Matrix(2,2)))
    return write(page,"Fig. 1: The reading workflow. Try translating the labels and this caption.",column,y+height+5,size=9,color=MUTED)+8


def export_table(page,column,y):
    y=write(page,"Table 1: What each export contains.",column,y,size=9,color=MUTED)
    rows=[("Format","Contents"),("Markdown","Source, translation or bilingual text, plus reading notes."),
          ("Annotated PDF","Original PDF, highlights, markers and a visible notes appendix."),
          ("JSON","Blocks, translations, annotations and notes; no one-click restore UI.")]
    x0,x1=column; split=x0+76
    for i,(label,content) in enumerate(rows):
        height=25 if i==0 else 64
        page.draw_rect(pymupdf.Rect(x0,y,x1,y+height),color=(.77,.81,.87),fill=(.93,.95,.99) if i==0 else None,width=.6)
        page.draw_line((split,y),(split,y+height),color=(.77,.81,.87),width=.6)
        write(page,label,(x0+5,split-5),y+6,size=8.3,bold=i==0,bottom=y+height-2)
        write(page,content,(split+5,x1-5),y+6,size=8.3,bold=i==0,bottom=y+height-2)
        y+=height
    return y+14


def practice_figure(page, column, y, *, kind):
    """Code-drawn raster examples double as local OCR practice images."""
    with pymupdf.open() as illustration:
        fig=illustration.new_page(width=480,height=260)
        fig.draw_rect(fig.rect,color=(.80,.84,.90),fill=(.97,.98,1),width=1)
        if kind=="selection":
            fig.insert_text((20,30),"SELECT A SENTENCE",fontsize=15,fontname="hebo",color=ACCENT)
            fig.draw_rect(pymupdf.Rect(20,53,450,83),fill=(1,.93,.48),color=None)
            fig.insert_text((25,74),"Each highlighted sentence has its own color.",fontsize=17,color=INK)
            fig.draw_rect(pymupdf.Rect(20,96,432,126),fill=(.72,.90,1),color=None)
            fig.insert_text((25,117),"A second selection keeps its original color.",fontsize=17,color=INK)
            for x in (20,450):
                fig.draw_line((x,50),(x,86),color=ACCENT,width=2)
                fig.draw_circle((x,88),3,color=ACCENT,fill=ACCENT)
            fig.draw_rect(pymupdf.Rect(20,153,460,238),color=(.80,.84,.90),fill=(1,1,1),width=1)
            fig.insert_text((34,177),"NOTE: Check the evidence behind this claim.",fontsize=14,color=INK)
            fig.insert_text((34,200),"Save > Export annotated PDF > Notes appendix",fontsize=13,color=ACCENT)
            fig.insert_text((34,222),"Edit one highlight; the other stays unchanged.",fontsize=12,color=MUTED)
            caption="Fig. 2: Precise selection, independent colors and a saved note. The image shows an example, not interactive controls."
        else:
            fig.insert_text((20,30),"IMAGE TEXT TO TRANSLATION",fontsize=15,fontname="hebo",color=ACCENT)
            labels=("Input image","OCR labels","Translated labels")
            for i,label in enumerate(labels):
                x=18+i*154
                fig.draw_rect(pymupdf.Rect(x,62,x+136,146),color=ACCENT,fill=(.90,.94,1),width=1)
                fig.insert_textbox(pymupdf.Rect(x+7,76,x+129,136),label,fontsize=17,fontname="hebo",align=1,color=ACCENT)
                if i<2:
                    fig.draw_line((x+137,104),(x+152,104),color=ACCENT,width=2)
                    fig.draw_line((x+146,99),(x+152,104),color=ACCENT,width=2)
                    fig.draw_line((x+146,109),(x+152,104),color=ACCENT,width=2)
            fig.insert_text((20,184),"1. Recognize labels   2. Review text   3. Translate",fontsize=15,color=INK)
            fig.insert_text((20,214),"The caption below is translated separately.",fontsize=15,color=INK)
            fig.insert_text((20,239),"Low-confidence text needs your review.",fontsize=13,color=MUTED)
            caption="Fig. 3: Raster labels for OCR practice. Translate this image and its caption, then review the recognized words."
        height=(column[1]-column[0])*260/480
        page.insert_image(pymupdf.Rect(column[0],y,column[1],y+height),pixmap=fig.get_pixmap(matrix=pymupdf.Matrix(2,2)))
    return write(page,caption,column,y+height+6,size=9,color=MUTED)


def make(output: Path):
    output=Path(output)
    with pymupdf.open() as doc:
        p=header(doc,1,TITLE)
        y=write(p,"Read the original, translate in place, and keep your notes.",(42,553),93,size=11,color=MUTED)
        y=write(p,"Abstract: This English guide is also the sample document. Import it to practice translation, selection, image OCR and export. Before configuring a translator, read docs/USER_GUIDE.zh-CN.md.",(42,553),y)
        y=write(p,"Keywords: PDF reading, translation memory, captions, annotation, local storage",(42,553),y,size=9,color=MUTED)+8
        l=section(p,"1. Quick Start",[
            "1. Install Python 3.11+ and Node.js 22.12+. Run python scripts/setup.py from the repository root.",
            "2. Run python scripts/start.py. Open http://127.0.0.1:8000 and use the User Guide button or import a PDF.",
            "3. Wait for parsing. The default mock provider demonstrates the workflow; it does not produce a real translation.",
            "4. Choose your provider in Settings, then translate the document. Failed segments can be retried."],LEFT,y)
        section(p,"2. Configure Translation",[
            "For a local Ollama service, choose the OpenAI-compatible provider and Base URL http://127.0.0.1:11434/v1. Use the exact installed model name.",
            "Choose simple single-segment mode for translation-specialized models. Use numbered batches for instruction models that preserve the output markers.",
            "For a cloud service, set its Base URL and model in Settings. Put the key in .env under the configured API key environment variable. Restart after editing .env; never commit it."],LEFT,l)
        r=workflow(p,RIGHT,y)
        section(p,"A safe first exercise",[
            "Import this guide, translate it, select one complete sentence, add a note, and export the annotated PDF. Check both the marker on the original page and the notes appendix.",
            "Automatic translation is optional. Parsing and local OCR do not require an API key. Real translation uses your configured service and may incur provider charges.",
            "Installation downloads dependencies. Once installed, parsing, OCR, annotation and export run locally. A remote translation or vision service receives the text or image you ask it to process."],RIGHT,r)

        p=header(doc,2,"Read precisely and keep useful notes")
        l=section(p,"3. Reading and Selection",[
            "The left pane is the source PDF. The right pane uses the same pages with translated text at the original positions. Titles keep source size and weight where space permits; figure graphics, table cells and formulas are preserved.",
            "Use dual-pane, source-only or translation-only view. Scroll positions stay synchronized. Zoom reuses page content to reduce work on long papers.",
            "Drag from the first character to the last character of a sentence. Selection stays in its starting column; drag near the viewport edge to scroll. Double-click selects a word; triple-click selects a paragraph.",
            "Click a paragraph for copy or retranslation actions. Ctrl+F searches the current paper; library search scans all papers. The outline lists detected headings."],LEFT,104)
        l=section(p,"Keyboard shortcuts",[
            "J / K or PageDown / PageUp: next / previous page. Ctrl+Home / End: first / last page. + / - / 0: zoom / fit width. 1 / 2 / 3: dual / source / translation view. ?: help.",
            "Ctrl+wheel zooms at the pointer. H toggles the hand tool; Space+left drag or middle drag pans the page. Ctrl+Z undoes saved note/highlight edits; Ctrl+Shift+Z or Ctrl+Y redoes. Text fields keep native undo. History ends when you leave the paper."],LEFT,l)
        practice_figure(p,LEFT,l+8,kind="selection")
        r=section(p,"4. Highlights, Notes and Export",[
            "After selecting text, choose Highlight or Highlight and Note. Each selection is independent: editing one color does not recolor other selections.",
            "Save with Done or Ctrl+Enter. Esc also saves. If saving fails, the draft remains. Use the annotation list to edit, delete or locate selections.",
            "Reading notes can quote a paragraph or refer to a page or the whole document. Page markers open their notes. Wait for saves to finish before exporting."],RIGHT,104)
        r=export_table(p,RIGHT,r)
        write(p,"PDF export contains original pages with notes, not the translated browser overlay. Use Markdown for translated text. Some viewers hide popup comments; the visible notes appendix contains their text.",RIGHT,r,size=9.5)

        p=header(doc,3,"Translate figures and reuse your work")
        l=section(p,"5. Images and Captions",[
            "Translate Image and Caption reads PDF text first, then uses local RapidOCR / PP-OCRv4 for raster text. Recognized labels go to your text translation provider.",
            "The same action recovers missing captions on older documents and translates the nearest figure caption, even outside the image crop. Full-document translation also recovers native captions without re-parsing.",
            "Detected raster-only captions are OCR candidates. Blurred text and low-confidence labels may remain untranslated for review. Table captions are translated separately from table cells.",
            "Use the correction dialog to inspect recognized text. Draw a region for OCR or choose Vision Recognition when needed. Its separately configured service must accept images. A default model name does not install or start that model."],LEFT,104)
        l=section(p,"Layout detection",["DocLayout-YOLO is optional. Install its package and DocStructBench weights using docs/INSTALL.md for figure, table and caption localization. Without them the reader uses heuristics. Whole-page scanned-paper OCR is not yet a complete import pipeline."],LEFT,l)
        practice_figure(p,LEFT,l+8,kind="ocr")
        r=section(p,"6. Translation Memory and Data",[
            "Successful real translations are reused for matching source text, target language and forced glossary. Mock output is excluded. Changed text or glossary can require new requests; re-parsing is not always free.",
            "Continue Translation fills missing work. Force Retranslate bypasses reusable results and requests the current provider. Repeated image translation reuses successful matching captions.",
            "Re-parsing clears current paragraph translations. Notes remain, with quote-based reattachment where possible. Prefer automatic caption recovery when only captions are missing.",
            "PDFs, SQLite records and settings live in data/, or APP_DATA_DIR. JSON export archives a paper but is not a complete database backup. Stop the app before copying the entire data directory; protect .env separately."],RIGHT,104)
        r=section(p,"Privacy and access",["Do not publish private papers, app.db, API keys or pairing tokens. LAN mode is explicit: python scripts/start.py --lan. Use the pairing link on trusted devices. Keep one server worker; this is a personal reader."],RIGHT,r)
        write(p,"Practice formula: H = N_hit / N_total × 100%. This is a symbolic example, not a benchmark. Verify important equations and numbers against the source.",RIGHT,r,size=9.5)

        p=header(doc,4,"Troubleshoot, contribute and practice")
        l=section(p,"7. Troubleshooting",[
            "Blank interface: complete setup and rebuild the frontend. /api/health checks the backend only. A missing frontend build reports how to generate it.",
            "Translation fails: check model, Base URL, protocol and API key variable. Review the error and retry. A local model must already be running.",
            "Caption missing: try Translate Image and Caption. If a raster caption was not detected, crop it for OCR or vision and review the result.",
            "Note missing in a PDF viewer: open the visible notes appendix at the end. Export again after saving your latest edits."],LEFT,104)
        section(p,"8. For Developers and Agents",["Read README.md, AGENTS.md and docs/INSTALL.md. Tests use temporary data and mock services. Run python scripts/run_tests.py, build the frontend, then run npm --prefix frontend run test:browser. Do not modify an existing library or use paid translations as a test."],LEFT,l)
        r=write(p,"References",RIGHT,104,size=12,bold=True,color=ACCENT)+3
        for text in ("[1] README.md and docs/USER_GUIDE.zh-CN.md: setup and current operation instructions.",
                     "[2] PyMuPDF: pymupdf.readthedocs.io",
                     "[3] DocLayout-YOLO: github.com/opendatalab/DocLayout-YOLO",
                     "[4] RapidOCR: github.com/RapidAI/RapidOCR",
                     "[5] Ollama: docs.ollama.com/api/openai-compatibility"):
            r=write(p,text,RIGHT,r,size=9,color=MUTED)
        section(p,"Appendix A: Practice Checklist",[
            "Select this sentence and add a note about your reading goal. Highlight another sentence in a different color. Edit the first color and confirm the second stays unchanged.",
            "Create a page note. Export Markdown and the annotated PDF, then inspect their note sections. Check the figure and table captions on earlier pages after translation.",
            "Switch views and zoom several times. Reopen the paper to check its remembered page. References above remain untranslated; this appendix should still be translated."],RIGHT,r+10)
        doc.set_toc([[1,TITLE,1],[2,"Quick start and configuration",1],[2,"Reading, annotation and export",2],
                     [2,"Images, captions and storage",3],[2,"Troubleshooting and practice",4]])
        doc.set_metadata({"title":TITLE,"author":"Translator Reader contributors","subject":"Setup, reading, OCR, captions, notes and export","keywords":"PDF, translation, local-first, user guide"})
        output.parent.mkdir(parents=True,exist_ok=True)
        doc.subset_fonts()
        # Keep identical generated guides byte-identical so content-hash upload
        # deduplication also works between the shipped and practice copies.
        doc.save(output,garbage=4,deflate=True,no_new_id=True)
    print(f"User guide generated: {output}")


if __name__=="__main__":
    make(Path(sys.argv[1]) if len(sys.argv)>1 else REPO/"data"/"sample_paper.pdf")
