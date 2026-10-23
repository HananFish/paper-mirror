import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export interface RegionSelection { page_number: number; bbox: number[]; source?: string; translation?: string; initialMode?: 'vision' }

export default function RegionDialog({ docId, region, onClose, onSaved }: { docId: number; region: RegionSelection; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(region.source || '');
  const [translation, setTranslation] = useState(region.translation || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [warning, setWarning] = useState('');
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const savedNoteId = useRef<number | null>(null);
  const savedAnnotationId = useRef<number | null>(null);
  const [bbox, setBbox] = useState(region.bbox);
  const [preview, setPreview] = useState(region.bbox);
  const action = async (mode: string) => {
    controller.current?.abort();
    const current = ++requestId.current;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setSaved(false);
    try {
      const res = await fetch(`/api/documents/${docId}/region`, {
        signal: abort.signal, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_number: region.page_number, bbox: preview, mode, ...(mode === 'text' ? { text } : {}) }),
      });
      const data = await res.json();
      if (current !== requestId.current) return;
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '区域处理失败');
      setWarning(data.warning || '');
      if (mode === 'extract' || mode === 'ocr') setText(data.source);
      else setTranslation(data.translation);
    } catch (e) { if (current === requestId.current && !abort.signal.aborted) setError(String(e)); }
    finally { if (current === requestId.current) setBusy(false); }
  };
  useEffect(() => {
    savedNoteId.current = null; savedAnnotationId.current = null;
    if (region.initialMode === 'vision' && preview === region.bbox) { setTranslation(''); void action('vision'); }
    else if (!region.source || preview !== region.bbox) { setText(''); void action('extract'); }
    return () => { ++requestId.current; controller.current?.abort(); };
  }, [preview]);
  const query = new URLSearchParams({ page_number: String(region.page_number), x0: String(preview[0]), y0: String(preview[1]), x1: String(preview[2]), y1: String(preview[3]) });
  return <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
    <div role="dialog" aria-label="区域识别与翻译" className="bg-white rounded-xl shadow-xl w-[900px] max-w-full max-h-[90vh] overflow-auto p-5">
      <div className="flex justify-between mb-3"><h2 className="font-semibold">区域识别与翻译 · 第 {region.page_number} 页</h2><button onClick={onClose}>关闭</button></div>
      <p className="text-xs text-neutral-500 mb-3">普通图中文字可先本地识别、校正后翻译；复杂表格或流程图可选择视觉识别。请核对数字、单位与公式；视觉识别会把裁剪图发送给设置中的视觉模型。</p>
      <div className="flex gap-2 flex-wrap items-center mb-3">{bbox.map((n, i) => <label key={i} className="text-xs">{['左','上','右','下'][i]} <input type="number" value={n} className="border rounded w-20 px-1 py-1" onChange={e => setBbox(bbox.map((v,j) => j === i ? Number(e.target.value) : v))} /></label>)}
        <button disabled={busy} className="border rounded px-2 py-1 text-sm" onClick={() => { if (bbox[2] > bbox[0] && bbox[3] > bbox[1]) { setTranslation(''); setPreview([...bbox]); } else setError('右下坐标必须大于左上坐标'); }}>更新裁剪</button>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div><img alt="选中区域预览" src={`/api/documents/${docId}/region.png?${query}`} className="border w-full max-h-80 object-contain" /><label className="block text-sm mt-2">提取文本（可修正顺序、分行和数字）</label><textarea className="w-full border rounded p-2 h-40 text-sm" disabled={busy} value={text} onChange={e => {setText(e.target.value); setSaved(false);}} /></div>
        <div><div className="flex gap-2 flex-wrap mb-2"><button disabled={busy} className="border rounded px-3 py-2 text-sm disabled:opacity-50" onClick={() => action('ocr')}>本地重新识别</button><button disabled={busy || !text.trim()} className="bg-blue-600 text-white rounded px-3 py-2 text-sm disabled:opacity-50" onClick={() => action('text')}>翻译文本</button><button disabled={busy} className="border rounded px-3 py-2 text-sm disabled:opacity-50" onClick={() => action('vision')}>识别并翻译图片 / 表格</button></div>
          {busy && <p className="text-sm text-blue-600">处理中，请稍候…</p>}
          {warning && <p className="mb-2 text-xs text-amber-700">{warning}</p>}
          {error && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}
          <textarea aria-label="区域译文" className="border rounded p-2 w-full h-80 text-sm" placeholder="区域译文在这里显示；可编辑校正。表格以 Markdown 行列显示。" value={translation} onChange={e => { setTranslation(e.target.value); setSaved(false); }} />
          <button disabled={busy || !translation.trim() || saved} className="mt-2 border rounded px-3 py-1 text-sm disabled:opacity-50" onClick={async () => {
            setBusy(true); setError('');
            try {
              const note = {title: `第 ${region.page_number} 页区域翻译`, page_number: region.page_number, content: translation, quote: text};
              if (savedNoteId.current) await api.updateNote(docId,savedNoteId.current,note);
              else savedNoteId.current = (await api.addNote(docId,note)).id;
              const annotation = {page_number: region.page_number, bbox: preview, kind: 'comment' as const, selected_text: text, content: translation, target: 'image'};
              if (savedAnnotationId.current) await api.updateAnnotation(docId,savedAnnotationId.current,annotation);
              else savedAnnotationId.current = (await api.addAnnotation(docId,annotation)).id;
              setSaved(true); onSaved();
            } catch (e) { setError(String(e)); }
            finally { setBusy(false); }
          }}>{saved ? '已保存到笔记与批注' : '保存到笔记与区域批注'}</button>
        </div>
      </div>
    </div>
  </div>;
}
