import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnnotationOut, BlockOut, DocInfo, NoteOut, api, downloadExport } from "../api";
import PdfPane, { JumpFn, ViewMode } from "../components/PdfPane";
import RegionDialog, { RegionSelection } from "../components/RegionDialog";
import BlockPopover from "../components/BlockPopover";
import SidePanel, { SideTab } from "../components/SidePanel";
import { PromptDialog, PromptSpec } from "../components/PromptDialog";
import { NotesModal, SettingsModal, ShortcutsModal, TermsModal } from "../components/Modals";
import { toast } from "../components/Toaster";
import { isMirror } from "../mirrorStore";
import { beginReadingHistory, historyEvents, readingHistoryState } from '../readingHistory';
import {
  IconBack,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconColumns,
  IconDoc,
  IconExport,
  IconFileText,
  IconHand,
  IconHelp,
  IconLanguages,
  IconMinus,
  IconNote,
  IconOutline,
  IconPlus,
  IconSelect,
  IconUndo,
  IconRedo,
  IconSearch,
  IconSettings,
  IconTags,
  IconTranslate,
  IconWarning,
} from "../components/icons";

type ZoomAction = "in" | "out" | "reset";

/** 导出下拉菜单：fixed 定位到触发按钮正下方。
 *  工具栏是 overflow-x-auto 滚动容器，absolute 下拉会被裁剪，必须用 fixed。 */
function ExportMenu({ docId, anchorRef, onDone }: { docId: number; anchorRef: React.RefObject<HTMLButtonElement | null>; onDone: () => void }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [anchorRef]);
  const items: { label: string; sub: string; href: string; icon: React.ReactNode }[] = isMirror()
    ? [
        { label: "批注 PDF", sub: "发布时烘焙的高亮批注版", href: api.exportAnnotatedPdfUrl(docId), icon: <IconDoc size={15} /> },
        { label: "平板批注备份", sub: "JSON 文件，带回电脑合并", href: "#mirror-bundle", icon: <IconDoc size={15} /> },
      ]
    : [
        { label: "双语对照 Markdown", sub: "译文 + 原文", href: api.exportMdUrl(docId, "bilingual"), icon: <IconColumns size={15} /> },
        { label: "纯译文 Markdown", sub: "只含中文", href: api.exportMdUrl(docId, "zh"), icon: <IconLanguages size={15} /> },
        { label: "英文原文 Markdown", sub: "只含原文", href: api.exportMdUrl(docId, "source"), icon: <IconFileText size={15} /> },
        { label: "批注 PDF", sub: "高亮与批注写入 PDF", href: api.exportAnnotatedPdfUrl(docId), icon: <IconDoc size={15} /> },
        { label: "JSON 备份", sub: "全部数据", href: api.exportJsonUrl(docId), icon: <IconDoc size={15} /> },
      ];
  if (!pos) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onDone} />
      <div className="card pop-in fixed z-50 w-56 overflow-hidden py-1" style={{ top: pos.top, right: pos.right }}>
        {items.map((it) => (
          <button
            key={it.label}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-stone-50 disabled:opacity-50"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(it.label); setError(""); setLastUrl(it.href === "#mirror-bundle" ? null : it.href);
              try {
                if (it.href === "#mirror-bundle") {
                  const bundle = await api.mirrorBundle(docId);
                  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url; link.download = `mirror-annotations-${docId}.json`; link.style.display = "none";
                  document.body.appendChild(link); link.click(); link.remove();
                  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
                  toast("批注备份已发起下载");
                } else {
                  const extension = it.href.includes(".pdf") ? "pdf" : it.href.includes(".json") ? "json" : "md";
                  await downloadExport(it.href, `document-${docId}.${extension}`);
                  toast("文件已生成，已发起下载");
                }
              } catch (e) { setError(`导出失败：${String(e)}`); }
              finally { setBusy(null); }
            }}
          >
            <span className="text-stone-400">{it.icon}</span>
            <span className="flex-1">
              <span className="block text-[13px] leading-tight text-stone-700">{busy === it.label ? "正在生成…" : it.label}</span>
              <span className="block text-[11px] leading-tight text-stone-400">{it.sub}</span>
            </span>
          </button>
        ))}
        {error && <p role="alert" className="px-3 py-2 text-xs text-red-600">{error}</p>}
        {lastUrl && !busy && <div className="border-t px-3 py-2 text-xs text-stone-500">没有出现下载？<a className="ml-1 text-blue-600 underline" href={lastUrl} target="_blank" rel="noreferrer">直接打开文件</a></div>}
      </div>
    </>
  );
}

