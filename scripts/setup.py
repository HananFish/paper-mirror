"""Portable setup entry point for people and installation agents."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(command, cwd=ROOT):
    subprocess.run([str(part) for part in command], cwd=cwd, check=True)


def prerequisites():
    if sys.version_info < (3,11): raise RuntimeError("Python 3.11 or newer is required.")
    node, npm = shutil.which("node"), shutil.which("npm.cmd" if os.name=="nt" else "npm")
    if not node or not npm: raise RuntimeError("Install Node.js 22.12+ (including npm) and reopen the terminal.")
    version = subprocess.check_output([node,"--version"],text=True).strip()
    major, minor = map(int,version.lstrip("v").split(".")[:2])
    if major < 22 or major == 22 and minor < 12: raise RuntimeError("Node.js 22.12+ is required.")
    print(f"Python {sys.version.split()[0]}, Node {version}, npm found.")
    return npm


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only",action="store_true",help="Check prerequisites without installing or downloading anything")
    parser.add_argument("--with-layout",action="store_true",help="Also install optional DocLayout-YOLO and its official weights")
    args=parser.parse_args()
    npm=prerequisites()
    if args.check_only: return
    if not PYTHON.exists(): run([sys.executable,"-m","venv",ROOT/".venv"])
    print("[1/3] Install backend dependencies")
    run([PYTHON,"-m","pip","install","-r",ROOT/"backend/requirements.txt"])
    print("[2/3] Install locked frontend dependencies and build")
    run([npm,"ci","--no-audit","--no-fund"],ROOT/"frontend")
    run([npm,"run","build"],ROOT/"frontend")
    print("[3/3] Generate the local practice PDF")
    run([PYTHON,ROOT/"scripts/make_user_guide.py",ROOT/"data/sample_paper.pdf"])
    if args.with_layout:
        run([PYTHON,"-m","pip","install","-r",ROOT/"backend/requirements-layout.txt"])
        run([PYTHON,ROOT/"scripts/install_layout.py"])
    print("Ready. Run: python scripts/start.py")


if __name__=="__main__":
    try: main()
    except (RuntimeError,subprocess.CalledProcessError,OSError) as exc:
        print(f"Setup failed: {exc}",file=sys.stderr);sys.exit(1)
