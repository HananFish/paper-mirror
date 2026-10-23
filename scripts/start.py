"""Start the personal reader using its virtual environment and one worker."""
import argparse
import os
from pathlib import Path
import secrets
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
PYTHON=ROOT/".venv"/("Scripts/python.exe" if os.name=="nt" else "bin/python")


def port(value):
    number=int(value)
    if not 1<=number<=65535: raise argparse.ArgumentTypeError("Port must be between 1 and 65535")
    return number


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port",type=port,default=8000)
    parser.add_argument("--lan",action="store_true",help="Bind all interfaces and require LAN pairing")
    args=parser.parse_args()
    if not PYTHON.exists() or not (ROOT/"frontend/dist/index.html").exists():
        parser.error("Run python scripts/setup.py before starting the reader.")
    env=dict(os.environ,APP_PORT=str(args.port),PYTHONIOENCODING="utf-8")
    if args.lan: env["APP_ACCESS_TOKEN"]=env.get("APP_ACCESS_TOKEN") or secrets.token_urlsafe(32)
    host="0.0.0.0" if args.lan else "127.0.0.1"
    print(f"Reader: http://127.0.0.1:{args.port}",flush=True)
    return subprocess.call([str(PYTHON),"-m","uvicorn","app.main:app","--host",host,"--port",str(args.port),"--workers","1"],cwd=ROOT/"backend",env=env)


if __name__=="__main__":
    try: sys.exit(main())
    except KeyboardInterrupt: sys.exit(130)
