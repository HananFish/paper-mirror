from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

from .config import DB_PATH

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


def init_db() -> None:
    # 确保模型已注册
    from . import models  # noqa: F401

    SQLModel.metadata.create_all(engine)
    # 轻量迁移：为旧库补上缺失列
    with engine.begin() as conn:
        rows = conn.exec_driver_sql("PRAGMA table_info(block)").fetchall()
        cols = {r[1] for r in rows}
        if rows and "font_size" not in cols:
            conn.exec_driver_sql(
                "ALTER TABLE block ADD COLUMN font_size REAL NOT NULL DEFAULT 9.5"
            )
        if rows and "metadata" not in cols:
            conn.exec_driver_sql("ALTER TABLE block ADD COLUMN metadata JSON DEFAULT '{}'")
        arows = conn.exec_driver_sql("PRAGMA table_info(annotation)").fetchall()
        acols = {r[1] for r in arows}
        if arows and "rects" not in acols:
            conn.exec_driver_sql("ALTER TABLE annotation ADD COLUMN rects JSON DEFAULT '[]'")
        drows = conn.exec_driver_sql("PRAGMA table_info(document)").fetchall()
        dcols = {r[1] for r in drows}
        if drows and "last_page" not in dcols:
            conn.exec_driver_sql("ALTER TABLE document ADD COLUMN last_page INTEGER NOT NULL DEFAULT 1")
        if rows and "extra_meta" not in cols:
            # 若旧表已有 metadata 列则复用其数据；否则直接新增
            if "metadata" in cols:
                conn.exec_driver_sql("ALTER TABLE block ADD COLUMN extra_meta JSON")
                conn.exec_driver_sql("UPDATE block SET extra_meta = metadata")
            else:
                conn.exec_driver_sql("ALTER TABLE block ADD COLUMN extra_meta JSON DEFAULT '{}'")
        # 进程中断会留下过期的 translating 状态，启动时复位（段落自带真实状态）
        conn.exec_driver_sql("UPDATE document SET status='ready', error='上次任务被中断，请重试' WHERE status='translating'")
        conn.exec_driver_sql("UPDATE document SET status='parse_failed', error='上次解析被中断，请重新解析' WHERE status='parsing'")
        conn.exec_driver_sql("UPDATE document SET status='ready', error='上次删除被中断，请重试' WHERE status='deleting'")
        conn.exec_driver_sql("UPDATE translationsegment SET status='failed', error='上次任务被中断，请重试' WHERE status='running'")
        conn.exec_driver_sql("UPDATE block SET extra_meta=json_set(extra_meta, '$.ocr.status', 'failed', '$.ocr.error', '上次识别被中断，请重试') WHERE json_extract(extra_meta, '$.ocr.status')='running'")
        # Retain the newest duplicate before imposing the one-segment-per-block invariant.
        conn.exec_driver_sql("DELETE FROM translationsegment WHERE id NOT IN (SELECT MAX(id) FROM translationsegment GROUP BY block_id)")
        conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_segment_block ON translationsegment(block_id)")
        conn.exec_driver_sql("UPDATE note SET block_id=NULL WHERE block_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM block WHERE block.id=note.block_id AND block.document_id=note.document_id)")
        conn.exec_driver_sql("DELETE FROM translationmemory WHERE provider='mock'")


def get_session():
    with Session(engine) as session:
        yield session
