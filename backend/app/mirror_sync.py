"""后台自动拉取平板镜像站的批注合并进本机文献库。

配置了 MIRROR_SYNC_URL + MIRROR_SYNC_SECRET 才会启用；测试与隔离数据目录
（显式设置 APP_DATA_DIR）一律禁用，避免测试访问网络。
"""
import json
import os
import threading
import urllib.error
import urllib.request

_INTERVAL_SECONDS = 60
_USER_AGENT = "paper-mirror-sync/1.0"


def _request_json(url: str, secret: str, method: str = "GET", payload: dict | None = None) -> dict:
    request = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={
            "authorization": f"Bearer {secret}",
            "content-type": "application/json",
            "user-agent": _USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def pull_once() -> str:
    """拉取一次并合并；未配置同步或云端为空时返回空串，否则返回摘要。"""
    base = (os.environ.get("MIRROR_SYNC_URL") or "").strip().rstrip("/")
    secret = (os.environ.get("MIRROR_SYNC_SECRET") or "").strip()
    if not base or not secret:
        return ""
    docs = _request_json(f"{base}/sync", secret).get("docs", [])
    if not docs:
        return ""
    from sqlmodel import Session

    from .db import engine
    from .routers.documents import import_mirror_bundle

    added = skipped = failed = 0
    with Session(engine) as session:
        for entry in docs:
            try:
                bundle = _request_json(f"{base}/sync/{entry['document_id']}", secret)
                result = import_mirror_bundle(entry["document_id"], bundle, session)
            except Exception as exc:  # noqa: BLE001
                # 云端可能有本机已删除的文献，或单篇数据损坏；不影响其余文献
                session.rollback()
                failed += 1
                print(f"  平板批注同步跳过文献 {entry.get('document_id')}：{exc}", flush=True)
                continue
            added += result["added_annotations"] + result["added_notes"]
            skipped += result["skipped_annotations"] + result["skipped_notes"]
    return f"平板批注自动同步：新增 {added} 条，跳过重复 {skipped} 条" + (f"，失败 {failed} 篇" if failed else "")


def start_mirror_sync_loop() -> bool:
    """在后台线程每分钟拉取一次；返回是否启用（仅用于启动日志）。"""
    configured = bool(
        (os.environ.get("MIRROR_SYNC_URL") or "").strip()
        and (os.environ.get("MIRROR_SYNC_SECRET") or "").strip()
    )
    # 显式 APP_DATA_DIR = 测试或隔离环境，绝不访问网络
    if not configured or os.environ.get("APP_DATA_DIR"):
        if configured:
            print("  平板批注自动拉取：已跳过（APP_DATA_DIR 隔离模式，可手动运行 scripts/sync_mirror.py）", flush=True)
        return False

    def loop() -> None:
        import time

        last_error = ""
        while True:
            try:
                summary = pull_once()
                if summary and f"新增 0 " not in summary:
                    print(f"  {summary}", flush=True)
                last_error = ""
            except Exception as exc:  # noqa: BLE001
                message = str(exc)
                if message != last_error:
                    print(f"  平板批注自动拉取失败：{message}", flush=True)
                    last_error = message
            time.sleep(_INTERVAL_SECONDS)

    threading.Thread(target=loop, name="mirror-sync", daemon=True).start()
    return True
