"""Local preview server for the published mirror site (镜像站本地预览).

用法: .venv\\Scripts\\python scripts/serve_site.py [--dir site] [--port 8010]
在浏览器打开 http://127.0.0.1:<port>/ 检查发布产物，再部署到静态托管。
"""
import argparse
import mimetypes
import os
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", default="site")
    parser.add_argument("--port", type=int, default=8010)
    args = parser.parse_args()

    # Windows 注册表常缺 .mjs 映射，会导致 ES module worker 被拒载
    mimetypes.add_type("text/javascript", ".mjs")
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("application/json", ".json")
    mimetypes.add_type("application/pdf", ".pdf")

    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", args.dir)
    handler = partial(SimpleHTTPRequestHandler, directory=os.path.abspath(root))
    print(f"镜像站预览: http://127.0.0.1:{args.port}/  （目录 {os.path.abspath(root)}）")
    HTTPServer(("127.0.0.1", args.port), handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
