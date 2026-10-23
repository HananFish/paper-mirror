"""Default vision transport, separated from region geometry and UI actions."""
import base64

from .httputil import post as http_post


class OpenAICompatibleVision:
    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url, self.api_key, self.model = base_url.rstrip('/'), api_key, model

    def recognize(self, png: bytes, target_lang: str, glossary: list[tuple[str, str]]) -> str:
        prompt = (f'逐项识别并翻译图片中的文字为{target_lang}，以「原文 → 译文」输出；'
                  '表格请用 Markdown 表格保持行列关系，数字、单位和公式不变。'
                  '只翻译看得清的内容，无法辨认写[无法辨认]，禁止补全或推测。'
                  f'术语表：{glossary}')
        response = http_post(f'{self.base_url}/chat/completions',
            headers={'Authorization': f'Bearer {self.api_key}'},
            json={'model': self.model, 'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': prompt},
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(png).decode()}}
            ]}], 'temperature': 0.1}, timeout=120)
        response.raise_for_status()
        choice = response.json()['choices'][0]
        content = choice['message']['content']
        if choice.get('finish_reason') in {'length', 'content_filter'} or not isinstance(content, str) or not content.strip():
            raise ValueError('视觉结果为空、被截断或过滤，请缩小裁剪范围后重试')
        return content
