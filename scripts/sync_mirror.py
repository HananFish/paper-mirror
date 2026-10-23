"""Pull tablet annotations from the mirror site and merge them locally.

从镜像站（Cloudflare Pages Functions + KV，见 docs/MIRROR.md）拉取平板自动
推送的批注/笔记，走与「导入平板批注」相同的指纹去重合并，直接写入本机
文献库。

用法（项目根目录）:
    python scripts/sync_mirror.py               # 拉取全部文献
    python scripts/sync_mirror.py --doc 1       # 只处理某一篇
    python scripts/sync_mirror.py --purge       # 合并后清除云端包

地址与密钥默认读 .env 的 MIRROR_SYNC_URL / MIRROR_SYNC_SECRET，
也可用 --url / --secret 覆盖。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv"
VENV_PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
if VENV_PYTHON.exists() and Path(sys.prefix).resolve() != VENV.resolve():
    sys.exit(subprocess.call(
        [str(VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]],
        env=dict(os.environ, PYTHONIOENCODING="utf-8"),
    ))

sys.path.insert(0, str(ROOT / "backend"))

from app.config import _load_dotenv  # noqa: E402

_load_dotenv()


def request_json(url: str, secret: str, method: str = "GET", payload: dict | None = None) -> dict:
    request = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={
            "authorization": f"Bearer {secret}",
            "content-type": "application/json",
            # Cloudflare 对 workers.dev 有机器人签名拦截，默认 Python-urllib UA 会被 1010 拒绝
            "user-agent": "paper-mirror-sync/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise SystemExit(f"云端返回 HTTP {exc.code}：{detail}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"无法连接同步服务 {url}：{exc.reason}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=os.environ.get("MIRROR_SYNC_URL", "").strip())
    parser.add_argument("--secret", default=os.environ.get("MIRROR_SYNC_SECRET", "").strip())
    parser.add_argument("--doc", type=int, action="append", help="只处理指定文献 id（可重复）")
    parser.add_argument("--purge", action="store_true", help="合并成功后删除云端包")
    args = parser.parse_args()
    if not args.url or not args.secret:
        print("缺少 MIRROR_SYNC_URL / MIRROR_SYNC_SECRET（写入 .env 或用 --url/--secret 传入）", file=sys.stderr)
        return 2
    base = args.url.rstrip("/")

    from sqlmodel import Session

    from app.db import engine, init_db
    from app.routers.documents import import_mirror_bundle

    listing = request_json(f"{base}/sync", args.secret)
    docs = listing.get("docs", [])
    if args.doc:
        wanted = set(args.doc)
        docs = [d for d in docs if d.get("document_id") in wanted]
    if not docs:
        print("云端没有待拉取的批注包。")
        return 0

    init_db()
    total_added = total_skipped = total_failed = 0
    with Session(engine) as session:
        for entry in docs:
            doc_id = entry["document_id"]
            try:
                bundle = request_json(f"{base}/sync/{doc_id}", args.secret)
                result = import_mirror_bundle(doc_id, bundle, session)
            except SystemExit:
                raise
            except Exception as exc:  # noqa: BLE001
                session.rollback()
                total_failed += 1
                print(f"  ! 文献 {doc_id} 合并失败，已跳过：{exc}", file=sys.stderr)
                continue
            total_added += result["added_annotations"] + result["added_notes"]
            total_skipped += result["skipped_annotations"] + result["skipped_notes"]
            print(
                f"  + 文献 {doc_id} {entry.get('filename') or ''}：批注 +{result['added_annotations']}"
                f" 笔记 +{result['added_notes']}（跳过重复 {result['skipped_annotations'] + result['skipped_notes']}）"
                f" · 云端推送于 {entry.get('pushed_at') or '?'}"
            )
            if args.purge:
                request_json(f"{base}/sync/{doc_id}", args.secret, method="DELETE")
                print(f"    已清除云端包 {doc_id}")
    print(f"\n完成：新增 {total_added} 条，跳过重复 {total_skipped} 条" + (f"，失败 {total_failed} 篇" if total_failed else "") + "。")
    return 1 if total_failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
