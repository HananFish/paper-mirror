"""Offline release checks: generated manual, backend, document semantics and onboarding.
--api/--full are offline compatibility flags; --real-papers opts into local reading.
"""
import argparse
from collections import Counter
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
VENV=ROOT/".venv"
PYTHON=VENV/("Scripts/python.exe" if os.name=="nt" else "bin/python")
if PYTHON.exists() and Path(sys.prefix).resolve()!=VENV.resolve():
    sys.exit(subprocess.call([str(PYTHON),str(Path(__file__).resolve()),*sys.argv[1:]],env=dict(os.environ,PYTHONIOENCODING="utf-8")))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api",action="store_true")
    parser.add_argument("--full",action="store_true")
    parser.add_argument("--real-papers",action="store_true")
    args=parser.parse_args()
    (ROOT/"data").mkdir(exist_ok=True)
    results=[]
    def check(name, condition):
        results.append(bool(condition))
        print(f"{'PASS' if condition else 'FAIL'} {name}",flush=True)
    with tempfile.TemporaryDirectory(prefix="release-regression-",dir=ROOT/"data") as temp:
        os.environ["APP_DATA_DIR"]=temp
        sys.path[:0]=[str(ROOT/"backend"),str(ROOT/"scripts")]
        from make_user_guide import make, PAGE_COUNT
        from app.parsing import parse_pdf_file
        from unittest.mock import patch
        path=Path(temp)/"guide.pdf";make(path)
        with patch("app.parsing.detect_layout",return_value=None):
            pages,blocks=parse_pdf_file(str(path))
        text=" ".join(b["text"] for b in blocks)
        types=Counter(b["block_type"] for b in blocks)
        check("manual page count",len(pages)==PAGE_COUNT)
        check("manual source title and weight",blocks[0]["text"]=="Translator Reader User Guide" and blocks[0]["block_type"]=="heading" and blocks[0]["extra_meta"]["font_weight"]==700)
        check("manual complete sections",all(any(b["text"].startswith(prefix) for b in blocks) for prefix in ("1. Quick Start","2. Configure Translation","3. Reading and Selection","4. Highlights","5. Images","6. Translation Memory","7. Troubleshooting","8. For Developers","Appendix A:")))
        check("three practice figures and table retained",types["image"]>=3 and types["table"]>=1)
        check("figure and table captions translatable",all(any(b["block_type"]=="caption" and b["text"].startswith(prefix) for b in blocks) for prefix in ("Fig. 1:","Fig. 2:","Fig. 3:","Table 1:")))
        check("reference entries stay source",all(any(b["block_type"]=="reference" and b["text"].startswith(f"[{i}]") for b in blocks) for i in range(1,6)))
        check("appendix resumes after references",any(b["block_type"]=="paragraph" and "reading goal" in b["text"] for b in blocks))
        check("formula and list items retained","N_hit" in text and "×" in text and types["list"]>=4)
        check("repeated furniture removed","Translator Reader / User Guide" not in text and "Local-first academic PDF reading" not in text)
        check("blocks fit source pages",all(0<=b["bbox"][0]<b["bbox"][2]<=pages[b["page_number"]-1]["width"]+.1 and 0<=b["bbox"][1]<b["bbox"][3]<=pages[b["page_number"]-1]["height"]+.1 for b in blocks))
        if args.real_papers:
            import pymupdf
            papers=list((ROOT/"data/documents").glob("*.pdf"))
            check("explicit local paper inputs available",bool(papers))
            for paper in papers:
                # Read only, no DB writes, provider requests or model downloads.
                with pymupdf.open(paper) as pdf:
                    check(f"local PDF opens: {paper.name[:16]}",len(pdf)>0)
    for suite in ("test_regressions.py","test_document_semantics.py","test_model_adapters.py","test_release.py"):
        result=subprocess.run([sys.executable,str(ROOT/"scripts"/suite)],env=dict(os.environ,PYTHONIOENCODING="utf-8"))
        check(suite,result.returncode==0)
    print(f"\nRelease checks: {sum(results)} / {len(results)}",flush=True)
    return 0 if all(results) else 1

if __name__=="__main__":sys.exit(main())
