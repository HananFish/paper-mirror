import { useEffect, useState } from "react";
import { AnnotationOut, AppSettings, NoteOut, TermOut, api } from "../api";
import { toast } from "./Toaster";
import { IconCheck, IconClose } from "./icons";

const inputCls =
  "w-full rounded-lg border border-stone-300 bg-white px-2.5 py-2 text-[13px] text-stone-800 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

export function TermsModal({ onClose }: { onClose: () => void }) {
  const [terms, setTerms] = useState<TermOut[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");

  const load = async () => setTerms(await api.terms());
  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, []);

  const add = async () => {
    setError("");
    try {
      await api.addTerm(source, target);
      setSource("");
      setTarget("");
      toast("术语已锁定");
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal title="术语表" onClose={onClose}>
      <p className="text-xs text-neutral-500 mb-3">
        锁定的术语会在后续所有翻译中强制使用指定译法。
      </p>
      <div className="flex gap-2 mb-3">
        <input
          className={inputCls}
          placeholder="原文术语，如 transformer"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder="指定译法，如 变换器"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <button
          className="btn btn-primary shrink-0"
          disabled={!source.trim() || !target.trim()}
          onClick={add}
        >
          添加
        </button>
      </div>
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
      <div className="max-h-72 overflow-auto thin-scroll divide-y divide-neutral-100">
        {terms.length === 0 && <div className="py-6 text-center text-sm text-neutral-400">暂无术语</div>}
        {terms.map((t) => (
          <div key={t.id} className="flex items-center py-1.5 text-sm">
            <span className="flex-1 text-neutral-700">{t.source}</span>
            <span className="text-neutral-400 px-2">→</span>
            <span className="flex-1 font-medium">{t.target}</span>
            <button
              className="text-xs text-red-500 hover:underline"
              onClick={async () => {
                await api.deleteTerm(t.id);
                load();
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [adapters, setAdapters] = useState({text: ['openai'], vision: ['openai']});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => setError(String(e)));
    api.modelAdapters().then(setAdapters).catch((e) => setError(String(e)));
  }, []);

  if (!settings) {
    return (
      <Modal title="设置" onClose={onClose}>
        <div className="text-sm text-neutral-400">{error || "加载中…"}</div>
      </Modal>
    );
  }

  const save = async () => {
    setError("");
    try {
      const s = await api.saveSettings(settings);
      setSettings(s);
      setSaved(true);
      toast("设置已保存");
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal title="翻译设置" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-neutral-600">翻译服务商</span>
          <select
            className={`mt-1 ${inputCls}`}
            value={settings.provider}
            onChange={(e) => setSettings({ ...settings, provider: e.target.value as AppSettings["provider"] })}
          >
            <option value="mock">mock（离线占位，不联网）</option>
            <option value="openai">OpenAI 兼容接口</option>
          </select>
        </label>

        {settings.provider === "openai" && (
          <>
            <label className="block"><span className="text-neutral-600">文本服务类型</span>
              <select className={`mt-1 ${inputCls}`} value={settings.openai.adapter || 'openai'} onChange={e => setSettings({...settings, openai: {...settings.openai, adapter: e.target.value}})}>
                {[...new Set([...adapters.text, settings.openai.adapter || 'openai'])].map(name => <option key={name} value={name}>{name === 'openai' ? 'OpenAI 兼容' : name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-neutral-600">Base URL</span>
              <input
                className={`mt-1 ${inputCls}`}
                value={settings.openai.base_url}
                onChange={(e) =>
                  setSettings({ ...settings, openai: { ...settings.openai, base_url: e.target.value } })
                }
              />
            </label>
            <label className="block">
              <span className="text-neutral-600">模型</span>
              <input
                className={`mt-1 ${inputCls}`}
                value={settings.openai.model}
                onChange={(e) =>
                  setSettings({ ...settings, openai: { ...settings.openai, model: e.target.value } })
                }
              />
            </label>
            <label className="block">
              <span className="text-neutral-600">翻译协议</span>
              <select
                className={`mt-1 ${inputCls}`}
                value={settings.openai.protocol}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    openai: { ...settings.openai, protocol: e.target.value as "numbered" | "simple" },
                  })
                }
              >
                <option value="numbered">编号批量（通用大模型：GPT / DeepSeek / Qwen）</option>
                <option value="simple">极简单段（翻译特化模型：Hy-MT2 等）</option>
              </select>
            </label>
            <p className="text-xs text-neutral-500">
              API 密钥从环境变量 <code className="bg-neutral-100 px-1 rounded">{settings.openai.api_key_env}</code>{" "}
              读取（可写在仓库根目录 <code className="bg-neutral-100 px-1 rounded">.env</code> 文件），不会存入数据库。
            </p>
          </>
        )}

        <details className="rounded-lg border border-stone-200 p-3">
          <summary className="cursor-pointer text-stone-600">区域图片识别模型</summary>
          <label className="mt-2 block">视觉服务类型
            <select aria-label="视觉服务类型" className={`mt-1 ${inputCls}`} value={settings.vision.adapter || 'openai'} onChange={e => setSettings({...settings, vision: {...settings.vision, adapter: e.target.value}})}>
              {[...new Set([...adapters.vision, settings.vision.adapter || 'openai'])].map(name => <option key={name} value={name}>{name === 'openai' ? 'OpenAI 兼容' : name}</option>)}
            </select>
          </label>
          <label className="mt-2 block">视觉服务 Base URL
            <input className={`mt-1 ${inputCls}`} value={settings.vision.base_url}
              onChange={(e) => setSettings({ ...settings, vision: { ...settings.vision, base_url: e.target.value } })} />
          </label>
          <label className="mt-2 block">视觉模型
            <input className={`mt-1 ${inputCls}`} value={settings.vision.model}
              onChange={(e) => setSettings({ ...settings, vision: { ...settings.vision, model: e.target.value } })} />
          </label>
          <p className="mt-2 text-xs text-stone-500">需支持图片输入，密钥从 {settings.vision.api_key_env} 环境变量读取。图内逐行 OCR 使用当前文本翻译服务。</p>
        </details>

        <label className="flex items-start gap-2.5 rounded-lg bg-stone-50 px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-indigo-600"
            checked={settings.auto_translate}
            onChange={(e) => setSettings({ ...settings, auto_translate: e.target.checked })}
          />
          <span>
            <span className="block text-[13px] font-medium text-stone-700">解析完成后自动翻译</span>
            <span className="block text-xs text-stone-400 mt-0.5">
              导入 PDF 解析完成后立即开始翻译；命中文翻译记忆的段落零成本，其余走当前服务商。
            </span>
          </span>
        </label>

        <label className="block">
          <span className="text-neutral-600">每批翻译段落数（1–20）</span>
          <input
            type="number"
            min={1}
            max={20}
            className="mt-1 w-32 rounded border border-neutral-300 px-2 py-1.5"
            value={settings.batch_size}
            onChange={(e) => setSettings({ ...settings, batch_size: Number(e.target.value) || 8 })}
          />
        </label>

        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="flex items-center gap-3 pt-1">
          <button className="btn btn-primary" onClick={save}>
            保存
          </button>
          {saved && <span className="flex items-center gap-1 text-xs text-green-600"><IconCheck size={13} /> 已保存</span>}
        </div>
      </div>
    </Modal>
  );
}

export function NotesModal({
  docId,
  currentPage,
  pageCount,
  focusNoteId,
  onNotesChange,
  onClose,
  onJump,
  onEditAnnotation,
  onAnnotationsChange,
}: {
  docId: number;
  currentPage: number;
  pageCount: number;
  focusNoteId: number | null;
  onNotesChange: () => void;
  onClose: () => void;
  onJump: (note: NoteOut) => void;
  onEditAnnotation: (annotation: AnnotationOut) => void;
  onAnnotationsChange: () => void;
}) {
  const [notes, setNotes] = useState<NoteOut[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationOut[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [notePage, setNotePage] = useState<number | null>(currentPage);
  const [editing, setEditing] = useState<NoteOut | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = () => Promise.all([api.notes(docId), api.annotations(docId)]).then(([n, a]) => { setNotes(n); setAnnotations(a); }).catch((e) => setError(String(e)));
  useEffect(() => { void load(); }, [docId]);
  useEffect(() => {
    if (focusNoteId) document.querySelector(`[data-note-card="${focusNoteId}"]`)?.scrollIntoView({block: "nearest"});
  }, [focusNoteId, notes]);
  const add = async () => {
    if (!content.trim() || saving) return;
    setSaving(true); setError("");
    try {
      const body = {title: title.trim() || "未命名笔记", content: content.trim(), page_number: notePage};
      if (editing) await api.updateNote(docId, editing.id, {...body, block_id: notePage === editing.page_number ? editing.block_id : null});
      else await api.addNote(docId, body);
      setTitle(""); setContent(""); setEditing(null); setNotePage(currentPage);
      toast("笔记已保存，将收录到 PDF 笔记附录"); await load(); onNotesChange();
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="阅读笔记" onClose={onClose}>
      <div className="space-y-2 mb-4">
        <input className={inputCls} placeholder="标题（可选）" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className={`${inputCls} min-h-24`} placeholder="记录你的理解、疑问或结论…" value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="flex items-center gap-2 text-xs">
          <label>关联位置：<select aria-label="笔记关联位置" className="rounded border px-1 py-1" value={notePage ?? ""} onChange={e => setNotePage(e.target.value ? Number(e.target.value) : null)} disabled={saving}>
            <option value="">整篇文献（无页码）</option>
            {Array.from({length: pageCount}, (_, i) => <option key={i+1} value={i+1}>第 {i+1} 页</option>)}
          </select></label>
          <span className="text-stone-500">导出时正文收录在末尾附录</span>
        </div>
        <button className="btn btn-primary" disabled={!content.trim() || saving} onClick={add}>{saving ? "保存中…" : editing ? "保存笔记" : "添加笔记"}</button>
        {editing && <button className="btn ml-2" onClick={() => {setEditing(null); setTitle(""); setContent("");}}>取消编辑</button>}
      </div>
      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}
      <div className="divide-y divide-neutral-100 max-h-72 overflow-auto thin-scroll">
        {notes.length === 0 && <div className="py-6 text-center text-sm text-neutral-400">还没有笔记</div>}
        {notes.map((n) => (
          <div key={n.id} data-note-card={n.id} className={`py-2 ${focusNoteId === n.id ? "bg-blue-50" : ""}`}>
            <button className="text-left w-full hover:bg-neutral-50 rounded px-1" onClick={() => onJump(n)}>
              <div className="font-medium text-sm">N{n.id} · {n.title}</div>
              {n.quote && <blockquote className="my-1 border-l-2 pl-2 text-xs text-stone-500 line-clamp-2">{n.quote}</blockquote>}
              <div className="text-xs text-neutral-600 whitespace-pre-wrap line-clamp-3">{n.content}</div>
              <div className="text-[11px] text-blue-600 mt-1">{n.page_number ? `第 ${n.page_number} 页 · 点击定位` : "整篇文献笔记 · PDF 附录"}</div>
            </button>
            <button className="mr-3 text-xs text-blue-600" onClick={() => {setEditing(n); setTitle(n.title); setContent(n.content); setNotePage(n.page_number);}}>编辑笔记</button>
            <button className="text-xs text-red-500 mt-1" onClick={async () => { try { await api.deleteNote(docId, n.id); await load(); onNotesChange(); } catch (e) { setError(String(e)); } }}>删除</button>
          </div>
        ))}
      </div>
      {annotations.length > 0 && (
        <div className="mt-4 border-t border-neutral-200 pt-3">
          <div className="text-xs font-medium text-neutral-500 mb-2">批注</div>
          <div className="space-y-2 max-h-40 overflow-auto thin-scroll">
            {annotations.map((a) => (
              <div key={a.id} className="flex items-start gap-2 text-xs rounded px-2 py-1.5" style={{background: `${a.color}55`, borderLeft: `3px solid ${a.color}`}}>
                <button className="flex-1 text-left" onClick={() => onJump({ id: 0, document_id: docId, title: "", content: a.content, page_number: a.page_number, block_id: a.block_id, quote: a.selected_text, tags: [], created_at: a.created_at, updated_at: a.updated_at })}>
                  <div>第 {a.page_number} 页 · {a.kind === "comment" ? "高亮附注" : "高亮"}</div>
                  <div className="text-neutral-600 line-clamp-2">{a.content || a.selected_text || "高亮"}</div>
                </button>
                <button className="text-xs text-blue-600 hover:underline" onClick={() => onEditAnnotation(a)}>编辑</button>
                <button className="text-xs text-red-500 hover:underline" onClick={async () => { try { await api.deleteAnnotation(docId, a.id); await load(); onAnnotationsChange(); } catch (e) { setError(String(e)); } }}>删除</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ["J / K", "下一页 / 上一页"],
  ["+ / − / 0", "放大 / 缩小 / 适应宽度"],
  ["Ctrl + 滚轮", "以鼠标位置为中心缩放 PDF"],
  ["Ctrl + + / − / 0", "缩放 PDF / 适应宽度"],
  ["H", "切换手形工具与文字选取"],
  ["空格 + 左键 / 中键拖动", "临时平移放大后的页面"],
  ["Ctrl+Z", "撤销本次阅读中已保存的高亮／笔记操作"],
  ["Ctrl+Shift+Z / Ctrl+Y", "重做阅读操作；输入框内保留文字撤销"],
  ["PageDown / PageUp", "下一页 / 上一页"],
  ["Ctrl+Home / Ctrl+End", "首页 / 末页"],
  ["1 / 2 / 3", "双栏对照 / 仅原文 / 仅译文"],
  ["Ctrl+F 或 /", "页内搜索原文与译文"],
  ["O", "目录大纲"],
  ["?", "快捷键帮助"],
  ["Shift + 拖动", "框选图片 / 表格区域识别翻译"],
  ["Esc", "关闭弹层与侧栏"],
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="键盘快捷键" onClose={onClose}>
      <div className="divide-y divide-stone-100">
        {SHORTCUTS.map(([k, desc]) => (
          <div key={k} className="flex items-center justify-between py-2 text-sm">
            <span className="text-stone-600">{desc}</span>
            <kbd className="rounded-md border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-xs text-stone-500 shadow-sm">
              {k}
            </kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-stone-900/25 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="modal-in w-[460px] max-w-[92vw] max-h-[85vh] overflow-auto thin-scroll rounded-2xl border border-stone-200/70 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-stone-900">{title}</h2>
          <button
            aria-label={`关闭${title}`}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            onClick={onClose}
          >
            <IconClose size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
