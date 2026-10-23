"""解析质量快检：打印类型分布、字号与阅读顺序概览，用于人工核对。

用法：.venv/Scripts/python.exe scripts/parse_check.py [PDF路径]
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from app.parsing import parse_pdf_file  # noqa: E402


def main(path: str) -> None:
    # Windows PowerShell may expose a GBK stdout; force UTF-8 so PDF symbols
    # such as bullets, Greek letters and math operators do not crash the check.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    pages, blocks = parse_pdf_file(path)
    print(f"页数: {len(pages)}  总 block 数: {len(blocks)}")
    by_type: dict[str, int] = {}
    for b in blocks:
        by_type[b["block_type"]] = by_type.get(b["block_type"], 0) + 1
    print("类型分布:", by_type)

    print("\n全部块（阅读顺序）:")
    for b in blocks:
        text = b["text"][:58].replace("\n", " ")
        print(f"  p{b['page_number']} [{b['block_type']:9s}] {b['font_size']:4.1f}pt {text!r}")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else str(REPO / "data" / "sample_paper.pdf")
    main(target)
