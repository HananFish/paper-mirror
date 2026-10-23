"""Trusted, process-local model extension points; no imports supplied by clients."""
from __future__ import annotations

import os
import re
from threading import RLock
from typing import Callable, Literal, Protocol, TypedDict

Kind = Literal['text', 'vision', 'ocr', 'layout']


class TextModel(Protocol):
    name: str
    model: str
    def translate(self, texts: list[str], glossary: list[tuple[str, str]], context: str) -> list[str | None]: ...


class VisionModel(Protocol):
    def recognize(self, png: bytes, target_lang: str, glossary: list[tuple[str, str]]) -> str: ...


class OCRLine(TypedDict):
    quad: list[list[float]]
    src: str
    confidence: float


class OCRModel(Protocol):
    def __call__(self, png: bytes) -> list[OCRLine]: ...


class LayoutRegion(TypedDict):
    name: str
    bbox: list[float]
    conf: float


class LayoutModel(Protocol):
    def __call__(self, page, dpi: int) -> list[LayoutRegion] | None: ...


_lock = RLock()
_adapters: dict[str, dict[str, Callable]] = {kind: {} for kind in ('text', 'vision', 'ocr', 'layout')}
_initialized = False


def register_adapter(kind: Kind, name: str, factory: Callable) -> None:
    """Factories receive non-secret service config and the current settings.

    Register once in custom_adapters.register(). Load heavy dependencies inside
    the factory/inference function, never at application import time.
    """
    if kind not in _adapters or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', name) or not callable(factory):
        raise ValueError('Invalid model adapter registration')
    with _lock:
        if name in _adapters[kind]:
            raise ValueError(f'Duplicate {kind} adapter: {name}')
        _adapters[kind][name] = factory


def api_key(config: dict) -> str:
    variable = config.get('api_key_env', 'TRANSLATION_API_KEY')
    value = os.environ.get(variable, '')
    if not value:
        raise ValueError(f'未设置 API 密钥环境变量 {variable}，请在本机 .env 中配置并重启')
    return value


def _text(config, settings):
    from .translators import OpenAICompatibleProvider
    return OpenAICompatibleProvider(config['base_url'], api_key(config), config['model'],
                                    config.get('protocol', 'numbered'), settings.get('target_lang', 'zh'))


def _vision(config, settings):
    from .vision import OpenAICompatibleVision
    return OpenAICompatibleVision(config['base_url'], api_key(config), config['model'])


def _ocr(config, settings):
    from .ocr import _recognize_rapidocr_png
    return _recognize_rapidocr_png


def _layout(config, settings):
    from .layout_yolo import _detect_doclayout
    return _detect_doclayout


for _kind, _name, _factory in [('text', 'openai', _text), ('vision', 'openai', _vision),
                              ('ocr', 'rapidocr', _ocr), ('layout', 'doclayout', _layout)]:
    register_adapter(_kind, _name, _factory)


def initialize_adapters() -> None:
    global _initialized
    with _lock:
        if not _initialized:
            from .custom_adapters import register
            register()
            _initialized = True


def create_adapter(kind: Kind, name: str, config: dict, settings: dict):
    initialize_adapters()
    with _lock:
        factory = _adapters.get(kind, {}).get(name)
    if factory is None:
        raise ValueError(f'未注册 {kind} 模型适配器：{name}')
    return factory(dict(config), dict(settings))


def adapter_catalog() -> dict[str, list[str]]:
    initialize_adapters()
    with _lock:
        return {kind: sorted(entries) for kind, entries in _adapters.items()}
