"""Publish translated documents as a static mirror site (镜像站).

在电脑端把「文献 + 译文 + 批注 + PDF + 批注烘焙版 PDF」导出为纯静态站点，
部署到 Cloudflare Pages / GitHub Pages 等任意静态托管后，平板即可脱离电脑
阅读与批注；批注存平板浏览器本地，可在阅读器「导出 → 平板批注备份」导出
JSON，再在家中电脑的文献页用「导入平板批注」合并。

用法（项目根目录）:
    python scripts/publish_site.py                 # 全部就绪文献 → site/
    python scripts/publish_site.py --doc 1 --doc 2  # 指定文献
    python scripts/publish_site.py --out mysite    # 指定输出目录

产物结构:
    <out>/                      frontend/dist 构建副本（站点根）
    <out>/data/library.json     文献清单 + published_at 版本号
    <out>/data/doc-{id}.json    文档信息、块与译文、批注、笔记
    <out>/data/{id}.pdf         原始 PDF
    <out>/data/{id}-annotated.pdf  烘焙的高亮批注版 PDF

发布清单与文档包里会去掉本机绝对路径（file_path），避免公开站点泄露
用户名与目录结构；只保留浏览器真正需要的字段。

部署示例:
    npx wrangler pages deploy site --branch main --commit-dirty=true
注意: 站点是公开 URL，论文与笔记任何人可得；个人使用建议在 Cloudflare
Zero Trust 里给它加一层邮箱验证（免费）。完整步骤见 docs/MIRROR.md。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv"
VENV_PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
# 直接用系统 Python 运行时自动切换到项目虚拟环境，避免 ModuleNotFoundError
if VENV_PYTHON.exists() and Path(sys.prefix).resolve() != VENV.resolve():
    sys.exit(subprocess.call(
        [str(VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]],
        env=dict(os.environ, PYTHONIOENCODING="utf-8"),
    ))

sys.path.insert(0, str(ROOT / "backend"))

from fastapi.encoders import jsonable_encoder  # noqa: E402
from sqlmodel import Session  # noqa: E402

from app.db import engine, init_db  # noqa: E402
from app.models import Document  # noqa: E402
from app.routers.documents import (  # noqa: E402
    annotated_pdf_bytes,
    get_blocks,
    get_document,
    list_annotations,
    list_documents,
    list_notes,
)


def public_document(document: dict) -> dict:
    """投影成可公开的文献记录：去掉本机路径，错误信息不随站点发布。"""
    return {key: value for key, value in document.items() if key not in {"file_path", "error"}} | {
        "error": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="site", help="输出目录（默认 site/）")
    parser.add_argument("--doc", type=int, action="append", help="只发布指定文献 id（可重复）")
    parser.add_argument("--skip-annotated", action="store_true", help="不烘焙批注版 PDF")
    args = parser.parse_args()

    dist = ROOT / "frontend" / "dist"
    if not (dist / "index.html").is_file():
        print("frontend/dist 不存在：先在 frontend/ 下运行 npm run build", file=sys.stderr)
        return 2

    init_db()
    out = (ROOT / args.out).resolve()
    # 发布脚本会先清空输出目录；拒绝仓库根、数据目录及其父目录，避免误删
    protected = {ROOT, ROOT / "data", ROOT / "backend", ROOT / "frontend", ROOT / "docs"}
    if out in protected or out in ROOT.parents:
        print(f"拒绝使用不安全的输出目录：{out}", file=sys.stderr)
        return 2
    data_dir = out / "data"
    shutil.rmtree(out, ignore_errors=True)
    data_dir.mkdir(parents=True)
    shutil.copytree(dist, out, dirs_exist_ok=True)

    published = 0
    with Session(engine) as session:
        docs = [public_document(entry) for entry in jsonable_encoder(list_documents(session))]
        wanted = set(args.doc) if args.doc else {d["id"] for d in docs if d["status"] == "ready"}
        manifest = {
            "published_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "documents": [],
        }
        for entry in docs:
            doc_id = entry["id"]
            if doc_id not in wanted:
                continue
            record = session.get(Document, doc_id)
            source = Path(record.file_path)
            if not source.is_file():
                print(f"  ! 文献 {doc_id} 源 PDF 不存在，已跳过：{source}")
                continue
            document = public_document(jsonable_encoder(get_document(doc_id, session)))
            bundle = {
                "document": document,
                "blocks": jsonable_encoder(get_blocks(doc_id, session)),
                "annotations": jsonable_encoder(list_annotations(doc_id, session)),
                "notes": jsonable_encoder(list_notes(doc_id, session)),
            }
            (data_dir / f"doc-{doc_id}.json").write_text(
                json.dumps(bundle, ensure_ascii=False), encoding="utf-8"
            )
            shutil.copy(source, data_dir / f"{doc_id}.pdf")
            has_annotated = False
            if not args.skip_annotated:
                try:
                    (data_dir / f"{doc_id}-annotated.pdf").write_bytes(
                        annotated_pdf_bytes(doc_id, session)
                    )
                    has_annotated = True
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! 文献 {doc_id} 批注 PDF 烘焙失败：{exc}")
            manifest["documents"].append({**document, "has_annotated_pdf": has_annotated})
            published += 1
            print(f"  + 文献 {doc_id} {document['filename']}（{len(bundle['blocks'])} 块）")

    (data_dir / "library.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    # 自动同步配置（.env 中配置了 MIRROR_SYNC_URL/SECRET 才烘焙；平板据此自动推送批注）
    sync_url = os.environ.get("MIRROR_SYNC_URL", "").strip()
    sync_secret = os.environ.get("MIRROR_SYNC_SECRET", "").strip()
    if sync_url and sync_secret:
        (data_dir / "sync.json").write_text(
            json.dumps({"url": sync_url.rstrip("/"), "secret": sync_secret}),
            encoding="utf-8",
        )
        print("  + 已写入自动同步配置 data/sync.json（密钥随站点公开，见 docs/MIRROR.md）")
    size_mb = sum(p.stat().st_size for p in out.rglob("*") if p.is_file()) / 1e6
    print(f"\n已发布 {published} 篇文献 → {out}（{size_mb:.1f} MB）")
    print("部署：npx wrangler pages deploy %s --branch main --commit-dirty=true" % args.out)
    print("提醒：站点为公开 URL，个人使用建议加 Cloudflare Access 邮箱验证。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
