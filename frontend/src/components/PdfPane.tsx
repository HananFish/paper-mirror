import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, AnnotationOut, BlockOut, NoteOut } from "../api";
import { copyText } from "../clipboard";
import { isMirror } from "../mirrorStore";
import { toast } from "./Toaster";
import NotePopup from "./NotePopup";
import { beginTextDrag, orderTextLayer, selectionRects, selectionText } from './pdfTextSelection';
import {
  IconCopy,
  IconEye,
  IconEyeOff,
  IconHighlight,
  IconScan,
} from "./icons";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type ViewMode = "dual" | "source" | "translation";
export type JumpFn = (page: number, blockId?: number | null) => void;

interface Props {
  onRegionSelect?: (region: { page_number: number; bbox: number[]; source?: string; translation?: string; initialMode?: 'vision' }) => void;
  onFigureTranslate?: (blockId: number) => void;
  onLastPageChange?: (page: number) => void;
  fileUrl: string;
  blocks: BlockOut[];
  selectedId: number | null;
  hint?: string;
  onBlockClick: (b: BlockOut | null, pos: { x: number; y: number }) => void;
  notes?: NoteOut[];
  onNoteOpen?: (note: NoteOut) => void;
  annotations?: AnnotationOut[];
  onAnnotationClick?: (a: AnnotationOut, pos: { x: number; y: number }) => void;
  onSelectionCreate?: (d: {
    page_number: number;
    rects: number[][];
    bbox: number[];
    text: string;
    block_id: number | null;
    comment: string;
    pos: { x: number; y: number };
    openNote?: boolean;
  }) => void;
  /** dual=双栏对照 / source=仅原文 / translation=仅译文 */
  viewMode?: ViewMode;
  /** 缩放系数，1 = 适应宽度 */
  zoom?: number;
  handTool?: boolean;
  onZoom?: (action: "in" | "out") => void;
  /** PdfPane 就绪后回调跳转函数（跳页 + 可选定位到块） */
  registerJumper?: (fn: JumpFn) => void;
  /** 正在编辑附注的高亮（Acrobat 式弹注锚定到该高亮） */
  noteAnnotationId?: number | null;
  onNoteClose?: () => void;
  onNoteSave?: (id: number, patch: { content: string; color: string; kind: AnnotationOut["kind"] }) => Promise<void>;
  onNoteDelete?: (id: number) => Promise<void>;
}

interface SelectionTool {
  page_number: number;
  rects: number[][];
  bbox: number[];
  text: string;
  block_id: number | null;
  anchorX: number;
  anchorY: number;
}

interface PageMeta {
  pageNumber: number;
  width: number;
  height: number;
}

// 覆盖层只替换自然语言文本；公式/表格/图片保留原样
const OVERLAY_TYPES = new Set(["paragraph", "heading", "list", "caption"]);

function canOverlay(b: BlockOut): boolean {
  return (
    OVERLAY_TYPES.has(b.block_type) &&
    !!b.translation &&
    b.translation.status === "done" &&
    !!b.translation.text &&
    b.bbox.length === 4
  );
}

