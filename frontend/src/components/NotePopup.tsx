import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnnotationOut } from "../api";
import { IconClose } from "./icons";

/** Acrobat 风格的高亮颜色盘 */
export const NOTE_COLORS = [
  { hex: "#fef08a", label: "黄色" },
  { hex: "#bbf7d0", label: "绿色" },
  { hex: "#bfdbfe", label: "蓝色" },
  { hex: "#fbcfe8", label: "粉色" },
];

interface Props {
  ann: AnnotationOut;
  /** 弹框锚点（视口 px 坐标）：高亮末行右上角 */
  left: number;
  top: number;
  onClose: () => void;
  onSave: (id: number, patch: { content: string; color: string; kind: AnnotationOut["kind"] }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/**
 * Acrobat DC 式「高亮附注」弹框：锚定在高亮末行右上角，随页面滚动。
 * 输入即暂存，关闭时自动保存；Ctrl+Enter 完成；Esc = 完成并关闭。
 */
export default function NotePopup({ ann, left, top, onClose, onSave, onDelete }: Props) {
  const [content, setContent] = useState(ann.content || "");
  const [color, setColor] = useState(ann.color || NOTE_COLORS[0].hex);
  const ref = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const swallowClick = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [size, setSize] = useState({width: 288, height: 300});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize(previous => previous.width === r.width && previous.height === r.height ? previous : {width: r.width, height: r.height});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const savedContent = ann.content || "";
  const savedColor = ann.color || NOTE_COLORS[0].hex;
  const dirty = content !== savedContent || color !== savedColor;

  const finish = useCallback(async () => {
    if (inFlight.current) return;
    const trimmed = content.trim();
    inFlight.current = true;
    setSaving(true); setError("");
    try {
      if (dirty) {
        const kind = ann.kind === "underline" || ann.kind === "note" ? ann.kind : trimmed ? "comment" : "highlight";
        await onSave(ann.id, { content: trimmed, color, kind });
      }
      onClose();
    } catch (e) {
      setError(`保存失败：${String(e)}。草稿已保留，请重试。`);
    } finally {
      inFlight.current = false; setSaving(false);
    }
  }, [ann.id, ann.kind, color, content, dirty, onClose, onSave]);

  // 点击弹框外部 = 完成并关闭（Acrobat 行为：输入过的内容保留）
  // 用 pointerdown：触屏上部分浏览器不一定派发兼容 mousedown
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (dirty || inFlight.current) { swallowClick.current = true; e.preventDefault(); e.stopImmediatePropagation(); }
        void finish();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (swallowClick.current) { swallowClick.current = false; e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
    };
  }, [finish, dirty]);

  // Esc 捕获阶段优先处理：保存并关闭，不触发外层「关闭全部」
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        void finish();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finish]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  const created = new Date(ann.created_at).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="编辑批注"
      className="pop-in fixed z-[60] w-72 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-auto rounded-lg border border-stone-200/90 bg-white shadow-2xl"
      style={{
        left: Math.max(8, Math.min(left - size.width + 16, window.innerWidth - size.width - 8)),
        top: Math.max(8, Math.min(top + 8, window.innerHeight - size.height - 8)),
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {/* 标题条：颜色随高亮色 */}
      <div className="flex items-center gap-2 rounded-t-lg px-3 py-2" style={{ background: `${color}cc` }}>
        <span className="text-xs font-semibold text-stone-800">{ann.kind === "note" || !ann.bbox.length ? "页批注" : "高亮附注"}</span>
        <span className="ml-auto text-[10px] tabular-nums text-stone-600">{created}</span>
        <button
          className="flex h-5 w-5 items-center justify-center rounded text-stone-700/70 hover:bg-black/5 hover:text-stone-900"
          onClick={() => void finish()}
          disabled={saving}
          title="完成（Esc）"
        >
          <IconClose size={12} />
        </button>
      </div>
      <div className="p-2.5">
        {ann.selected_text && <blockquote className="mb-2 max-h-16 overflow-auto border-l-2 border-stone-200 pl-2 text-xs text-stone-500">{ann.selected_text}</blockquote>}
        <textarea
          ref={taRef}
          className="min-h-20 w-full resize-y rounded-md border border-stone-200 bg-stone-50 px-2.5 py-2 text-[13px] leading-relaxed text-stone-800 outline-none transition-colors focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-100"
          placeholder="添加附注…（Ctrl+Enter 完成）"
          value={content}
          disabled={saving}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void finish(); }
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          {/* 颜色盘：即时改高亮色 */}
          <div className="flex items-center gap-1.5">
            {NOTE_COLORS.map((c) => (
              <button
                key={c.hex}
                title={c.label}
                disabled={saving}
                aria-pressed={color === c.hex}
                className={`h-4.5 w-4.5 rounded-full border transition-transform ${
                  color === c.hex ? "scale-110 border-stone-700" : "border-black/15 hover:scale-110"
                }`}
                style={{ width: 18, height: 18, background: c.hex }}
                onClick={() => setColor(c.hex)}
              />
            ))}
          </div>
          <div className="flex-1" />
          <button className="text-xs text-red-500 hover:underline" disabled={saving} onClick={async () => {
            if (inFlight.current) return;
            inFlight.current = true; setSaving(true); setError("");
            try { await onDelete(ann.id); onClose(); }
            catch (e) { setError(`删除失败：${String(e)}`); }
            finally { inFlight.current = false; setSaving(false); }
          }}>
            删除
          </button>
          <button className="rounded-md bg-stone-800 px-3 py-1 text-xs text-white hover:bg-stone-700" disabled={saving} onClick={() => void finish()}>
            {saving ? "保存中…" : "完成"}
          </button>
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    </div>, document.body
  );
}
