"""Offline contract tests for independently replaceable model backends."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
TEMP = tempfile.TemporaryDirectory(prefix='adapters-', dir=ROOT / 'data')
os.environ['APP_DATA_DIR'] = TEMP.name

import pymupdf
from sqlmodel import Session
from app import model_adapters as adapters
from app.db import engine, init_db
from app.models import Document
from app.routers import regions
from app.settings_store import Settings, load_settings, save_settings
from app.translators import get_provider
from app.tasks import _segment_key
from app.vision import OpenAICompatibleVision


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        pdf_path = Path(TEMP.name) / 'fixture.pdf'
        with pymupdf.open() as pdf:
            page = pdf.new_page(); page.insert_text((72, 100), 'Native text')
            pdf.save(pdf_path)
        with Session(engine) as session:
            doc = Document(filename='fixture.pdf', file_path=str(pdf_path), sha256='fixture', status='ready')
            session.add(doc); session.commit(); session.refresh(doc); cls.doc_id = doc.id

    def setUp(self):
        adapters.initialize_adapters()
        self.registry = patch.dict(adapters._adapters, {k: dict(v) for k,v in adapters._adapters.items()})
        self.registry.start(); self.addCleanup(self.registry.stop)

    def test_catalog_is_lazy_and_has_separate_capabilities(self):
        with patch('app.ocr._get_rapidocr') as ocr, patch('app.layout_yolo._get_model') as layout:
            self.assertEqual(adapters.adapter_catalog(), {'text':['openai'], 'vision':['openai'], 'ocr':['rapidocr'], 'layout':['doclayout']})
            ocr.assert_not_called(); layout.assert_not_called()

    def test_duplicate_unknown_and_client_import_paths_rejected(self):
        with self.assertRaises(ValueError): adapters.register_adapter('text', 'openai', lambda c,s: None)
        with self.assertRaises(ValueError): adapters.register_adapter('text', '../untrusted.py', lambda c,s: None)
        with self.assertRaises(ValueError): adapters.create_adapter('text', 'unregistered', {}, {})

    def test_custom_text_dispatch_and_cache_identity(self):
        provider = Mock(model='custom-model')
        provider.translate.return_value = ['译文', None]
        factory = Mock(return_value=provider)
        adapters.register_adapter('text', 'custom', factory)
        settings = Settings().model_dump(); settings['openai']['adapter']='custom'; settings['openai']['model']='custom-model'
        self.assertEqual(get_provider('openai', settings).translate(['a','b'],[],''), ['译文',None])
        factory.assert_called_once_with(settings['openai'], settings)
        before = _segment_key(settings,'openai','custom-model','source',[])
        settings['openai']['adapter']='openai'
        self.assertNotEqual(before,_segment_key(settings,'openai','custom-model','source',[]))

    def test_custom_vision_region_does_not_use_text_or_ocr(self):
        provider = Mock(); provider.recognize.return_value='Input → 输入'
        adapters.register_adapter('vision','custom-vision',lambda c,s: provider)
        save_settings({'vision':{'adapter':'custom-vision'}})
        try:
            with Session(engine) as session, patch('app.routers.regions.get_provider') as text, patch('app.routers.regions.recognize_png') as ocr:
                result=regions.region_action(self.doc_id,regions.Region(page_number=1,bbox=[70,80,300,150],mode='vision'),session)
                self.assertEqual(result['translation'],'Input → 输入')
                self.assertTrue(provider.recognize.call_args.args[0].startswith(b'\x89PNG'))
                text.assert_not_called(); ocr.assert_not_called()
                from fastapi import HTTPException
                provider.recognize.return_value='   '
                with self.assertRaises(HTTPException) as error:
                    regions.region_action(self.doc_id,regions.Region(page_number=1,bbox=[70,80,300,150],mode='vision'),session)
                self.assertEqual(error.exception.status_code,502)
        finally: save_settings({'vision':{'adapter':'openai'}})

    def test_custom_ocr_and_layout_dispatch(self):
        from app.ocr import recognize_png
        from app.layout_yolo import detect_layout
        lines=[{'quad':[[0,0],[20,0],[20,10],[0,10]],'src':'word','confidence':.95}]
        ocr=Mock(return_value=lines); layout=Mock(return_value=[{'name':'figure','bbox':[1,2,3,4],'conf':.9}])
        adapters.register_adapter('ocr','custom-ocr',lambda c,s:ocr)
        adapters.register_adapter('layout','custom-layout',lambda c,s:layout)
        with patch.dict(os.environ,{'OCR_ADAPTER':'custom-ocr','LAYOUT_ADAPTER':'custom-layout'}):
            self.assertEqual(recognize_png(b'png'),lines)
            page=object();self.assertEqual(detect_layout(page,144)[0]['name'],'figure')
        ocr.assert_called_once_with(b'png');layout.assert_called_once_with(page,144)

    def test_legacy_settings_get_defaults_and_do_not_store_secrets(self):
        self.assertEqual(load_settings()['openai']['adapter'],'openai')
        with self.assertRaises(ValueError): Settings.model_validate({'openai':{'adapter':'module.path'}})
        with self.assertRaises(ValueError): save_settings({'openai':{'api_key':'secret'}})
        self.assertNotIn('api_key',load_settings()['openai'])

    def test_builtin_vision_rejects_empty_and_truncated_results(self):
        provider=OpenAICompatibleVision('http://offline','fake','fake')
        for content,reason in [('', 'stop'), ('   ', 'stop'), ('partial','length')]:
            response=Mock();response.json.return_value={'choices':[{'finish_reason':reason,'message':{'content':content}}]}
            with patch('app.vision.http_post',return_value=response), self.assertRaises(ValueError):
                provider.recognize(b'png','zh',[])


if __name__ == '__main__':
    try: unittest.main(verbosity=2)
    finally:
        engine.dispose()
        TEMP.cleanup()
