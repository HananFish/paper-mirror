from contextlib import asynccontextmanager

import mimetypes

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import FRONTEND_DIST
from .db import init_db
from .routers import documents, misc, regions
from .security import access_guard

# Windows 注册表常缺 .mjs 映射，导致 ES module worker 被按 octet-stream 拒载
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")


def _lan_ip() -> str:
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _lan_ips() -> list[str]:
    import socket

    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return [_lan_ip()]
    seen: list[str] = []
    for info in infos:
        ip = info[4][0]
        if not ip.startswith("127.") and ip not in seen:
            seen.append(ip)
    return seen or [_lan_ip()]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from .model_adapters import initialize_adapters
    initialize_adapters()
    init_db()
    from .mirror_sync import start_mirror_sync_loop
    if start_mirror_sync_loop():
        print("  平板批注自动拉取：已启用（每 60 秒）", flush=True)
    import os
    port = os.environ.get("APP_PORT", "8000")
    print(f"  本机访问:   http://127.0.0.1:{port}", flush=True)
    token = os.environ.get("APP_ACCESS_TOKEN", "")
    if token:
        for ip in _lan_ips():
            print(f"  局域网配对: http://{ip}:{port}/?token={token}", flush=True)
    yield


app = FastAPI(title="paper-mirror · 译镜", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(access_guard)
app.include_router(misc.router)
app.include_router(documents.router)
app.include_router(regions.router)

# index.html 禁止缓存：前端重新构建后浏览器立即拿到新入口（资源文件名带哈希可长缓存）
from fastapi.responses import FileResponse  # noqa: E402


@app.get("/", include_in_schema=False)
def index_no_cache():
    if not (FRONTEND_DIST / "index.html").is_file():
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail":"前端尚未构建，请在项目根目录运行 python scripts/setup.py"},status_code=503)
    return FileResponse(
        FRONTEND_DIST / "index.html",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


# 前端构建产物存在时由后端单进程托管（生产模式）
if (FRONTEND_DIST / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
