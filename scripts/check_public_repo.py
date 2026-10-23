"""Check working files and available Git history without printing secret values."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = re.compile(r'(^|/)(?:data|\.venv|node_modules|frontend/dist)/|(^|/)\.env(?:$|\.(?!example$))|\.(?:db|sqlite|sqlite3|pem|key|pt|onnx)$', re.I)
SECRET = re.compile(rb'(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def main():
    files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode().split('\0')
    failures = set()
    for name in filter(None, files):
        if PRIVATE.search(name): failures.add(('private working path', name))
        path = ROOT / name
        if path.is_file() and SECRET.search(path.read_bytes()): failures.add(('credential pattern', name))
    seen = set()
    for row in git('rev-list', '--objects', '--all').decode().splitlines():
        parts = row.split(' ', 1)
        if len(parts) < 2: continue
        oid, name = parts
        if PRIVATE.search(name): failures.add(('private history path', name))
        if oid in seen: continue
        seen.add(oid)
        if git('cat-file', '-t', oid).strip() == b'blob' and SECRET.search(git('cat-file', 'blob', oid)):
            failures.add(('history credential pattern', name))
    for kind, name in sorted(failures): print(f'FAIL {kind}: {name}')
    print(f'Public repository check: {len(seen)} history objects; {len(failures)} findings')
    print('Scope: known file/credential patterns in working files and locally available Git history.')
    return int(bool(failures))


if __name__ == '__main__': raise SystemExit(main())
