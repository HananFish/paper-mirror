"""翻译服务适配层：统一 TranslationProvider 接口 + OpenAI 兼容 / Mock 两个实现。"""
from __future__ import annotations

import hashlib
import json
import re
import time
from .model_adapters import TextModel as TranslationProvider

from .httputil import post as http_post

PROMPT_VERSION = "v2"
SEG_RE = re.compile(r"<<<\s*(\d+)\s*>>>", re.MULTILINE)


class BatchParseError(Exception):
    """模型输出无法按编号拆回原文片段数。"""


def cache_key(provider_name: str, model: str, text: str, identity=None) -> str:
    h = hashlib.sha256()
    h.update(PROMPT_VERSION.encode())
    h.update(provider_name.encode())
    h.update(model.encode())
    h.update(text.encode("utf-8"))
    h.update(json.dumps(identity or {}, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return h.hexdigest()


class MockProvider:
    """离线占位实现：不联网、不计费，用于开发与端到端测试。"""

    name = "mock"
    model = "mock-1"

    def translate(self, texts: list[str], glossary: list[tuple[str, str]], context: str) -> list[str]:
        time.sleep(0.05)
        out = []
        for t in texts:
            translated = t
            for src, dst in glossary:
                translated = translated.replace(src, dst)
            out.append("【Mock译】" + translated)
        return out


class OpenAICompatibleProvider:
    """任意 OpenAI /chat/completions 兼容服务（OpenAI、DeepSeek、Qwen、Ollama 等）。

    protocol="numbered"：编号批量协议，适合通用大模型（一次请求翻译一批，省 token）。
    protocol="simple"：单段极简提示词，适合翻译特化模型（如 Hunyuan Hy-MT2）——
    它们不遵守编号协议，复杂指令反而跑偏。
    """

    def __init__(self, base_url: str, api_key: str, model: str, protocol: str = "numbered", target_lang: str = "zh"):
        self.name = "openai"
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.protocol = protocol if protocol in ("numbered", "simple") else "numbered"
        self.target_lang = "Simplified Chinese" if target_lang == "zh" else target_lang

    def translate(self, texts: list[str], glossary: list[tuple[str, str]], context: str) -> list[str | None]:
        if self.protocol == "simple":
            out = []
            for text in texts:
                try:
                    out.append(self._translate_simple(text, glossary, context))
                except Exception as exc:
                    self.last_error = f"{type(exc).__name__}: {exc}"[:500]
                    out.append(None)
            return out
        content = self._request(texts, glossary, context)
        try:
            return list(_split_numbered(content, len(texts)))
        except BatchParseError:
            if len(texts) == 1:
                # 单片段时不再强求编号，直接取全部输出
                cleaned = re.sub(r"<<<\s*\d+\s*>>>?", "", content).strip()
                if not cleaned:
                    raise BatchParseError("empty translation")
                return [cleaned]
            raise

    def _translate_simple(self, text: str, glossary: list[tuple[str, str]], context: str = "") -> str:
        system = (
            "You are a professional academic translator. Translate the user content "
            f"into {self.target_lang}. Keep formulas, LaTeX, code, citations like [12], "
            "and URLs unchanged. Output the translation only."
        )
        if glossary:
            terms = "; ".join(f"{s} → {t}" for s, t in glossary)
            system += f"\nGlossary (must follow): {terms}"
        if context:
            system += f"\nContext for understanding only; do not translate or output it: {context[-600:]}"
        return self._chat(system, text)

    def _request(self, texts: list[str], glossary: list[tuple[str, str]], context: str) -> str:
        glossary_lines = "\n".join(f"{s} = {t}" for s, t in glossary) or "（无）"
        context_block = (
            f"以下是上文，仅供理解，不要翻译、不要输出：\n…{context[-400:]}\n\n" if context else ""
        )
        numbered = "\n".join(f"<<<{i}>>>\n{t}" for i, t in enumerate(texts))
        user = (
            f"术语表（必须遵守）：\n{glossary_lines}\n\n"
            f"{context_block}"
            f"请翻译以下 {len(texts)} 个片段：\n\n{numbered}"
        )
        return self._chat(SYSTEM_PROMPT.replace("简体中文", self.target_lang), user)

    def _chat(self, system: str, user: str) -> str:
        payload = {"model": self.model, "temperature": 0.2, "messages": [
            {"role": "system", "content": system}, {"role": "user", "content": user}]}
        for attempt in range(3):
            try:
                resp = http_post(f"{self.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"}, json=payload, timeout=120)
            except httpx.TransportError:
                if attempt == 2:
                    raise
                time.sleep(0.5 * 2 ** attempt)
                continue
            if resp.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                break
            time.sleep(0.5 * 2 ** attempt)
        resp.raise_for_status()
        choice = resp.json()["choices"][0]
        content = choice["message"]["content"]
        if choice.get("finish_reason") in {"length", "content_filter"} or not isinstance(content, str) or not content.strip():
            raise ValueError("模型返回空结果、被截断或被过滤")
        return content


SYSTEM_PROMPT = """你是学术文献翻译引擎，把论文片段准确翻译成简体中文。规则：
1. 只输出译文，不要任何解释、前言或总结。
2. 公式、LaTeX、数学符号、变量名、代码、文件名、URL、邮箱保持原样，不要翻译。
3. 引用编号（如 [12]、(Smith et al., 2020)）原样保留。
4. 术语表中的译法必须遵守。
5. 没把握的专有名词在译文后标注「[需确认]」；不要虚构原文中不存在的内容。
6. 不要合并或拆分片段，逐段翻译。
输出格式：每个片段前单独一行编号标记，形如：
<<<0>>>
片段0的译文
<<<1>>>
片段1的译文"""


def _split_numbered(content: str, n: int) -> list[str]:
    parts = SEG_RE.split(content)
    found: dict[int, str] = {}
    for i in range(1, len(parts) - 1, 2):
        idx = int(parts[i])
        if idx in found or not parts[i + 1].strip():
            raise BatchParseError("duplicate number or empty segment")
        found[idx] = parts[i + 1].strip()
    if set(found.keys()) != set(range(n)):
        raise BatchParseError(f"expected {n} segments, got {sorted(found.keys())}")
    return [found[i] for i in range(n)]


def get_provider(name: str, settings: dict) -> TranslationProvider:
    if name == "mock":
        return MockProvider()
    if name == "openai":
        from .model_adapters import create_adapter
        cfg = settings.get("openai", {})
        return create_adapter('text', cfg.get('adapter', 'openai'), cfg, settings)
    raise ValueError(f"未知翻译服务商: {name}")
