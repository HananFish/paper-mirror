"""Local-only by default; explicit token pairing for LAN sessions."""
import hmac
import ipaddress
import os
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse, RedirectResponse


def local_client(request):
    try:
        return ipaddress.ip_address(request.client.host).is_loopback
    except (ValueError, AttributeError):
        return False


async def access_guard(request, call_next):
    host = request.url.hostname
    if host != "localhost":
        try:
            ipaddress.ip_address(host or "")
        except ValueError:
            # 隧道/域名访问（如 Cloudflare Tunnel）需在 APP_TRUSTED_HOSTS 中显式列出；
            # 以 . 开头的条目按后缀通配（如 ".trycloudflare.com" 放行全部临时隧道地址）
            trusted = {h.strip().lower() for h in os.environ.get("APP_TRUSTED_HOSTS", "").split(",") if h.strip()}
            host_l = (host or "").lower()
            if host_l not in trusted and not any(host_l.endswith(t) for t in trusted if t.startswith(".")):
                return JSONResponse({"detail": "请使用本机或局域网 IP 地址访问"}, status_code=403)
    origin = request.headers.get("origin")
    if request.url.path.startswith("/api") and origin:
        same_origin = urlsplit(origin).netloc == request.headers.get("host")
        dev_origin = origin in {"http://localhost:5173", "http://127.0.0.1:5173"} and local_client(request)
        if not same_origin and not dev_origin:
            return JSONResponse({"detail": "不允许此网页访问本地文献"}, status_code=403)
    token = os.environ.get("APP_ACCESS_TOKEN", "")
    supplied = request.query_params.get("token", "")
    if request.url.path == "/" and supplied and token and hmac.compare_digest(supplied, token):
        response = RedirectResponse("/", status_code=303)
        response.set_cookie("reader_access", token, httponly=True, samesite="strict")
        response.headers["Referrer-Policy"] = "no-referrer"
        return response
    if request.url.path.startswith("/api") and not local_client(request):
        credential = request.headers.get("authorization", "").removeprefix("Bearer ") or request.cookies.get("reader_access", "")
        if not token or not hmac.compare_digest(credential, token):
            return JSONResponse({"detail": "请使用启动时显示的局域网配对链接"}, status_code=401)
    response = await call_next(request)
    response.headers["Referrer-Policy"] = "no-referrer"
    return response