function loadStored<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    const v = raw === null ? null : JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

const isViewMode = (v: unknown): v is ViewMode => v === "dual" || v === "source" || v === "translation";
const isZoom = (v: unknown): v is number => typeof v === "number" && v >= 0.5 && v <= 3;

export default function Reader({ docId }: { docId: number }) {
  const [region, setRegion] = useState<RegionSelection | null>(null);
  const [doc, setDoc] = useState<DocInfo | null>(null);
  const [blocks, setBlocks] = useState<BlockOut[]>([]);
  const [selected, setSelected] = useState<{ id: number; pos: { x: number; y: number }; silent?: boolean } | null>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [notes, setNotes] = useState<NoteOut[]>([]);
  const [focusedNote, setFocusedNote] = useState<number | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationOut[]>([]);
  // 当前打开附注框的高亮（Acrobat 式：高亮 → 自动弹附注，点击高亮可再编辑）
  const [noteAnnId, setNoteAnnId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [taskPending, setTaskPending] = useState(false);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const version = useRef("");
  const captionsChecked = useRef<number | null>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);

  // 阅读体验状态：视图模式 / 缩放 / 侧栏 / 页码（本地记忆）
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadStored("tr.viewMode", "dual", isViewMode));
  const [zoom, setZoom] = useState<number>(() => loadStored("tr.zoom", 1, isZoom));
  const [handTool, setHandTool] = useState(false);
  const [history, setHistory] = useState(() => readingHistoryState(docId));
  useEffect(() => {
    const refresh = () => setHistory(readingHistoryState(docId));
    historyEvents.addEventListener('change', refresh);
    const end = beginReadingHistory(docId);
    return () => { historyEvents.removeEventListener('change', refresh); end(); };
  }, [docId]);
  const [side, setSide] = useState<{ open: boolean; tab: SideTab }>({ open: false, tab: "outline" });
  const [lastPage, setLastPage] = useState(1);
  const lastPageRef = useRef(1);

  useEffect(() => {
    try { localStorage.setItem("tr.viewMode", JSON.stringify(viewMode)); } catch { /* storage unavailable */ }
  }, [viewMode]);
  useEffect(() => {
    try { localStorage.setItem("tr.zoom", JSON.stringify(zoom)); } catch { /* storage unavailable */ }
  }, [zoom]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      let d = await api.getDocument(docId);
      if (!alive.current || sequence !== loadSequence.current) return;
      // 镜像站没有后端任务接口；图注整理在发布前已完成，直接跳过探测
      if (d.status === 'ready' && captionsChecked.current !== docId && !isMirror()) {
        captionsChecked.current = docId;
        try {
          await api.recoverCaptions(docId);
          d = await api.getDocument(docId);
        } catch (e) {
          setError(`旧文献图注整理未完成：${String(e)}。若提示接口不存在或 Method Not Allowed，请重启后端并刷新。`);
        }
        if (!alive.current || sequence !== loadSequence.current) return;
      }
      const nextVersion = JSON.stringify([d.updated_at, d.status, d.progress]);
      if (nextVersion === version.current) {
        if (!["parsing", "translating"].includes(d.status)) setTaskPending(false);
        return;
      }
      const [b, a, n] = await Promise.all([api.getBlocks(docId), api.annotations(docId), api.notes(docId)]);
      if (!alive.current || sequence !== loadSequence.current) return;
      version.current = nextVersion;
      setDoc(d);
      setBlocks(b);
      setAnnotations(a);
      setNotes(n);
      if (d.error) setError(d.error);
      if (!["parsing", "translating"].includes(d.status)) setTaskPending(false);
    } catch (e) {
      if (alive.current && sequence === loadSequence.current) setError(String(e));
    }
  }, [docId]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; ++loadSequence.current; };
  }, [load]);

  const busyStatus = doc?.status === "parsing" || doc?.status === "translating";
  useEffect(() => {
    if (!busyStatus && !taskPending) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      await load();
      if (!stopped) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [busyStatus, taskPending, load]);

  // ---- 页面跳转 ----
  const jumperRef = useRef<JumpFn | null>(null);
  const [jumperReady, setJumperReady] = useState(false);
  const registerJumper = useCallback((fn: JumpFn) => {
    jumperRef.current = fn;
    setJumperReady(true);
  }, []);
  const jump = useCallback((page: number, blockId?: number | null) => {
    const clamped = Math.min(Math.max(1, page), doc?.page_count || 1);
    jumperRef.current?.(clamped, blockId);
    lastPageRef.current = clamped;
    setLastPage(clamped);
  }, [doc?.page_count]);

  // 阅读位置记忆 / URL 定位（文献库全文搜索跳转 #/read/1?page=3&block=45）
  const urlTarget = useMemo(() => {
    const h = window.location.hash;
    const qi = h.indexOf("?");
    if (qi < 0) return null;
    const sp = new URLSearchParams(h.slice(qi + 1));
    const page = Number(sp.get("page")) || undefined;
    const block = Number(sp.get("block")) || undefined;
    return page || block ? { page, block } : null;
  }, []);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !doc || doc.page_count === 0 || !jumperReady) return;
    restoredRef.current = true;
    if (urlTarget?.block) {
      const b = blocks.find((x) => x.id === urlTarget.block);
      if (b) {
        setSelected({ id: b.id, pos: { x: 0, y: 0 }, silent: true });
        jump(b.page_number, b.id);
        return;
      }
    }
    jump(urlTarget?.page || doc.last_page || 1);
  }, [doc, blocks.length, jumperReady, urlTarget, jump]);

  // 选中的块实时取自最新 blocks（重译后卡片内容自动更新）
  const selBlock: BlockOut | null = selected
    ? blocks.find((b) => b.id === selected.id) ?? null
    : null;

  const onBlockClick = useCallback(
    (b: BlockOut | null, pos: { x: number; y: number }) => {
      setSelected(b ? { id: b.id, pos } : null);
    },
    []
  );

  const retranslate = useCallback(
    async (blockId: number) => {
      try {
        await api.retranslate(blockId);
        setTaskPending(true);
        toast("已提交重译");
        await load();
      } catch (e) { setError(String(e)); }
    },
    [load]
  );

  const translateAll = async (force = false) => {
    if (!doc) return;
    if (force && !window.confirm("强制重翻将跳过缓存，重新调用当前翻译服务，可能产生费用。继续？")) return;
    setBusy(true);
    setError("");
    try {
      await api.translate(doc.id, { force });
      setTaskPending(true);
      toast(force ? "已开始强制重翻" : "翻译任务已开始（优先复用有效翻译记忆）");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 段落级合并：同一段落再次高亮/批注时并入已有高亮（矩形取并集），绝不叠加。
  // 相邻行矩形 1.5pt 容差内视为相交，合并成整块。
  const mergeRectList = (rects: number[][]): number[][] => {
    let items = rects.map((r) => [...r]);
    let changed = true;
    while (changed) {
      changed = false;
      const out: number[][] = [];
      for (const r of items) {
        let hit = -1;
        for (let i = 0; i < out.length; i++) {
          const o = out[i];
          const sameLine = Math.min(r[3], o[3]) - Math.max(r[1], o[1]) > 0.8 * Math.min(r[3]-r[1], o[3]-o[1]);
          if (sameLine && r[0] <= o[2] + 1.5 && r[2] >= o[0] - 1.5) {
            hit = i;
            break;
          }
        }
        if (hit < 0) out.push(r);
        else {
          const o = out[hit];
          out[hit] = [
            Math.min(o[0], r[0]), Math.min(o[1], r[1]),
            Math.max(o[2], r[2]), Math.max(o[3], r[3]),
          ];
          changed = true;
        }
      }
      items = out;
    }
    return items;
  };

  const createSelectionAnnotation = useCallback(
    (d: {
      page_number: number;
      rects: number[][];
      bbox: number[];
      text: string;
      block_id: number | null;
      comment: string;
    }, opts?: { openNote?: boolean }) => {
      api.addAnnotation(docId, {
        page_number: d.page_number,
        rects: mergeRectList(d.rects),
        bbox: d.bbox,
        block_id: d.block_id,
        selected_text: d.text,
        content: d.comment,
        kind: d.comment ? "comment" : "highlight",
        target: "source",
      })
        .then((created) => {
          setAnnotations((prev) => [...prev, created]);
          if (opts?.openNote) setNoteAnnId(created.id);
          else toast("已高亮");
        })
        .catch((e) => setError(String(e)));
    },
    [docId]
  );

  // 保存成功后再关闭编辑器，失败时保留草稿。
  const saveNote = useCallback(
    async (id: number, patch: { content: string; color: string; kind: AnnotationOut["kind"] }) => {
      const updated = await api.updateAnnotation(docId, id, patch);
      setAnnotations((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      toast("批注已保存");
    },
    [docId]
  );

  const deleteNote = useCallback(
    async (id: number) => {
      await api.deleteAnnotation(docId, id);
      setAnnotations((prev) => prev.filter((x) => x.id !== id));
      setNoteAnnId(null);
      toast("批注已删除");
    },
    [docId]
  );

  // 图形区域：本地 OCR 提字 → 当前翻译服务译为中文
  const figureTranslate = useCallback(
    async (blockId: number) => {
      try {
        await api.ocrFigure(docId, blockId);
        setTaskPending(true);
        await load();
      } catch (e) { setError(String(e)); }
    },
    [docId, load]
  );

  // 阅读位置记忆：滚动停止 1s 后保存当前页
  const savePageTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(savePageTimer.current), []);
  const onVisiblePage = useCallback(
    (page: number) => {
      lastPageRef.current = page;
      setLastPage(page);
      window.clearTimeout(savePageTimer.current);
      savePageTimer.current = window.setTimeout(() => {
        api.setLastPage(docId, page).catch(() => {});
      }, 1000);
    },
    [docId]
  );

  // ---- 高亮并附注（Acrobat 流程：建高亮 → 自动弹附注框）----
  const annotate = () => {
    if (!selBlock) return;
    createSelectionAnnotation(
      {
        page_number: selBlock.page_number,
        rects: [selBlock.bbox],
        bbox: selBlock.bbox,
        text: selBlock.text,
        block_id: selBlock.id,
        comment: "",
      },
      { openNote: true }
    );
    setSelected(null);
  };

  const addNoteFromBlock = () => {
    if (!selBlock) return;
    setSelected(null);
    setPrompt({
      title: `第 ${selBlock.page_number} 页阅读笔记（保留原文引用）`,
      initial: "",
      validate: text => text.trim() ? null : "请输入笔记内容",
      placeholder: "记录你的理解、疑问或结论…",
      okText: "加入笔记",
      onOk: (content) => {
        setPrompt(null);
        if (!content.trim()) return;
        api.addNote(docId, {
          title: `第 ${selBlock.page_number} 页笔记`,
          content: content.trim(),
          page_number: selBlock.page_number,
          block_id: selBlock.id,
          quote: selBlock.text,
        })
          .then((note) => {
            setNotes(previous => [...previous, note]);
            setFocusedNote(note.id);
            toast("已保存，原文旁已添加笔记标记");
            setShowNotes(true);
          })
          .catch((e) => setError(String(e)));
        setSelected(null);
      },
    });
  };

  // ---- 缩放 ----
  const zoomStep = useCallback((action: ZoomAction) => {
    setZoom((z) => {
      if (action === "reset") return 1;
      const next = action === "in" ? z * 1.15 : z / 1.15;
      return Math.round(Math.min(3, Math.max(0.5, next)) * 100) / 100;
    });
  }, []);

  const replayHistory = useCallback(async (direction: 'undo' | 'redo') => {
    if (readingHistoryState(docId).busy) return;
    try {
      const changed = await (direction === 'undo' ? api.undoReading(docId) : api.redoReading(docId));
      if (!changed) { toast(direction === 'undo' ? '没有可撤销的阅读操作' : '没有可重做的阅读操作'); return; }
      try {
        const [a, n] = await Promise.all([api.annotations(docId), api.notes(docId)]);
        setAnnotations(a); setNotes(n); setSelected(null); setNoteAnnId(null);
        toast(direction === 'undo' ? '已撤销上一步阅读操作' : '已重做阅读操作');
      } catch (e) { setError(`操作已完成，但界面刷新失败：${String(e)}。请重新打开文献刷新记录。`); }
    } catch (e) { setError(`操作失败：${String(e)}。历史记录已保留，可重试。`); }
  }, [docId]);

  // ---- 键盘快捷键 ----
  const openSide = useCallback((tab: SideTab) => setSide({ open: true, tab }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.defaultPrevented || e.isComposing || document.querySelector('[role="dialog"]')) return;
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          e.preventDefault();
          if (!e.repeat) void replayHistory(key === 'y' || e.shiftKey ? 'redo' : 'undo');
        } else if (key === '+' || key === '=' || key === '-' || key === '0') {
          e.preventDefault(); zoomStep(key === '0' ? 'reset' : key === '-' ? 'out' : 'in');
        } else if (key === 'home' || key === 'end') {
          e.preventDefault(); jump(key === 'home' ? 1 : doc?.page_count || 1);
        } else if (key === "f") {
          e.preventDefault();
          openSide("search");
        }
        return;
      }
      if (e.altKey) return;
      switch (e.key) {
        case 'h':
        case 'H':
          if (!e.repeat) setHandTool(h => !h);
          break;
        case "j":
        case "J":
          jump(lastPageRef.current + 1);
          break;
        case "k":
        case "K":
          jump(lastPageRef.current - 1);
          break;
        case "/":
          e.preventDefault();
          openSide("search");
          break;
        case "o":
        case "O":
          setSide((s) => ({ open: !(s.open && s.tab === "outline"), tab: "outline" }));
          break;
        case "1":
          setViewMode("dual");
          break;
        case "2":
          setViewMode("source");
          break;
        case "3":
          setViewMode("translation");
          break;
        case "+":
        case "=":
          zoomStep("in");
          break;
        case "-":
          zoomStep("out");
          break;
        case "0":
          zoomStep("reset");
          break;
        case 'PageDown':
          e.preventDefault(); jump(lastPageRef.current + 1); break;
        case 'PageUp':
          e.preventDefault(); jump(lastPageRef.current - 1); break;
        case "?":
          setShowHelp((v) => !v);
          break;
        case "Escape":
          setSide((s) => ({ ...s, open: false }));
          setSelected(null);
          setNoteAnnId(null);
          setShowExport(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump, zoomStep, openSide, replayHistory, doc?.page_count]);

  const jumpToNote = (note: NoteOut) => {
    if (note.block_id) setSelected({ id: note.block_id, pos: { x: window.innerWidth / 2, y: 120 } });
    const block = blocks.find((b) => b.id === note.block_id);
    if (block || note.page_number) jump(block?.page_number || note.page_number || 1, note.block_id);
    setShowNotes(false);
  };

  if (!doc) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-400">
        {error ? <span className="text-red-500">{error}</span> : "加载中…"}
      </div>
    );
  }

  const { translated, total_blocks, failed } = doc.progress;
  const pct = total_blocks > 0 ? Math.round((translated / total_blocks) * 100) : 0;
  const pageCount = doc.page_count || 0;

  const viewSeg: { mode: ViewMode; title: string; icon: React.ReactNode }[] = [
    { mode: "dual", title: "双栏对照 (1)", icon: <IconColumns size={15} /> },
    { mode: "source", title: "仅原文 (2)", icon: <IconFileText size={15} /> },
    { mode: "translation", title: "仅译文 (3)", icon: <IconLanguages size={15} /> },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div role="toolbar" aria-label="阅读工具栏" className="flex h-12 items-center gap-1 border-b border-stone-200/80 bg-white px-2 shrink-0 overflow-x-auto whitespace-nowrap thin-scroll">
        <a href="#/" className="btn btn-ghost btn-icon h-8 w-8 shrink-0" title="返回文献库">
          <IconBack size={16} />
        </a>
        <span className="ml-0.5 min-w-12 max-w-[140px] truncate text-[13px] font-medium text-stone-800" title={doc.filename}>
          {doc.filename}
        </span>
        {busyStatus && (
          <span className="ml-1 shrink-0 rounded-md bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-600">
            {doc.status === "parsing" ? "解析中" : "翻译中"}
          </span>
        )}

        <div className="mx-1.5 flex shrink-0 items-center gap-1.5">
          <div className="h-1 w-20 overflow-hidden rounded-full bg-stone-200/80">
            <div className="h-full rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] tabular-nums text-stone-500">
            {translated}/{total_blocks}
            {failed > 0 && <span className="text-red-600"> · {failed}</span>}
          </span>
        </div>

        {!isMirror() && (
          <>
            <button className="btn btn-primary h-8 shrink-0" disabled={busy || busyStatus} onClick={() => void translateAll()} title="优先复用当前术语表对应的翻译记忆">
              <IconTranslate size={15} />
              {doc.status === "translating" ? "翻译中…" : total_blocks > 0 && translated < total_blocks ? "继续翻译" : "翻译全文"}
            </button>

            <button className="btn btn-ghost h-8 shrink-0" disabled={busy || busyStatus} onClick={() => void translateAll(true)} title="跳过缓存，按当前服务和术语表重新翻译">强制重翻</button>
          </>
        )}

        <div className="mx-1 hidden h-4 w-px bg-stone-200 shrink-0 xl:block" />

        <div className="mx-1 flex shrink-0 items-center gap-0.5">
          <button className="btn btn-ghost btn-icon h-8 w-8" disabled={lastPage <= 1} onClick={() => jump(lastPage - 1)} title="上一页 (K)">
            <IconChevronLeft size={15} />
          </button>
          <input
            className="h-7 w-9 rounded-md border border-stone-200 px-1 text-center text-xs tabular-nums text-stone-700 outline-none focus:border-indigo-400"
            value={lastPage}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isNaN(n)) jump(n);
            }}
            title="页码，回车跳转"
          />
          <span className="text-xs text-stone-400">/ {pageCount || "…"}</span>
          <button className="btn btn-ghost btn-icon h-8 w-8" disabled={pageCount > 0 && lastPage >= pageCount} onClick={() => jump(lastPage + 1)} title="下一页 (J)">
            <IconChevronRight size={15} />
          </button>
        </div>

        <div className="mx-1 flex shrink-0 items-center gap-0.5">
          <button className="btn btn-ghost btn-icon h-8 w-8" onClick={() => zoomStep("out")} title="缩小 (−)">
            <IconMinus size={15} />
          </button>
          <button
            className="w-11 shrink-0 text-center text-xs tabular-nums text-stone-600 hover:text-indigo-600"
            onClick={() => zoomStep("reset")}
            title="适应宽度 (0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button className="btn btn-ghost btn-icon h-8 w-8" onClick={() => zoomStep("in")} title="放大 (+)">
            <IconPlus size={15} />
          </button>
        </div>

        <div className="seg shrink-0" role="tablist" aria-label="视图模式">
          {viewSeg.map((v) => (
            <button
              key={v.mode}
              className={viewMode === v.mode ? "active" : ""}
              onClick={() => setViewMode(v.mode)}
              title={v.title}
            >
              {v.icon}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <button className="btn btn-ghost btn-icon h-8 w-8 shrink-0" onClick={() => openSide("search")} title="页内搜索 (Ctrl+F)">
          <IconSearch size={16} />
        </button>
        <button className="btn btn-ghost btn-icon h-8 w-8 shrink-0" onClick={() => openSide("outline")} title="目录大纲 (O)">
          <IconOutline size={16} />
        </button>
        <button className={`btn btn-icon h-8 w-8 shrink-0 ${handTool ? 'btn-primary' : 'btn-ghost'}`} aria-label="手形工具" aria-pressed={handTool}
          onClick={() => setHandTool(h => !h)} title={handTool ? '当前：手形平移；点击切换文字选取 (H)' : '当前：文字选取；点击切换手形平移 (H)'}>
          {handTool ? <IconHand size={16} /> : <IconSelect size={16} />}
        </button>
        <button className="btn btn-ghost btn-icon h-8 w-8 shrink-0" aria-label="撤销阅读操作" title="撤销高亮或笔记的增删改 (Ctrl+Z)"
          disabled={!history.undo || history.busy || noteAnnId !== null} onClick={() => void replayHistory('undo')}><IconUndo size={16} /></button>
        <button className="btn btn-ghost btn-icon h-8 w-8 shrink-0" aria-label="重做阅读操作" title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
          disabled={!history.redo || history.busy || noteAnnId !== null} onClick={() => void replayHistory('redo')}><IconRedo size={16} /></button>
        <button className="btn btn-ghost btn-icon h-8 w-8 shrink-0" aria-label="快捷键帮助" onClick={() => setShowHelp((v) => !v)} title="快捷键帮助 (?)">
          <IconHelp size={16} />
        </button>
        <button className="btn btn-accent-soft btn-icon h-8 w-8 shrink-0" aria-label="笔记与批注" onClick={() => setShowNotes(true)} title="笔记与批注">
          <IconNote size={16} />
        </button>

        <div className="relative shrink-0">
          <button
            ref={exportBtnRef}
            className="btn btn-outline h-8"
            onClick={() => setShowExport((v) => !v)}
          >            <IconExport size={15} />
            导出
            <IconChevronDown size={13} className="text-stone-400" />
          </button>
          {showExport && <ExportMenu docId={docId} anchorRef={exportBtnRef} onDone={() => setShowExport(false)} />}
        </div>

        {!isMirror() && (
          <>
            <button className="btn btn-ghost btn-icon h-8 w-8 shrink-0" onClick={() => setShowTerms(true)} title="术语表">
              <IconTags size={16} />
            </button>
            <button className="btn btn-ghost btn-icon h-8 w-8 shrink-0" onClick={() => setShowSettings(true)} title="翻译设置">
              <IconSettings size={16} />
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-red-200/80 bg-red-50/80 px-4 py-2 text-[13px] text-red-700">
          <IconWarning size={14} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button className="text-xs text-red-400 hover:text-red-600" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {doc.status === "parse_failed" && (
        <div className="border-b border-red-200/80 bg-red-50/80 px-4 py-2 text-[13px] text-red-700">
          解析失败：{doc.error}。可回到文献库「重新解析」。
        </div>
      )}

      {/* 主体：侧栏（目录/搜索）+ 双栏视图 */}
      <div className="flex flex-1 min-h-0">
        {side.open && (
          <SidePanel
            tab={side.tab}
            onTab={(t) => setSide({ open: true, tab: t })}
            onClose={() => setSide((s) => ({ ...s, open: false }))}
            blocks={blocks}
            activePage={lastPage}
            onJump={(page, blockId) => {
              if (blockId) setSelected({ id: blockId, pos: { x: 0, y: 0 }, silent: true });
              jump(page, blockId);
            }}
          />
        )}
        <div className="flex-1 min-w-0">
          <PdfPane
            onRegionSelect={setRegion}
            onLastPageChange={onVisiblePage}
            onFigureTranslate={figureTranslate}
            fileUrl={api.fileUrl(docId)}
            blocks={blocks}
            selectedId={selected?.id ?? null}
            annotations={annotations}
            notes={notes}
            onNoteOpen={note => { setFocusedNote(note.id); setShowNotes(true); }}
            viewMode={viewMode}
            zoom={zoom}
            handTool={handTool}
            onZoom={zoomStep}
            registerJumper={registerJumper}
            hint={doc.status === "parsing" ? "正在解析 PDF…" : undefined}
            onBlockClick={(b, pos) => {
              setNoteAnnId(null);
              onBlockClick(b, pos);
            }}
            onAnnotationClick={(a) => {
              setSelected(null);
              setNoteAnnId(a.id);
            }}
            onSelectionCreate={(d) => createSelectionAnnotation(d, { openNote: d.openNote !== false })}
            noteAnnotationId={noteAnnId}
            onNoteClose={() => setNoteAnnId(current => current === noteAnnId ? null : current)}
            onNoteSave={saveNote}
            onNoteDelete={deleteNote}
          />
        </div>
      </div>

      {selBlock && selected && !selected.silent && (
        <BlockPopover
          block={selBlock}
          pos={selected.pos}
          onRetranslate={() => retranslate(selBlock.id)}
          onHighlightNote={annotate}
          onNote={addNoteFromBlock}
          onRegion={() => { setRegion({ page_number: selBlock.page_number, bbox: selBlock.bbox }); setSelected(null); }}
          onClose={() => setSelected(null)}
        />
      )}

      {region && <RegionDialog key={`${docId}:${region.page_number}:${region.bbox.join(",")}`} docId={docId} region={region}
        onClose={() => setRegion(null)} onSaved={() => {
          void Promise.all([api.notes(docId),api.annotations(docId)]).then(([n,a])=>{setNotes(n);setAnnotations(a);}).catch(e=>setError(String(e)));
        }} />}
      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
      {showNotes && <NotesModal currentPage={lastPage} pageCount={doc.page_count} focusNoteId={focusedNote}
        onNotesChange={() => { void api.notes(docId).then(setNotes).catch(e => setError(String(e))); }} docId={docId} onClose={() => setShowNotes(false)} onJump={jumpToNote}
        onAnnotationsChange={() => { void api.annotations(docId).then(setAnnotations).catch(e => setError(String(e))); }}
        onEditAnnotation={a => {
          if (viewMode === "translation") setViewMode("source");
          setShowNotes(false); setSelected(null); setNoteAnnId(a.id);
          jump(a.page_number, a.block_id);
        }} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showHelp && <ShortcutsModal onClose={() => setShowHelp(false)} />}
      {prompt && <PromptDialog spec={prompt} />}
    </div>
  );
}
