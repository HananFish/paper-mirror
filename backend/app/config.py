"""路径与基础配置。所有可写数据集中在 <仓库>/data 目录。"""
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    """极简 .env 加载：读取仓库根目录 .env（存在才生效），不覆盖已有环境变量。"""
    env_file = REPO_ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

DATA_DIR = Path(os.environ.get("APP_DATA_DIR", str(REPO_ROOT / "data"))).resolve()
DB_PATH = DATA_DIR / "app.db"
DOCS_DIR = DATA_DIR / "documents"
SETTINGS_PATH = DATA_DIR / "settings.json"
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DIR.mkdir(parents=True, exist_ok=True)