function area(b: BlockOut): number {
  return (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
}

/**
 * 同源视图：渲染同一份 PDF 的原文栏与译文覆盖栏。
 * 双栏模式下几何完全一致、滚动 1:1 镜像；支持单栏视图与缩放。
 */
export default function PdfPane({
  fileUrl,
  blocks,
  selectedId,
  hint,
  onBlockClick,
  annotations = [],
  notes = [],
  onNoteOpen,
  onAnnotationClick,
  onSelectionCreate,
  onRegionSelect,
  onFigureTranslate,
  onLastPageChange,
  viewMode = "dual",
  zoom = 1,
  handTool = false,
  onZoom,
  registerJumper,
  noteAnnotationId,
  onNoteClose,
  onNoteSave,
  onNoteDelete,
}: Props) {
  const regionStart = useRef<{ x: number; y: number; page: HTMLElement; pageNumber: number } | null>(null);
  const [dragRect, setDragRect] = useState<number[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [rootWidth, setRootWidth] = useState(1200);
  const [loadError, setLoadError] = useState("");
  const [selTool, setSelTool] = useState<SelectionTool | null>(null);
  const syncFrame = useRef<number | null>(null);
  const syncSource = useRef<HTMLDivElement | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{pane: HTMLElement; x: number; y: number; left: number; top: number} | null>(null);
  const swallowPanClick = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const loadingTask = pdfjsLib.getDocument(fileUrl);
    setPdfDoc(null);
    setPages([]);
    setLoadError("");
    (async () => {
      try {
        const doc = await loadingTask.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        const metas: PageMeta[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const vp = page.getViewport({ scale: 1 });
          metas.push({ pageNumber: i, width: vp.width, height: vp.height });
        }
        setPdfDoc(doc);
        setPages(metas);
      } catch (e) {
        if (!cancelled) setLoadError(`PDF 加载失败：${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      void loadingTask.destroy().catch(() => {});
    };
  }, [fileUrl]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setRootWidth(w);
    });
    ro.observe(el);
    setRootWidth(el.clientWidth || 1200);
    return () => ro.disconnect();
  }, [pdfDoc]);

  const dual = viewMode === "dual";
  const showSource = viewMode !== "translation";
  const showTranslation = viewMode !== "source";
  const availW = dual ? rootWidth / 2 - 10 : rootWidth - 20;
  const scale = useMemo(
    () => Math.max(0.15, (availW - 24) / (pages[0]?.width ?? 612)) * zoom,
    [availW, pages, zoom]
  );
  const readingAnchor = useRef<{page: number; offset: number; x: number; pivotX?: number; pivotY?: number} | null>(null);
  const captureAnchor = useCallback((el: HTMLDivElement) => {
    const elements = el.querySelectorAll<HTMLElement>("[data-pdf-page]");
    let current = elements[0];
    for (const candidate of elements) {
      if (candidate.offsetTop <= el.scrollTop + 12) current = candidate;
      else break;
    }
    if (current) readingAnchor.current = {page: Number(current.dataset.pdfPage), offset: (el.scrollTop-current.offsetTop)/scale,
      x: (el.scrollLeft-current.offsetLeft)/scale};
  }, [scale]);
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    if (!anchor) return;
    for (const el of [leftRef.current, rightRef.current]) {
      if (!el || !el.clientWidth) continue;
      const page = el.querySelector<HTMLElement>(`[data-pdf-page="${anchor.page}"]`);
      if (page) {
        el.scrollTop = Math.max(0, page.offsetTop + anchor.offset * scale - (anchor.pivotY || 0));
        el.scrollLeft = Math.max(0, page.offsetLeft + anchor.x * scale - (anchor.pivotX || 0));
      }
    }
  }, [scale, viewMode]);

  // 附注目标高亮：渲染在左栏对应页面内（随页面滚动，Acrobat 式锚定）
  const noteAnn = useMemo(
    () => (noteAnnotationId != null ? annotations.find((a) => a.id === noteAnnotationId) ?? null : null),
    [annotations, noteAnnotationId]
  );

  // 触屏拖拽中的栏不写入镜像滚动：触摸事件在整个原生滚动过程中持续派发，
  // 可靠区分「手指正在拖哪一栏」，避免同步写入打断惯性滚动（平板卡顿主因之一）。
  const touchCounts = useRef(new Map<HTMLDivElement, number>());
  useEffect(() => {
    const panes = [leftRef.current, rightRef.current].filter((el): el is HTMLDivElement => !!el);
    if (!panes.length) return;
    const counts = touchCounts.current;
    const adjust = (el: HTMLDivElement, delta: number) => {
      const next = Math.max(0, (counts.get(el) || 0) + delta);
      if (next) counts.set(el, next);
      else counts.delete(el);
    };
    const cleanups = panes.flatMap((el) =>
      (
        [
          ["touchstart", 1],
          ["touchend", -1],
          ["touchcancel", -1],
        ] as const
      ).map(([name, delta]) => {
        const handler = () => adjust(el, delta);
        el.addEventListener(name, handler, { passive: true });
        return () => el.removeEventListener(name, handler);
      })
    );
    return () => cleanups.forEach((fn) => fn());
  }, [pdfDoc]);

  // 双栏选区互不越界：原生选区沿 DOM 顺序延伸，拖动选择手柄会越过分隔线
  // 把另一栏文本吞进选区。检测到选区跨栏时，把焦点端收回锚点所在栏的边界
  // （向后延伸收回栏首、向前延伸收回栏尾），选区停在分隔线上不再跨越。
  useEffect(() => {
    if (!dual) return;
    const paneOf = (node: Node | null) =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-pdf-scroll]") ?? null;
    const boundaryText = (pane: HTMLElement, atEnd: boolean): { node: Text; offset: number } | null => {
      // 不能依赖 .textLayer（译文栏是覆盖视图），直接遍历栏内非空文本节点
      const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
      let first: Text | null = null;
      let last: Text | null = null;
      let current: Text | null;
      while ((current = walker.nextNode() as Text | null)) {
        if (!current.data.length) continue;
        first ??= current;
        last = current;
      }
      if (!first || !last) return null;
      return atEnd ? { node: last, offset: last.data.length } : { node: first, offset: 0 };
    };
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const anchorPane = paneOf(sel.anchorNode);
      const focusPane = paneOf(sel.focusNode);
      if (!anchorPane || !focusPane || anchorPane === focusPane) return;
      const forward = sel.anchorNode!.compareDocumentPosition(sel.focusNode!) & Node.DOCUMENT_POSITION_FOLLOWING;
      const boundary = boundaryText(anchorPane, !!forward);
      if (boundary) sel.setBaseAndExtent(sel.anchorNode!, sel.anchorOffset, boundary.node, boundary.offset);
      else sel.removeAllRanges();
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [dual]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (e.type === 'keyup') { setSpaceHeld(false); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest('input, textarea, select, button, a, [contenteditable], [role="dialog"]') ||
          document.querySelector('[role="dialog"]')) return;
      e.preventDefault(); setSpaceHeld(true);
    };
    const release = () => { setSpaceHeld(false); panStart.current = null; setPanning(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', release);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onZoom) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return;
      const pane = (e.target as HTMLElement).closest<HTMLElement>('[data-pdf-scroll]');
      if (!pane || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      const page = (e.target as HTMLElement).closest<HTMLElement>('[data-pdf-page]');
      if (page) {
        const r = page.getBoundingClientRect(), view = pane.getBoundingClientRect();
        readingAnchor.current = {page: Number(page.dataset.pdfPage),
          offset: (e.clientY-r.top)/scale, x: (e.clientX-r.left)/scale,
          pivotX: e.clientX-view.left, pivotY: e.clientY-view.top};
      }
      onZoom(e.deltaY < 0 ? 'in' : 'out');
    };
    root.addEventListener('wheel', wheel, {passive: false});
    return () => root.removeEventListener('wheel', wheel);
  }, [onZoom, scale, pdfDoc]);

  // 当前可见页（用于工具栏页码、阅读位置记忆、大纲高亮）
  const reportVisiblePage = useCallback(
    (el: HTMLDivElement) => {
      if (!onLastPageChange) return;
      const pageEls = el.querySelectorAll<HTMLElement>("[data-pdf-page]");
      const mid = el.scrollTop + el.clientHeight / 2;
      let page = 1;
      for (let i = 0; i < pageEls.length; i++) {
        if (mid >= pageEls[i].offsetTop) page = i + 1;
        else break;
      }
      onLastPageChange(page);
    },
    [onLastPageChange]
  );

  // 1:1 镜像滚动 + 阅读锚点 + 可见页上报：全部合并进单个 rAF。
  // 触屏惯性滚动每秒可产生上百个 scroll 事件，逐事件做 querySelectorAll 与
  // offsetTop 读取会强制布局（layout thrash），是平板双栏卡顿的主因。
  const onPaneScroll = useCallback(
    (el: HTMLDivElement) => {
      syncSource.current = el;
      if (syncFrame.current !== null) return;
      syncFrame.current = requestAnimationFrame(() => {
        syncFrame.current = null;
        const from = syncSource.current;
        if (!from || !from.clientWidth) return;
        const to = from === leftRef.current ? rightRef.current : leftRef.current;
        if (dual && to && to.clientWidth && !touchCounts.current.get(to)) {
          if (Math.abs(to.scrollTop - from.scrollTop) > 1) to.scrollTop = from.scrollTop;
          if (Math.abs(to.scrollLeft - from.scrollLeft) > 1) to.scrollLeft = from.scrollLeft;
        }
        captureAnchor(from);
        reportVisiblePage(from);
      });
    },
    [dual, captureAnchor, reportVisiblePage]
  );

  // 跳页 + 可选定位块：滚动到页顶；给出 blockId 时滚到块上方 1/3 视口处
  const jumpTo = useCallback(
    (page: number, blockId?: number | null) => {
      const clamped = Math.min(Math.max(1, page), pages.length || 1);
      const b = blockId != null ? blocks.find((x) => x.id === blockId) : undefined;
      const targets = [leftRef.current, rightRef.current].filter((el): el is HTMLDivElement => !!el?.clientWidth);
      for (const el of targets) {
        const pageEls = el.querySelectorAll<HTMLElement>("[data-pdf-page]");
        const pe = pageEls[clamped - 1];
        if (!pe) continue;
        let top = pe.offsetTop - 12;
        if (b && b.page_number === clamped) {
          top = pe.offsetTop + b.bbox[1] * scale - el.clientHeight / 3;
        }
        el.scrollTop = Math.max(0, top);
        captureAnchor(el);
      }
    },
    [blocks, pages.length, scale, captureAnchor]
  );

  useLayoutEffect(() => {
    if (pdfDoc && pages.length > 0 && (leftRef.current || rightRef.current)) registerJumper?.(jumpTo);
  }, [pdfDoc, pages.length, viewMode, jumpTo, registerJumper]);

  useEffect(
    () => () => {
      if (syncFrame.current !== null) cancelAnimationFrame(syncFrame.current);
    },
    []
  );

  const hitTest = useCallback(
    (pageNumber: number, pageEl: HTMLElement | null, e: React.MouseEvent) => {
      if (!pageEl) return;
      // 拖选结束的 click 不当作普通点击
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      // Use the clicked page as the coordinate origin. Using the scroll container
      // breaks hit testing on every page after the first one.
      const rect = pageEl.getBoundingClientRect();
      const x = (e.clientX - rect.left) / scale;
      const y = (e.clientY - rect.top) / scale;
      // 划选批注优先：点击落在高亮矩形上 → 打开批注卡片
      for (let i = annotations.length - 1; i >= 0; i--) {
        const a = annotations[i];
        if (a.page_number !== pageNumber) continue;
        const rects = a.rects && a.rects.length ? a.rects : [a.bbox];
        for (const r of rects) {
          if (r.length === 4 && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) {
            if (onAnnotationClick) onAnnotationClick(a, { x: e.clientX, y: e.clientY });
            return;
          }
        }
      }
      const hits = blocks.filter(
        (b) =>
          b.page_number === pageNumber &&
          x >= b.bbox[0] - 2 &&
          x <= b.bbox[2] + 2 &&
          y >= b.bbox[1] - 2 &&
          y <= b.bbox[3] + 2
      );
      hits.sort((a, b) => area(a) - area(b)); // 命中最小（最精确）的块
      onBlockClick(hits[0] ?? null, { x: e.clientX, y: e.clientY });
    },
    [blocks, scale, onBlockClick, annotations, onAnnotationClick]
  );

  // 划选结束：把选区换算成 PDF 坐标矩形，弹出 高亮/批注/复制 工具条
  const handlePageMouseUp = useCallback(
    (meta: PageMeta, pageEl: HTMLElement, e: {clientX: number; clientY: number}) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      if (!pageEl.contains(sel.anchorNode) || !pageEl.contains(sel.focusNode)) return;
      const text = selectionText(pageEl,sel);
      if (!text) return;
      const pageRect = pageEl.getBoundingClientRect();
      const selectionScale = pageRect.width / meta.width;
      const rects: number[][] = [];
      let anchor: DOMRect | null = null;
      for (const r of selectionRects(pageEl, sel)) {
        if (r.width < .1 || r.height < .1) continue;
        rects.push([
          (r.left - pageRect.left) / selectionScale,
          (r.top - pageRect.top) / selectionScale,
          (r.right - pageRect.left) / selectionScale,
          (r.bottom - pageRect.top) / selectionScale,
        ]);
        anchor = r;
      }
      if (!rects.length) return;
      const xs = rects.flatMap((r) => [r[0], r[2]]);
      const ys = rects.flatMap((r) => [r[1], r[3]]);
      const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const hits = blocks.filter(b=>b.page_number === meta.pageNumber && b.block_type !== 'image').map(block=>({block,
        overlap: rects.reduce((sum,r)=>sum+Math.max(0,Math.min(r[2],block.bbox[2])-Math.max(r[0],block.bbox[0]))*
          Math.max(0,Math.min(r[3],block.bbox[3])-Math.max(r[1],block.bbox[1])),0)})).filter(hit=>hit.overlap>0);
      hits.sort((a,b)=>b.overlap-a.overlap);
      const hit=hits[0]?.block;
      setSelTool({
        page_number: meta.pageNumber,
        rects,
        bbox,
        text,
        block_id: hit?.id ?? null,
        anchorX: anchor ? anchor.right : e.clientX,
        anchorY: anchor ? anchor.bottom : e.clientY,
      });
    },
    [scale, blocks]
  );

  // 触屏（平板/手机）：长按选区走浏览器原生选区，松手不产生 mouseup，
  // 因此监听 selectionchange 弹出工具条；桌面指针仍走 mouseup 路径，互不影响。
  const coarsePointer = useMemo(
    () => window.matchMedia?.("(pointer: coarse)").matches ?? false,
    []
  );
  useEffect(() => {
    if (!coarsePointer) return;
    let timer: number | undefined;
    const locate = () => {
      const sel = window.getSelection();
      const node = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.anchorNode : null;
      const pageEl = (node instanceof Element ? node : node?.parentElement)?.closest(
        "[data-pdf-page]"
      );
      if (!(pageEl instanceof HTMLElement)) {
        setSelTool(null);
        return;
      }
      const meta = pages.find((p) => p.pageNumber === Number(pageEl.dataset.pdfPage));
      if (meta) handlePageMouseUp(meta, pageEl, { clientX: 0, clientY: 0 });
    };
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(locate, 250);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      window.clearTimeout(timer);
    };
  }, [coarsePointer, pages, handlePageMouseUp]);

  // Acrobat 流程：高亮后立即弹出附注框（由 Reader 打开）；选区工具条只留 高亮/复制
  const submitSelection = useCallback(
    (openNote: boolean) => {
      if (!selTool) return;
      onSelectionCreate?.({
        page_number: selTool.page_number,
        rects: selTool.rects,
        bbox: selTool.bbox,
        text: selTool.text,
        block_id: selTool.block_id,
        comment: "",
        openNote,
        pos: { x: selTool.anchorX, y: selTool.anchorY },
      });
      window.getSelection()?.removeAllRanges();
      setSelTool(null);
    },
    [selTool, onSelectionCreate]
  );

  if (loadError) {
    return <div className="p-6 text-sm text-red-600">{loadError}</div>;
  }
  if (!pdfDoc) {
    return <div className="p-6 text-sm text-neutral-500">PDF 加载中…</div>;
  }

  const onPageClick = (meta: PageMeta, e: React.MouseEvent) =>
    hitTest(meta.pageNumber, e.currentTarget as HTMLElement, e);

  const scrollProps = {
    onScroll: (e: React.UIEvent<HTMLDivElement>) => {
      if (e.currentTarget.clientWidth) onPaneScroll(e.currentTarget);
    },
  };

  return (
    <div ref={rootRef} data-hand-tool={handTool || spaceHeld} className={`h-full flex min-h-0 relative ${handTool || spaceHeld ? '[&_.textLayer]:cursor-grab cursor-grab' : ''} ${panning ? 'cursor-grabbing [&_.textLayer]:cursor-grabbing select-none' : ''}`}
      onPointerDownCapture={e => {
        if (e.button === 1 || (e.button === 0 && !e.shiftKey && (handTool || spaceHeld))) {
          const target = e.target as HTMLElement;
          const pane = target.closest<HTMLElement>('[data-pdf-scroll]');
          if (!pane || target.closest('button, input, textarea, select, a, [contenteditable]')) return;
          e.preventDefault(); e.stopPropagation(); window.getSelection()?.removeAllRanges(); setSelTool(null);
          panStart.current = {pane, x: e.clientX, y: e.clientY, left: pane.scrollLeft, top: pane.scrollTop};
          swallowPanClick.current = true; setPanning(true); e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
        swallowPanClick.current = false;
        if (!e.shiftKey || e.button !== 0) return;
        const page = (e.target as HTMLElement).closest<HTMLElement>('[data-pdf-page]');
        if (!page) return;
        e.preventDefault(); e.stopPropagation(); window.getSelection()?.removeAllRanges();
        regionStart.current = { x: e.clientX, y: e.clientY, page, pageNumber: Number(page.dataset.pdfPage) };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragRect([e.clientX, e.clientY, e.clientX, e.clientY]);
      }}
      onPointerMoveCapture={e => {
        const pan = panStart.current;
        if (pan) {
          e.preventDefault(); e.stopPropagation();
          pan.pane.scrollLeft = pan.left + pan.x-e.clientX;
          pan.pane.scrollTop = pan.top + pan.y-e.clientY;
          return;
        }
        const start = regionStart.current;
        if (!start) return;
        e.preventDefault(); e.stopPropagation();
        const r = start.page.getBoundingClientRect();
        const x = Math.max(r.left, Math.min(r.right, e.clientX));
        const y = Math.max(r.top, Math.min(r.bottom, e.clientY));
        setDragRect([Math.min(start.x, x), Math.min(start.y, y), Math.max(start.x, x), Math.max(start.y, y)]);
      }}
      onPointerUpCapture={e => {
        if (panStart.current) {
          e.preventDefault(); e.stopPropagation(); panStart.current = null; setPanning(false);
          e.currentTarget.releasePointerCapture(e.pointerId); return;
        }
        const start = regionStart.current;
        if (!start) return;
        e.preventDefault(); e.stopPropagation();
        const r = start.page.getBoundingClientRect();
        const x = Math.max(r.left, Math.min(r.right, e.clientX));
        const y = Math.max(r.top, Math.min(r.bottom, e.clientY));
        const bbox = [Math.min(start.x, x)-r.left, Math.min(start.y, y)-r.top, Math.max(start.x, x)-r.left, Math.max(start.y, y)-r.top].map(v => v / scale);
        regionStart.current = null; setDragRect(null);
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (bbox[2]-bbox[0] > 4 && bbox[3]-bbox[1] > 4) onRegionSelect?.({ page_number: start.pageNumber, bbox });
      }}
      onPointerCancel={() => { regionStart.current = null; setDragRect(null); panStart.current = null; setPanning(false); }}
      onLostPointerCapture={() => { panStart.current = null; setPanning(false); }}
      onClickCapture={e => { if (e.shiftKey || swallowPanClick.current) { e.preventDefault(); e.stopPropagation(); swallowPanClick.current = false; } }}
    >
      {dragRect && <div className="fixed z-50 border-2 border-blue-500 bg-blue-100/20 pointer-events-none" style={{ left: dragRect[0], top: dragRect[1], width: dragRect[2]-dragRect[0], height: dragRect[3]-dragRect[1] }} />}
      {selTool && (
        <div
          className="fixed z-50 flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-1.5 py-1 shadow-xl"
          style={{ left: Math.max(8, Math.min(selTool.anchorX, window.innerWidth - 300)), top: Math.min(selTool.anchorY + 6, window.innerHeight - 48) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button className="rounded px-2 py-1 text-xs hover:bg-yellow-100" onClick={() => submitSelection(false)}>高亮</button>
          <button
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-yellow-100"
            onClick={() => submitSelection(true)}
            title="高亮选中文本，并弹出附注框"
          >
            <IconHighlight size={13} /> 高亮并附注
          </button>
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-stone-700 hover:bg-neutral-100"
            onClick={() => {
              void copyText(selTool.text).then((ok) =>
                toast(ok ? "已复制选中文本" : "复制失败，请长按选中文本手动复制")
              );
              window.getSelection()?.removeAllRanges();
              setSelTool(null);
            }}
          >
            <IconCopy size={13} /> 复制
          </button>
        </div>
      )}
      {hint && blocks.length === 0 && (
        <div className="absolute top-2 left-1/2 z-20 -translate-x-1/2 bg-blue-50 text-blue-700 text-xs px-3 py-1 rounded-full shadow">
          {hint}
        </div>
      )}

      {(
        <div className="flex-1 min-w-0 h-full relative" style={{display: showSource ? undefined : "none"}}>
          <span className="pane-label absolute top-2 left-2 z-20 select-none">
            英文原文
          </span>
          <div
            ref={leftRef}
            data-pdf-scroll="source"
            {...scrollProps}
            className="h-full overflow-auto thin-scroll relative bg-stone-200/70"
          >
            <PageListView
              pdfDoc={pdfDoc}
              pages={pages}
              scale={scale}
              blocks={blocks}
              selectedId={selectedId}
              active={showSource}
              notes={notes}
              onNoteOpen={onNoteOpen}
              showOverlays={false}
              onPageClick={onPageClick}
              onOverlayClick={onBlockClick}
              annotations={annotations}
              onAnnotationOpen={onAnnotationClick}
              noteAnn={noteAnn}
              onNoteClose={onNoteClose}
              onNoteSave={onNoteSave}
              onNoteDelete={onNoteDelete}
              onSelection={handlePageMouseUp}
              onSelectionClear={() => setSelTool(null)}
            />
          </div>
        </div>
      )}
      {dual && <div className="w-px bg-stone-300/60 shrink-0" />}
      {(
        <div className="flex-1 min-w-0 h-full relative" style={{display: showTranslation ? undefined : "none"}}>
          <span className="pane-label absolute top-2 left-2 z-20 select-none">
            中文译文
          </span>
          <div
            ref={rightRef}
            data-pdf-scroll="translation"
            {...scrollProps}
            className="h-full overflow-auto thin-scroll relative bg-stone-200/70"
          >
            <PageListView
              pdfDoc={pdfDoc}
              pages={pages}
              scale={scale}
              blocks={blocks}
              selectedId={selectedId}
              active={showTranslation}
              notes={notes}
              onNoteOpen={onNoteOpen}
              showOverlays
              onPageClick={onPageClick}
              onOverlayClick={onBlockClick}
              onFigureTranslate={onFigureTranslate}
              onFigureInspect={(b, initialMode) => onRegionSelect?.({page_number: b.page_number, bbox: b.bbox, initialMode,
                source: b.ocr?.lines?.map(line => line.src).join("\n"),
                translation: b.ocr?.lines?.map(line => `${line.src} → ${line.dst}`).join("\n")})}
              annotations={annotations}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface PageListViewProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pages: PageMeta[];
  scale: number;
  blocks: BlockOut[];
  selectedId: number | null;
  active: boolean;
  notes: NoteOut[];
  onNoteOpen?: (note: NoteOut) => void;
  showOverlays: boolean;
  onPageClick: (meta: PageMeta, e: React.MouseEvent) => void;
  onOverlayClick: (b: BlockOut, pos: { x: number; y: number }) => void;
  onFigureTranslate?: (blockId: number) => void;
  onFigureInspect?: (block: BlockOut, initialMode?: 'vision') => void;
  annotations: AnnotationOut[];
  onAnnotationOpen?: (a: AnnotationOut, pos: {x: number; y: number}) => void;
  noteAnn?: AnnotationOut | null;
  onNoteClose?: () => void;
  onNoteSave?: (id: number, patch: { content: string; color: string; kind: AnnotationOut["kind"] }) => Promise<void>;
  onNoteDelete?: (id: number) => Promise<void>;
  onSelection?: (meta: PageMeta, pageEl: HTMLElement, e: {clientX: number; clientY: number}) => void;
  onSelectionClear?: () => void;
}

function PageListView({
  pdfDoc,
  pages,
  scale,
  blocks,
  selectedId,
  showOverlays,
  active,
  notes,
  onNoteOpen,
  onPageClick,
  onOverlayClick,
  annotations,
  onAnnotationOpen,
  noteAnn,
  onNoteClose,
  onNoteSave,
  onNoteDelete,
  onSelection,
  onSelectionClear,
  onFigureTranslate,
  onFigureInspect,
}: PageListViewProps) {
  const dragCleanup = useRef<(() => void) | null>(null);
  const pointerPoint = useRef<{clientX: number; clientY: number} | undefined>(undefined);
  useEffect(() => () => { dragCleanup.current?.(); dragCleanup.current=null; }, [pdfDoc]);
  const blocksByPage = useMemo(() => {
    const map = new Map<number, BlockOut[]>();
    for (const block of blocks) {
      const group = map.get(block.page_number) || [];
      group.push(block);
      map.set(block.page_number, group);
    }
    return map;
  }, [blocks]);
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, AnnotationOut[]>();
    for (const annotation of annotations) {
      const group = map.get(annotation.page_number) || [];
      group.push(annotation);
      map.set(annotation.page_number, group);
    }
    return map;
  }, [annotations]);
  return (
    <div className="flex flex-col items-center py-3 gap-4" style={{width: Math.max(0, ...pages.map(p => p.width * scale)) + 24, minWidth: '100%'}}>
      {pages.map((meta) => {
        const pageBlocks = blocksByPage.get(meta.pageNumber) || [];
        const notePositions: number[] = [];
        return (
          <div
            key={meta.pageNumber}
            data-pdf-page={meta.pageNumber}
            className="page-shadow relative bg-white shrink-0"
            style={{ width: meta.width * scale, height: meta.height * scale }}
            onClick={(e) => onPageClick(meta, e)}
            onPointerDown={e => { pointerPoint.current={clientX:e.clientX,clientY:e.clientY}; }}
            onMouseDown={e => {
              onSelectionClear?.();
              dragCleanup.current?.();dragCleanup.current=null;
              if (!showOverlays) {
                const page=e.currentTarget;
                dragCleanup.current=beginTextDrag(page,e.nativeEvent,pageBlocks,(point,dragged)=>{
                  dragCleanup.current=null;
                  if (dragged) onSelection?.(meta,page,point);
                },pointerPoint.current);
              }
            }}
            onMouseUp={(e) => !showOverlays && !dragCleanup.current && onSelection?.(meta, e.currentTarget as HTMLElement, e)}
            onDoubleClick={e => { if (!showOverlays) e.preventDefault(); }}
          >
            <VisiblePageContent active={active} scale={scale} width={meta.width} height={meta.height}>
            <PageCanvas pdfDoc={pdfDoc} pageNumber={meta.pageNumber} scale={scale} active={active} />
            {!showOverlays &&
              (annotationsByPage.get(meta.pageNumber) || [])
                .map((a, i) => (
                  <SourceAnnotation key={a.id} a={a} scale={1} popupOpen={noteAnn?.id === a.id}
                    onOpen={onAnnotationOpen} fallbackOffset={i * 22} pageWidth={meta.width} />
                ))}
            {!showOverlays && noteAnn && noteAnn.page_number === meta.pageNumber && onNoteClose && onNoteSave && onNoteDelete && (
              <NotePopupHost
                ann={noteAnn}
                scale={1}
                onClose={onNoteClose}
                onSave={onNoteSave}
                onDelete={onNoteDelete}
              />
            )}
            {!showOverlays && (
              <div className="textLayer">
                <TextSpans pdfDoc={pdfDoc} pageNumber={meta.pageNumber} scale={1} blocks={pageBlocks} />
              </div>
            )}
            {showOverlays && (
              <div className="absolute inset-0">
                {/* 右栏为译文覆盖视图，不渲染批注——高亮只属于左栏原文 */}
                {pageBlocks.filter(canOverlay).map((b) => (
                  <OverlayBlock
                    key={b.id}
                    block={b}
                    scale={1}
                    availableHeight={b.block_type === "heading" && !b.metadata?.rotation
                      ? Math.max(b.bbox[3]-b.bbox[1], Math.min(meta.height-24, ...pageBlocks.filter(next => next.id !== b.id && next.bbox[1] >= b.bbox[3] && next.bbox[0] < b.bbox[2] && next.bbox[2] > b.bbox[0]).map(next => next.bbox[1]-3))-b.bbox[1])
                      : undefined}
                    selected={b.id === selectedId}
                    onClick={(pos) => onOverlayClick(b, pos)}
                  />
                ))}
                {/* 图形区域：识别+翻译卡片 */}
                {pageBlocks.filter((b) => b.block_type === "image").map((b) => (
                  <FigureCard
                    key={`fig-${b.id}`}
                    block={b}
                    scale={1}
                    displayScale={scale}
                    onOcr={() => onFigureTranslate?.(b.id)}
                    onInspect={mode => onFigureInspect?.(b, mode)}
                  />
                ))}
              </div>
            )}
            {/* 选中块轮廓：两栏都框出对应位置 */}
            {pageBlocks
              .filter((b) => b.id === selectedId)
              .map((b) => (
                <div
                  key={b.id}
                  className="absolute border-2 border-blue-500 bg-blue-100/20 pointer-events-none rounded-sm"
                  style={{
                    left: b.bbox[0],
                    top: b.bbox[1],
                    width: (b.bbox[2] - b.bbox[0]),
                    height: (b.bbox[3] - b.bbox[1]),
                  }}
                />
              ))}
            {notes.filter(n => (n.page_number || pageBlocks.find(b => b.id === n.block_id)?.page_number) === meta.pageNumber).map((n, i) => {
              const b = pageBlocks.find(b => b.id === n.block_id);
              let top = b ? b.bbox[1] : 48+i*22;
              while (notePositions.some(previous => Math.abs(previous-top) < 20) && top < meta.height-44) top += 20;
              notePositions.push(top);
              return <button key={n.id} data-note-id={n.id} title={`${n.title}: ${n.content}`}
                className="absolute z-20 rounded bg-blue-600 px-1 text-[9px] text-white shadow"
                style={{left: 8, top}}
                onClick={e => { e.stopPropagation(); onNoteOpen?.(n); }}>N{n.id}</button>;
            })}
            </VisiblePageContent>
          </div>
        );
      })}
      <div className="h-2" />
    </div>
  );
}

/** Keep page placeholders cheap; mount text/overlays only near the viewport. */
function VisiblePageContent({active, scale, width, height, children}: {
  active: boolean; scale: number; width: number; height: number; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    // 触屏快速滑动跨度大，多预渲染一屏避免另一栏追上时内容空白
    const margin = window.matchMedia?.("(pointer: coarse)").matches ? "600px 0px" : "350px 0px";
    const io = new IntersectionObserver(entries => setVisible(!!entries[0]?.isIntersecting),
      {root: el.closest(".overflow-auto"), rootMargin: margin});
    io.observe(el.parentElement!);
    return () => io.disconnect();
  }, [active]);
  return <div ref={ref} data-page-content className="absolute left-0 top-0" style={{width, height, transform: `scale(${scale})`, transformOrigin: "top left"}}>
    {visible && children}
  </div>;
}

/** 左栏高亮批注：按选区行矩形渲染；有附注时末行右上角显示角标圆点。 */
function SourceAnnotation({ a, scale, popupOpen, onOpen, fallbackOffset, pageWidth }: {
  a: AnnotationOut; scale: number; popupOpen: boolean; pageWidth: number; fallbackOffset: number;
  onOpen?: (a: AnnotationOut, pos: {x: number; y: number}) => void;
}) {
  const rects = (a.rects && a.rects.length ? a.rects : [a.bbox]).filter((r) => r && r.length === 4);
  if (rects.length === 0) return <button data-annotation-id={a.id} title={`页批注：${a.content}`}
    className="absolute z-20 rounded border border-amber-300 bg-amber-100 px-1 text-[9px] text-stone-800"
    style={{left: pageWidth - 40, top: 48 + fallbackOffset}}
    onMouseUp={e => e.stopPropagation()}
    onClick={e => {e.stopPropagation(); onOpen?.(a, {x: e.clientX, y: e.clientY});}}>A{a.id}</button>;
  const last = rects[rects.length - 1];
  return (
    <>
      {rects.map((r, ri) => (
        <div
          key={ri}
          data-annotation-id={a.id}
          className="absolute pointer-events-none rounded-sm"
          title={a.content || "高亮"}
          style={{
            left: r[0] * scale,
            top: r[1] * scale,
            width: (r[2] - r[0]) * scale,
            height: (r[3] - r[1]) * scale,
            background: `${a.color}${popupOpen ? "85" : "59"}`,
            outline: a.content ? `1.5px dashed ${a.color}` : undefined,
          }}
        />
      ))}
      {a.content && (
        <span
          title={a.content}
          className="absolute pointer-events-none rounded-full"
          style={{
            left: last[2] * scale - 5,
            top: last[1] * scale - 5,
            width: 10,
            height: 10,
            background: a.color,
            border: "1px solid rgba(28,25,23,0.3)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          }}
        />
      )}
    </>
  );
}

/** 计算附注弹框锚点（高亮末行右上角），渲染在页面内坐标空间，随页面滚动。 */
function NotePopupHost({
  ann,
  scale,
  onClose,
  onSave,
  onDelete,
}: {
  ann: AnnotationOut;
  scale: number;
  onClose: () => void;
  onSave: (id: number, patch: { content: string; color: string; kind: AnnotationOut["kind"] }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{left: number; top: number} | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setPos({left: r.left, top: r.top});
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [ann.id, scale]);
  const rects = (ann.rects?.length ? ann.rects : [ann.bbox]).filter((r) => r?.length === 4);
  const last = rects[rects.length - 1] || [8, 48, 60, 64];
  return <>
    <span ref={anchorRef} className="absolute pointer-events-none" style={{left: last[2]*scale, top: last[1]*scale}} />
    {pos && <NotePopup key={ann.id} ann={ann} left={pos.left} top={pos.top}
      onClose={onClose} onSave={onSave} onDelete={onDelete} />}
  </>;
}


function FigureCard({ block, scale, displayScale, onOcr, onInspect }: {
  block: BlockOut; scale: number; displayScale: number;
  onOcr: () => void; onInspect: (mode?: 'vision') => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [method, setMethod] = useState('ocr');
  const [visionModel, setVisionModel] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [loadingSettings, setLoadingSettings] = useState(false);
  useEffect(() => {
    if (!chooser) return;
    let alive = true;
    setLoadingSettings(true); setSettingsError(''); setVisionModel(''); setMethod('ocr');
    api.settings().then(settings => {
      if (alive) setVisionModel(settings.vision.base_url.trim() && settings.vision.model.trim() ? settings.vision.model : '');
    }).catch(e => { if (alive) setSettingsError(String(e)); })
      .finally(() => { if (alive) setLoadingSettings(false); });
    return () => { alive = false; };
  }, [chooser]);
  const ocr = block.ocr;
  const rerunOcr = () => { setHidden(false); onOcr(); };
  // Also reveal results from document-wide image jobs while this card is mounted.
  useEffect(() => { if (ocr?.status === 'running') setHidden(false); }, [ocr?.status]);
  const [x0, y0, x1, y1] = block.bbox;
  const w = Math.max(1, (x1 - x0) * scale), h = Math.max(1, (y1 - y0) * scale);
  const lines = ocr?.lines ?? [];
  const hasResult = lines.length > 0, running = ocr?.status === 'running';
  // The page itself is transformed. Compensate for that transform so controls
  // remain readable at both zoom extremes, while adapting to rendered image width.
  const zoom = Math.max(.1, displayScale);
  const renderedWidth = w * zoom;
  const fontSize = Math.max(11, Math.min(14, renderedWidth / 35));
  const compact = renderedWidth < 260;
  const controlStyle = { fontSize: fontSize / zoom, minHeight: Math.max(26, Math.min(34, renderedWidth / 13)) / zoom,
    padding: `${4 / zoom}px ${7 / zoom}px`, gap: 4 / zoom };
  const buttonClass = 'inline-flex items-center justify-center rounded-md border border-stone-200 bg-white/95 shadow-sm disabled:opacity-50';
  const captions = ocr?.captions;
  const captionSummary = captions && captions.total > 0 && !captions.failed
    ? `图注已翻译 ${captions.translated}/${captions.total}` : '';
  const chooserDialog = chooser && createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setChooser(false)}>
    <div role="dialog" aria-label="选择图片识别方式" className="w-96 max-w-full rounded-xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="mb-4 flex justify-between"><h2 className="font-semibold">选择图片识别方式</h2><button onClick={() => setChooser(false)}>取消</button></div>
      <label className="mb-3 flex gap-2"><input type="radio" name="figure-recognition" checked={method === 'ocr'} onChange={() => setMethod('ocr')} />本地 OCR（默认）</label>
      <label className="mb-3 flex gap-2"><input type="radio" name="figure-recognition" disabled={!visionModel || loadingSettings} checked={method === 'vision'} onChange={() => setMethod('vision')} />视觉模型：{loadingSettings ? '读取配置中…' : visionModel || '尚未配置'}</label>
      <p className="mb-3 text-xs text-stone-500">OCR 译文贴回图片。视觉模型使用设置中的配置，将裁剪图发送给该服务，结果在校对窗口显示，可保存到笔记与批注。</p>
      {settingsError && <p role="alert" className="mb-3 text-xs text-red-600">读取视觉配置失败：{settingsError}；仍可使用 OCR。</p>}
      <button className="rounded bg-indigo-600 px-3 py-2 text-sm text-white" onClick={() => { setChooser(false); if (method === 'vision') onInspect('vision'); else rerunOcr(); }}>开始识别</button>
    </div>
  </div>, document.body);
  return <div data-figure-id={block.id} className="group absolute z-10" style={{ left: x0 * scale, top: y0 * scale, width: w, height: h }}>
    {!hidden && lines.filter(line => line.status === 'translated' || (!line.status && line.dst !== line.src)).map((ln, i) =>
      <LineChip key={i} ln={ln} figLeft={x0} figTop={y0} figWidth={w} figHeight={h} scale={scale} />)}
    <div className="absolute left-1 right-1 top-1 z-20 flex flex-wrap items-start gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" onClick={e => e.stopPropagation()}>
      {!hasResult && !isMirror() && <button aria-label="翻译图片及图注" disabled={running} style={controlStyle} className={buttonClass} onClick={rerunOcr} title="OCR 提取图中文字并翻译关联图注，译文显示在原位"><IconScan size={fontSize / zoom} />{compact ? '翻译' : '翻译图片及图注'}</button>}
      {hasResult && <button aria-label={hidden ? '显示译文' : '显示原文'} style={controlStyle} className={buttonClass} onClick={() => setHidden(!hidden)}>{hidden ? <IconEye size={fontSize / zoom} /> : <IconEyeOff size={fontSize / zoom} />}{hidden ? '显示译文' : '显示原文'}</button>}
      {!isMirror() && <button aria-label="校对 / 视觉识别" style={controlStyle} className={buttonClass} onClick={() => onInspect()} title="校对 / 视觉识别">{compact ? '校对' : '校对 / 视觉识别'}</button>}
      {ocr && !isMirror() && <button disabled={running} style={controlStyle} className={buttonClass} title={captionSummary || '重新提取图中文字并翻译'} onClick={() => setChooser(true)}>重新识别</button>}
    </div>
    <div className="absolute bottom-1 left-1 right-1 z-20 flex flex-col items-start gap-1" style={{fontSize: 11 / zoom}} onClick={e => e.stopPropagation()}>
      {running && <span className="rounded bg-white/95 px-2 py-1 shadow">提取并翻译中… {ocr?.total ? `${ocr.completed || 0}/${ocr.total}` : ''}</span>}
      {!running && !isMirror() && captions && (captions.total === 0 || captions.failed > 0) && <div role="status" className="rounded bg-white/95 px-2 py-1 shadow opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        {captions.total === 0 ? '未找到关联图注，可单独框选图注' : captions.failed > 0
          ? <button className="text-red-600" title={captions.error || '图注翻译未完成'} onClick={rerunOcr}>图注 {captions.translated}/{captions.total}，点击重试</button>
          : <span className="text-stone-500">图注已翻译 {captions.translated}/{captions.total}</span>}
      </div>}
      {!running && !isMirror() && ocr?.warning && <button className="rounded bg-amber-50 px-2 py-1 text-amber-800" title={ocr.warning} onClick={() => onInspect()}>查看识别提示</button>}
      {!running && !isMirror() && ocr?.status === 'failed' && <button className="rounded bg-red-50 px-2 py-1 text-red-600" title={ocr.error} onClick={() => setChooser(true)}>识别失败，重试</button>}
    </div>
    {chooserDialog}
  </div>;
}
function LineChip({
  ln,
  figLeft,
  figTop,
  figWidth,
  figHeight,
  scale,
}: {
  ln: { pbox: number[]; src: string; dst: string };
  figLeft: number;
  figTop: number;
  figWidth: number;
  figHeight: number;
  scale: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [px0, py0, px1, py1] = ln.pbox;
  const dst = ln.dst || ln.src;
  const boxW = Math.max(4, (px1 - px0) * scale);
  const boxH = Math.max(6, (py1 - py0) * scale);
  // 中心锚定：译文条中心对准 OCR 框中心
  const cx = ((px0 + px1) / 2 - figLeft) * scale;
  const cy = ((py0 + py1) / 2 - figTop) * scale;
  // 竖排原文（旋转 90° 的侧边标签）：框明显高瘦 → 中文也竖排
  const vertical = boxH > boxW * 1.6 && boxW < 26;
  const nlines = Math.max(
    1,
    (ln as { nlines?: number }).nlines ?? (dst.split("\n").length || 1)
  );
  const lineH = boxH / nlines;
  const fs0 = Math.max(5.5, Math.min(lineH * 0.86, 13));

  // 尺寸严格限制在原文框内：宽度=框宽、高度≈框高，
  // 字号从原字号向下二分搜索直到装进框内（横排可换行、竖排逐字下排）；
  // 最小字号仍装不下时限制在原框内，完整文字可通过悬停或校对查看。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = `${boxW}px`;
    el.style.whiteSpace = vertical ? "nowrap" : "pre-line";
    const fits = (s: number) => {
      el.style.fontSize = `${s}px`;
      return el.scrollWidth <= Math.ceil(boxW) && el.scrollHeight <= Math.ceil(boxH);
    };
    if (fits(fs0)) {
      el.style.fontSize = `${fs0}px`;
      return;
    }
    let lo = 5.5;
    let hi = fs0;
    while (hi - lo > 0.25) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    el.style.fontSize = `${lo.toFixed(2)}px`;
  }, [dst, fs0, boxW, boxH, vertical]);

  return (
    <div
      ref={ref}
      className="absolute flex items-center justify-center rounded-[2px] border border-stone-300/60 bg-white/95 px-[3px] py-[1px] text-stone-800"
      title={`${ln.src} → ${dst}`}
      style={{
        left: cx,
        top: cy,
        transform: "translate(-50%, -50%)",
        writingMode: vertical ? "vertical-rl" : "horizontal-tb",
        boxSizing: "border-box",
        width: boxW,
        height: boxH,
        overflow: "hidden",
      }}
    >
      {dst}
    </div>
  );
}

function OverlayBlock({
  block,
  scale,
  selected,
  onClick,
  availableHeight,
}: {
  block: BlockOut;
  scale: number;
  selected: boolean;
  onClick: (pos: { x: number; y: number }) => void;
  availableHeight?: number;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const heading = block.block_type === "heading";
  const rotation = block.metadata?.rotation || 0;
  const [x0, y0, x1, y1] = block.bbox;

  // 正文在原框内调整字号。标题保留原字号，只利用下一个块前的空白换行。
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const rotated = rotation % 180 !== 0;
    const baseH = (rotated ? outer.clientWidth : outer.clientHeight) - 4;
    if (rotation) {
      inner.style.position = "absolute";
      inner.style.left = "50%";
      inner.style.top = "50%";
      inner.style.width = `${Math.max(1, (rotated ? outer.clientHeight : outer.clientWidth) - 4)}px`;
      inner.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }
    const target = Math.max(6, (block.font_size || 9.5) * scale);
    if (heading) {
      inner.style.fontSize = `${target}px`;
      const originalHeight = (y1-y0+2)*scale;
      outer.style.height = `${Math.min((availableHeight || y1-y0+2)*scale, Math.max(originalHeight, inner.scrollHeight+2))}px`;
      return;
    }
    const fits = (s: number) => {
      inner.style.fontSize = `${s}px`;
      return inner.scrollHeight <= baseH;
    };
    if (!fits(target)) {
      let lo = 5.5;
      let hi = target;
      for (let i = 0; i < 9 && hi - lo > 0.25; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      inner.style.fontSize = `${lo.toFixed(2)}px`;
    }
  }, [block.translation?.text, scale, block.font_size, rotation, heading, availableHeight, block.metadata?.font_weight]);

  return (
    <div
      ref={outerRef}
      title={`原文：${block.text}`}
      data-overlay-type={block.block_type}
      onClick={(e) => {
        e.stopPropagation();
        onClick({ x: e.clientX, y: e.clientY });
      }}
      className={`absolute ${block.block_type === 'caption' ? 'z-20' : ''} bg-white text-neutral-900 cursor-pointer ${
        selected ? "outline outline-2 outline-blue-500" : ""
      }`}
      style={{
        left: (x0 - 1) * scale,
        top: (y0 - 1) * scale,
        width: (x1 - x0 + 2) * scale,
        height: ((heading ? availableHeight : undefined) || y1 - y0 + 2) * scale,
        padding: heading ? 0 : 2,
        boxSizing: "border-box",
        overflow: heading ? "auto" : "hidden",
        lineHeight: heading ? 1.1 : 1.3,
        fontWeight: block.metadata?.font_weight ?? 400,
        textAlign: block.metadata?.text_align || "left",
        overflowWrap: "anywhere",
      }}
    >
      <div ref={innerRef}>{block.translation!.text}</div>
    </div>
  );
}

type RasterEntry = {promise: Promise<HTMLCanvasElement>; pixels: number};
const rasterCaches = new WeakMap<pdfjsLib.PDFDocumentProxy, Map<string, RasterEntry>>();
function rasterKey(pageNumber: number, scale: number) {
  return `${pageNumber}:${scale.toFixed(3)}:${Math.min(window.devicePixelRatio || 1, 2)}`;
}
function pageRaster(pdfDoc: pdfjsLib.PDFDocumentProxy, pageNumber: number, scale: number) {
  let cache = rasterCaches.get(pdfDoc);
  if (!cache) { cache = new Map(); rasterCaches.set(pdfDoc, cache); }
  const key = rasterKey(pageNumber, scale);
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing.promise; }
  const entry: RasterEntry = {pixels: 0, promise: Promise.resolve(null as unknown as HTMLCanvasElement)};
  entry.promise = (async () => {
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({scale});
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
    const bitmap = document.createElement("canvas");
    bitmap.width = Math.max(1, Math.round(viewport.width * dpr));
    bitmap.height = Math.max(1, Math.round(viewport.height * dpr));
    await page.render({canvasContext: bitmap.getContext("2d")!, viewport, transform: [dpr,0,0,dpr,0,0]}).promise;
    entry.pixels = bitmap.width * bitmap.height;
    // Bound both raster count and memory; two panes share the same pending render.
    let pixels = [...cache!.values()].reduce((sum, item) => sum + item.pixels, 0);
    for (const [oldKey, old] of cache!) {
      if (cache!.size <= 12 && pixels <= 32_000_000) break;
      if (oldKey !== key) { cache!.delete(oldKey); pixels -= old.pixels; }
    }
    return bitmap;
  })().catch(error => { cache!.delete(key); throw error; });
  cache.set(key, entry);
  return entry.promise;
}

function PageCanvas({pdfDoc, pageNumber, scale, active}: {
  pdfDoc: pdfjsLib.PDFDocumentProxy; pageNumber: number; scale: number; active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // CSS scales the previous bitmap immediately; coalesce rapid clicks before rasterizing.
    const cached = rasterCaches.get(pdfDoc)?.has(rasterKey(pageNumber, scale));
    const timer = window.setTimeout(async () => {
      try {
        const bitmap = await pageRaster(pdfDoc, pageNumber, scale);
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        canvas.dataset.rasterKey = rasterKey(pageNumber, scale);
      } catch { /* Loading/destroy cancellation will be retried by the current page. */ }
    }, cached ? 0 : 140);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pdfDoc, pageNumber, scale, active]);
  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />;
}

function TextSpans({
  pdfDoc,
  pageNumber,
  scale,
  blocks,
}: {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  blocks: BlockOut[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(blocks);blocksRef.current=blocks;

  useEffect(() => {
    let cancelled = false;
    let layer: pdfjsLib.TextLayer | undefined;
    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const tc = await page.getTextContent();
        if (cancelled) return;
        if (!host.current) return;
        host.current.replaceChildren();
        host.current.style.setProperty("--scale-factor", String(scale));
        layer = new pdfjsLib.TextLayer({ textContentSource: tc, container: host.current, viewport });
        await layer.render();
        if (!cancelled && host.current) orderTextLayer(host.current,blocksRef.current);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [pdfDoc, pageNumber, scale]);

  return <div ref={host} className="textLayer" />;
}
