"""Explicitly download official DocLayout-YOLO weights; never runs during parsing."""
import argparse
import hashlib
from pathlib import Path
import shutil
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend"))


def main():
    from app.layout_yolo import WEIGHTS_PATH
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only",action="store_true")
    args=parser.parse_args()
    if WEIGHTS_PATH.exists():
        digest=hashlib.sha256(WEIGHTS_PATH.read_bytes()).hexdigest()
        print(f"Layout weights already present ({WEIGHTS_PATH.stat().st_size} bytes, SHA256 {digest}).")
        return
    if args.check_only:
        print("Optional layout weights missing; the reader uses heuristics.");return
    from huggingface_hub import hf_hub_download
    path=hf_hub_download(repo_id="juliozhao/DocLayout-YOLO-DocStructBench",filename=WEIGHTS_PATH.name)
    WEIGHTS_PATH.parent.mkdir(parents=True,exist_ok=True)
    temporary=WEIGHTS_PATH.with_suffix(".download")
    try:
        shutil.copyfile(path,temporary)
        temporary.replace(WEIGHTS_PATH)
    finally: temporary.unlink(missing_ok=True)
    print("Layout weights installed. Restart the reader to enable detection.")


if __name__=="__main__":main()
