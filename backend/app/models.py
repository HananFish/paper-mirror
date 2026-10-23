from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# 文档状态: uploaded -> parsing -> ready / parse_failed；翻译时临时为 translating
DOC_STATUSES = {"uploaded", "parsing", "ready", "parse_failed", "translating", "deleting"}
# 可翻译的 block 类型（其余类型在右栏显示为占位卡片）
TRANSLATABLE_TYPES = {"paragraph", "heading", "list", "caption"}
BLOCK_TYPES = {"paragraph", "heading", "list", "caption", "reference", "table", "formula", "image"}


class Document(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    filename: str
    sha256: str = Field(index=True)
    file_path: str
    page_count: int = 0
    last_page: int = 1  # 阅读位置记忆：最近阅读到的页码
    language: str = "en"
    status: str = "uploaded"
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Page(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="document.id", index=True)
    page_number: int  # 1-based
    width: float
    height: float
    raw_text: str = ""


class Block(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="document.id", index=True)
    page_number: int
    block_type: str = "paragraph"
    # PDF 坐标 [x0, y0, x1, y1]，原点在页面左上角
    bbox: list = Field(default_factory=list, sa_column=Column(JSON))
    reading_order: int = 0  # 全文阅读顺序
    text: str = ""
    # 段落主导字号（pt），覆盖层据此做自适应字号
    font_size: float = 9.5
    # 段落附加信息（保留字 metadata 不可用作 ORM 字段名，改此名）
    extra_meta: dict = Field(default_factory=dict, sa_column=Column(JSON))


class TranslationSegment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    block_id: int = Field(foreign_key="block.id", index=True)
    document_id: int = Field(foreign_key="document.id", index=True)
    text: str = ""
    status: str = "pending"  # pending | running | done | failed
    provider: str = ""
    model: str = ""
    cache_key: str = ""  # provider+model+提示词版本+原文 的哈希，避免重复计费
    retry_count: int = 0
    char_count: int = 0
    error: Optional[str] = None
    updated_at: datetime = Field(default_factory=utcnow)


class TranslationMemory(SQLModel, table=True):
    """全局翻译记忆：按「目标语言 + 原文 + 术语表」哈希存真实译文。

    不绑定服务商/模型/文档——重新解析、重复导入、跨文档重复内容全部命中，
    只有真正没翻过的原文才会调用翻译服务。
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    src_hash: str = Field(index=True, unique=True)
    source_text: str
    translated_text: str
    provider: str = ""
    model: str = ""
    lang: str = "zh"
    created_at: datetime = Field(default_factory=utcnow)


class Term(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    source: str = Field(index=True)
    target: str
    note: str = ""
    forced: bool = True
    created_at: datetime = Field(default_factory=utcnow)


class Annotation(SQLModel, table=True):
    """A user annotation anchored to a PDF block or a page region."""

    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="document.id", index=True)
    block_id: Optional[int] = Field(default=None, foreign_key="block.id", index=True)
    page_number: int
    kind: str = "comment"  # highlight | underline | comment | note
    target: str = "source"  # source | translation | formula | image | table
    bbox: list = Field(default_factory=list, sa_column=Column(JSON))
    # 划选批注：选区覆盖的每一行矩形（PDF 坐标 [x0,y0,x1,y1] 列表），bbox 为其并集
    rects: list = Field(default_factory=list, sa_column=Column(JSON))
    selected_text: str = ""
    content: str = ""
    color: str = "#fef08a"
    tags: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Note(SQLModel, table=True):
    """A standalone reading note, optionally linked to a document location."""

    id: Optional[int] = Field(default=None, primary_key=True)
    document_id: int = Field(foreign_key="document.id", index=True)
    title: str = ""
    content: str = ""
    page_number: Optional[int] = None
    block_id: Optional[int] = Field(default=None, foreign_key="block.id", index=True)
    quote: str = ""
    tags: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
