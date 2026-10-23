"""Explicit PDF crops: embedded-text extraction and opt-in vision translation."""
import math
import os

import pymupdf
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import select

from ..db import get_session
from ..models import Document, Term
from ..settings_store import load_settings
from ..translators import get_provider
from ..ocr import recognize_png

router = APIRouter(prefix='/api/documents', tags=['regions'])


class Region(BaseModel):
    page_number: int = Field(ge=1)
    bbox: list[float] = Field(min_length=4, max_length=4)
    mode: Literal['text', 'extract', 'ocr', 'vision'] = 'text'
    text: str | None = Field(default=None, max_length=50000)


def crop(doc_id, region, session):
    doc = session.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, '文档不存在')
    with pymupdf.open(doc.file_path) as pdf:
        if region.page_number > len(pdf):
            raise HTTPException(400, '页码超出范围')
        page = pdf[region.page_number - 1]
        if not all(math.isfinite(v) for v in region.bbox):
            raise HTTPException(400, '区域坐标无效')
        rect = pymupdf.Rect(region.bbox) & page.rect
        if rect.is_empty or rect.width < 2 or rect.height < 2:
            raise HTTPException(400, '请框选有效区域')
        # Limit crop size while retaining small diagram labels.
        zoom = min(2.5, (4000000 / rect.get_area()) ** 0.5)
        png = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=rect, alpha=False).tobytes('png')
        text = page.get_text('text', clip=rect * page.derotation_matrix, sort=True).strip()
        return png, text


@router.get('/{doc_id}/region.png')
def region_image(doc_id: int, page_number: int, x0: float, y0: float, x1: float, y1: float, session=Depends(get_session)):
    png, _ = crop(doc_id, Region(page_number=page_number, bbox=[x0, y0, x1, y1]), session)
    return Response(png, media_type='image/png')


@router.post('/{doc_id}/region')
def region_action(doc_id: int, body: Region, session=Depends(get_session)):
    png, extracted = crop(doc_id, body, session)
    ocr_result = None
    if (not extracted and body.mode in {'extract', 'text'} and body.text is None) or body.mode == 'ocr':
        try:
            labels = recognize_png(png)
            ocr_result = {'text': '\n'.join(line['src'] for line in labels), 'lines': labels, 'engine': os.environ.get('OCR_ADAPTER', 'rapidocr')}
            if not extracted or body.mode == 'ocr':
                extracted = ocr_result['text']
        except (RuntimeError, ImportError, ValueError) as exc:
            # A visual model may still handle the image without local OCR.
            if body.mode == 'ocr':
                raise HTTPException(400, f'OCR 不可用，请检查模型适配器配置及依赖：{type(exc).__name__}')
    if body.mode in {'extract', 'ocr'}:
        return {'source': extracted, 'translation': '', 'ocr': ocr_result,
                'warning': ('未识别到文字，请调整裁剪范围、手动输入或选择视觉识别' if not extracted else
                            '部分文字识别不确定，请核对数字与公式' if ocr_result and any(line['confidence'] < 0.7 for line in ocr_result['lines']) else '')}
    settings = load_settings()
    glossary = [(t.source, t.target) for t in session.exec(select(Term)).all()]
    try:
        source = body.text if body.text is not None else extracted
        if body.mode == 'text':
            if not source.strip():
                raise HTTPException(400, '此区域没有可提取文本。请使用支持图片的视觉模型，或手动粘贴识别文本。')
            provider = get_provider(settings.get('provider', 'mock'), settings)
            result = provider.translate([source], glossary, '')[0]
        elif body.mode == 'vision':
            from ..model_adapters import create_adapter
            config = settings['vision']
            provider = create_adapter('vision', config.get('adapter', 'openai'), config, settings)
            result = provider.recognize(png, settings['target_lang'], glossary)
        else:
            raise HTTPException(400, '处理模式无效')
        if not isinstance(result, str) or not result.strip():
            raise HTTPException(502, '模型未返回有效译文')
        return {'source': source, 'translation': result}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, '区域翻译失败，请检查模型是否支持图片、服务配置及连接。' + type(exc).__name__) from exc
