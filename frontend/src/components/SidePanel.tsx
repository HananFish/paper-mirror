import { useMemo, useState } from "react";
import { BlockOut } from "../api";
import { IconClose, IconOutline, IconSearch } from "./icons";

export type SideTab = "outline" | "search";

interface Props {
  tab: SideTab;
  onTab: (t: SideTab) => void;
  onClose: () => void;
  blocks: BlockOut[];
  activePage: number;
  onJump: (page: number, blockId?: number | null) => void;
}

/** 阅读器侧栏：标题大纲 + 页内搜索（英文原文与中文译文都检索）。 */
export default function SidePanel({ tab, onTab, onClose, blocks, activePage, onJump }: Props) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-stone-200/80 bg-white">
      <div className="flex items-center gap-1 border-b border-stone-100 px-2 py-2">
        <button
          className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
            tab === "outline" ? "bg-indigo-50 text-indigo-700" : "text-stone-500 hover:bg-stone-100"
          }`}
          onClick={() => onTab("outline")}
        >
          <IconOutline size={14} />
          目录
        </button>
        <button
          className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
            tab === "search" ? "bg-indigo-50 text-indigo-700" : "text-stone-500 hover:bg-stone-100"
          }`}
          onClick={() => onTab("search")}
        >
          <IconSearch size={14} />
          搜索
        </button>
        <div className="flex-1" />
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-600"
          onClick={onClose}
          title="关闭侧栏 (Esc)"
        >
          <IconClose size={14} />
        </button>
      </div>
      {tab === "outline" ? <OutlineTab blocks={blocks} activePage={activePage} onJump={onJump} /> : <SearchTab blocks={blocks} onJump={onJump} />}
    </aside>
  );
}

/** 标题大纲：层级按字号分档（最大字号 = 一级，向下最多三级）。 */
function OutlineTab({ blocks, activePage, onJump }: { blocks: BlockOut[]; activePage: number; onJump: Props["onJump"] }) {
  const headings = useMemo(() => {
    const hs = blocks.filter((b) => b.block_type === "heading");
    const sizes = [...new Set(hs.map((h) => Math.round(h.font_size * 2) / 2))].sort((a, b) => b - a);
    const levelOf = (fs: number) => {
      if (sizes.length <= 1) return 0;
      const i = sizes.indexOf(Math.round(fs * 2) / 2);
      return i <= 0 ? 0 : Math.min(2, Math.ceil((i / (sizes.length - 1)) * 2));
    };
    return hs.map((h) => ({ ...h, level: levelOf(h.font_size) }));
  }, [blocks]);

  if (headings.length === 0) {
    return <div className="px-4 py-8 text-center text-xs text-stone-400">本文档没有识别出标题结构</div>;
  }
  return (
    <div className="flex-1 overflow-auto thin-scroll py-2">
      {headings.map((h) => {
        const active = h.page_number === activePage;
        return (
          <button
            key={h.id}
            className={`block w-full py-1.5 pr-3 text-left text-xs leading-snug transition-colors ${
              active ? "bg-indigo-50/70 text-indigo-700" : "text-stone-600 hover:bg-stone-50"
            }`}
            style={{ paddingLeft: 12 + h.level * 14 }}
            title={h.text}
            onClick={() => onJump(h.page_number, h.id)}
          >
            <span className="line-clamp-2">{h.text}</span>
            <span className={`ml-1 text-[10px] ${active ? "text-indigo-400" : "text-stone-300"}`}>P{h.page_number}</span>
          </button>
        );
      })}
    </div>
  );
}

interface InnerHit {
  block: BlockOut;
  kind: "原文" | "译文";
  idx: number;
}

function SearchTab({ blocks, onJump }: { blocks: BlockOut[]; onJump: Props["onJump"] }) {
  const [query, setQuery] = useState("");

  const hits: InnerHit[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: InnerHit[] = [];
    for (const b of blocks) {
      const si = b.text.toLowerCase().indexOf(q);
      if (si >= 0) out.push({ block: b, kind: "原文", idx: si });
      const t = b.translation?.status === "done" ? b.translation?.text : undefined;
      if (t) {
        const ti = t.toLowerCase().indexOf(q);
        if (ti >= 0) out.push({ block: b, kind: "译文", idx: ti });
      }
      if (out.length >= 400) break;
    }
    return out.sort(
      (a, b2) => a.block.page_number - b2.block.page_number || a.block.reading_order - b2.block.reading_order
    );
  }, [blocks, query]);

  return (
    <>
      <div className="border-b border-stone-100 p-2">
        <div className="relative">
          <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            autoFocus
            className="h-8 w-full rounded-md border border-stone-200 bg-stone-50 pl-7 pr-2 text-xs text-stone-800 outline-none transition-colors focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-100"
            placeholder="搜索原文或译文…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {query.trim() && (
          <div className="mt-1.5 px-0.5 text-[11px] text-stone-400">{hits.length > 0 ? `${hits.length} 条结果` : "无结果"}</div>
        )}
      </div>
      <div className="flex-1 overflow-auto thin-scroll py-1">
        {hits.map(({ block, kind, idx }, i) => {
          const q = query.trim();
          const full = kind === "原文" ? block.text : block.translation!.text;
          const start = Math.max(0, idx - 26);
          const end = Math.min(full.length, idx + q.length + 44);
          const text = full.slice(start, end);
          return (
            <button
              key={`${block.id}-${kind}-${i}`}
              className="block w-full px-3 py-1.5 text-left hover:bg-stone-50"
              onClick={() => onJump(block.page_number, block.id)}
            >
              <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-stone-400">
                <span className={`rounded px-1 ${kind === "原文" ? "bg-stone-100 text-stone-500" : "bg-indigo-50 text-indigo-500"}`}>
                  {kind}
                </span>
                <span>第 {block.page_number} 页</span>
              </div>
              <div className="text-xs leading-snug text-stone-600">
                {start > 0 && <span className="text-stone-300">…</span>}
                <Marked text={text} query={q} offset={idx - start} />
                {end < full.length && <span className="text-stone-300">…</span>}
              </div>
            </button>
          );
        })}
        {!query.trim() && (
          <div className="px-4 py-8 text-center text-xs leading-relaxed text-stone-400">
            输入关键词，同时检索
            <br />
            英文原文与中文译文
          </div>
        )}
      </div>
    </>
  );
}

/** 片段高亮：query 在 text 中的位置为 offset（本地索引）。 */
export function Marked({ text, query, offset }: { text: string; query: string; offset?: number }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = offset ?? text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}
