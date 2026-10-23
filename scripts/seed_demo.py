"""Curated offline screenshot data. Refuses to alter the user's normal library."""
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
directory=Path(os.environ.get("APP_DATA_DIR","")).resolve()
if directory.parent!=ROOT/"data" or not directory.name.startswith("browser-regression-"):
    raise SystemExit("Demo seeding is restricted to an isolated browser-regression directory.")
sys.path.insert(0,str(ROOT/"backend"))
from sqlmodel import Session,select
from app.db import engine
from app.models import Block,Document,TranslationSegment,utcnow

# Human-written translations for the first page; these are not model benchmarks.
TRANSLATIONS={
    "Translator Reader User Guide":"文献阅读器使用说明书",
    "Read the original":"对照原文、原位翻译，并保存阅读笔记。",
    "Abstract:":"摘要：这份英文说明书也是示例文献。导入后可练习翻译、文字划选、图片 OCR 和导出。尚未配置翻译服务时，请先阅读项目中的中文操作手册。",
    "Keywords:":"关键词：PDF 阅读、翻译记忆、图注、批注、本地存储",
    "1. Quick Start":"1. 快速开始",
    "1. Install":"1. 安装 Python 3.11+ 和 Node.js 22.12+，在项目根目录运行 python scripts/setup.py。",
    "2. Run":"2. 运行 python scripts/start.py，打开本机页面，点击说明书入口或导入 PDF。",
    "3. Wait":"3. 等待解析完成。默认 Mock 只演示流程，不生成真实中文译文。",
    "4. Choose":"4. 在设置里选择翻译服务，再翻译文献；失败的段落可以重试。",
    "2. Configure":"2. 配置翻译服务",
    "For a local Ollama":"本地 Ollama 使用 OpenAI 兼容接口，地址为 http://127.0.0.1:11434/v1，模型名称需与本机已安装模型一致。",
    "Choose simple":"专用翻译模型选择极简单段模式；能保持输出编号的指令模型可使用编号批量模式。",
    "For a cloud":"云端服务需在设置中填写接口和模型。密钥放在 .env 对应的环境变量中，修改后重启，不要提交到仓库。",
    "Fig. 1:":"图 1：文献阅读流程。可以练习翻译图片标签和这条图注。",
    "A safe first":"从一个小练习开始",
    "Import this guide":"导入说明书并翻译，选中一句话添加笔记，再导出带批注 PDF。检查原文页标记和文件末尾的可见笔记附录。",
    "Automatic translation":"自动翻译可以选择开启。解析和本地 OCR 不需要密钥；真实翻译使用配置的服务，可能产生服务费用。",
    "Installation downloads":"首次安装需要下载依赖。安装后解析、OCR、批注和导出都在本机运行；远程翻译或视觉服务会接收你选择处理的文字或图片。",
}


def main(did):
    with Session(engine) as session:
        doc=session.get(Document,did)
        if doc is None or doc.filename!="UserGuide.pdf":raise ValueError("Expected the generated user guide")
        blocks=session.exec(select(Block).where(Block.document_id==did,Block.page_number==1)).all()
        for block in blocks:
            translated=next((dst for src,dst in TRANSLATIONS.items() if block.text.startswith(src)),None)
            if translated:
                segment=session.exec(select(TranslationSegment).where(TranslationSegment.block_id==block.id)).first()
                if segment is None:segment=TranslationSegment(document_id=did,block_id=block.id)
                segment.text=translated;segment.status="done";segment.provider="demo";segment.model="human-written-preview"
                session.add(segment)
        doc.updated_at=utcnow();doc.status="ready";session.add(doc);session.commit()
    engine.dispose()


if __name__=="__main__":main(int(sys.argv[1]))
