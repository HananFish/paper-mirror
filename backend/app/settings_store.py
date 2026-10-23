"""非敏感设置的本地持久化（data/settings.json）。API 密钥只走环境变量，绝不入库入盘。"""
from __future__ import annotations

import json
import os
import tempfile
from copy import deepcopy
from threading import RLock
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import SETTINGS_PATH

class ServiceSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    adapter: str = Field(default="openai", pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    base_url: str = "https://api.openai.com/v1"
    model: str = Field(default="gpt-4o-mini", min_length=1, max_length=200)
    api_key_env: str = Field(default="TRANSLATION_API_KEY", pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    protocol: Literal["numbered", "simple"] = "numbered"

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value):
        from urllib.parse import urlsplit
        url = urlsplit(value)
        if url.scheme not in {"http", "https"} or not url.netloc or url.username or url.password or url.query or url.fragment:
            raise ValueError("Base URL 必须是无密钥、无查询参数的 HTTP(S) 地址")
        return value.rstrip("/")


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    provider: Literal["mock", "openai"] = "mock"
    batch_size: int = Field(default=8, ge=1, le=20)
    target_lang: str = Field(default="zh", min_length=2, max_length=40, pattern=r"^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff -]*$")
    auto_translate: bool = False
    openai: ServiceSettings = Field(default_factory=ServiceSettings)
    vision: ServiceSettings = Field(default_factory=lambda: ServiceSettings(
        base_url="http://127.0.0.1:11434/v1", model="qwen2.5vl:7b"))


DEFAULTS = Settings().model_dump()
_lock = RLock()


def _merge(current, patch):
    merged = deepcopy(current)
    for key, value in patch.items():
        merged[key] = {**merged[key], **value} if isinstance(value, dict) and isinstance(merged.get(key), dict) else value
    return Settings.model_validate(merged).model_dump()


def load_settings() -> dict:
    with _lock:
        if not SETTINGS_PATH.exists():
            return deepcopy(DEFAULTS)
        try:
            return _merge(DEFAULTS, json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
        except (ValueError, TypeError, AttributeError) as exc:
            import logging
            logging.getLogger(__name__).warning("设置文件无效，暂用默认设置: %s", type(exc).__name__)
            return deepcopy(DEFAULTS)


def save_settings(patch: dict) -> dict:
    with _lock:
        current = _merge(load_settings(), patch)
        fd, path = tempfile.mkstemp(prefix="settings-", suffix=".tmp", dir=SETTINGS_PATH.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(current, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.replace(path, SETTINGS_PATH)
        finally:
            if os.path.exists(path):
                os.unlink(path)
        return current
