"""The original defect probes are now assertions in the offline regression suite.
Historical pre-fix output is preserved in probe-results.txt.
"""
import subprocess
import sys
from pathlib import Path
script = Path(__file__).resolve().parents[1] / "scripts" / "test_regressions.py"
sys.exit(subprocess.call([sys.executable, str(script)]))
