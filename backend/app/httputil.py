"""HTTP 便捷封装：本机回环地址不走环境代理。

启动终端里残留的 HTTP_PROXY/ALL_PROXY 会把 127.0.0.1 的请求送进代理；
若代理再转发到远程节点，远程节点连自己的回环必然失败并返回 502。
本地模型服务（Ollama 等）必须始终直连。
"""
from urllib.parse import urlparse

import httpx


def post(url: str, **kwargs):
    return httpx.post(url, trust_env=not _is_loopback(url), **kwargs)


def _is_loopback(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in {"127.0.0.1", "::1", "localhost"} or host.endswith(".localhost")
