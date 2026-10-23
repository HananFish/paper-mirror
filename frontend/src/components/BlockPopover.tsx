import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BlockOut } from "../api";
import { copyText } from "../clipboard";
import { isMirror } from "../mirrorStore";
import { toast } from "./Toaster";
import {
  IconClose,
  IconCopy,
  IconCrop,
  IconHighlight,
  IconNote,
  IconRefresh,
} from "./icons";

const TYPE_LABEL: Record<string, string> = {
  paragraph: "段落",
  heading: "标题",
  list: "列表",
  caption: "图表注释",
  reference: "参考文献",
  formula: "公式",
  table: "表格",
  image: "图片",
};

const TRANSLATABLE = new Set(["paragraph", "heading", "list", "caption"]);

interface Props {
  block: BlockOut;
  pos: { x: number; y: number };
  onRetranslate: () => void;
  onClose: () => void;
  /** Acrobat 流程：整段高亮并自动弹出附注框 */
  onHighlightNote: () => void;
  onNote: () => void;
  onRegion: () => void;
}

/** 点击段落后弹出的小操作卡片：段落信息 + 重译/复制/高亮附注。 */
export default function BlockPopover({ block, pos, onRetranslate, onClose, onHighlightNote, onNote, onRegion }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [adj, setAdj] = useState({ left: pos.x, top: pos.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = pos.x + 14;
    let top = pos.y + 14;
    if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10;
    if (left < 10) left = 10;
    if (top + h > window.innerHeight - 10) top = Math.max(10, pos.y - h - 14);
    setAdj({ left, top });
  }, [pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const onOutside = (e: PointerEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) onClose();
    };
    document.addEventListener('pointerdown',onOutside,true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener('pointerdown',onOutside,true);
    };
  }, [onClose]);

  const t = block.translation;
  const translatable = TRANSLATABLE.has(block.block_type);
  const copy = (s: string, fallback: string, label: string) => {
    void copyText(s || fallback).then((ok) =>
      toast(ok ? `已复制${label}` : "复制失败，请长按文本手动复制")
    );
  };

  return (
    <>
      <div
        ref={ref}
        className="fixed z-50 w-[380px] max-w-[92vw] rounded-xl bg-white shadow-2xl border border-neutral-200 p-4"
        style={{ left: adj.left, top: adj.top }}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-neutral-400">
            第 {block.page_number} 页 · {TYPE_LABEL[block.block_type] ?? block.block_type}
          </span>
          <button className="text-neutral-400 hover:text-neutral-600 leading-none" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>

        {t?.status === "failed" && (
          <div className="mb-2 rounded bg-red-50 border border-red-100 px-2 py-1.5 text-xs text-red-600">
            翻译失败：{t.error ?? "未知错误"}
          </div>
        )}
        {t?.status === "done" && (
          <p className="text-sm text-neutral-800 leading-relaxed max-h-32 overflow-auto thin-scroll mb-3">
            {t.text}
          </p>
        )}
        {!translatable && (
          <p className="text-xs text-neutral-400 mb-3">
            此区域保留原版。点击「区域识别翻译」查看裁剪，翻译图片文字或表格。
          </p>
        )}

        <div className="grid grid-cols-2 gap-1.5">
          {translatable && !isMirror() && (
            <button className="pop-btn pop-btn-primary" onClick={onRetranslate} title="按当前术语表与翻译服务重译此段">
              <IconRefresh size={14} /> 重译此段
            </button>
          )}
          {!isMirror() && (
            <button className="pop-btn" onClick={onRegion} title="框选此区域，OCR 或视觉识别后翻译">
              <IconCrop size={14} /> 区域识别翻译
            </button>
          )}
          <button className="pop-btn" onClick={onHighlightNote} title="整段高亮，并弹出附注框写批注">
            <IconHighlight size={14} /> 高亮并附注
          </button>
          <button className="pop-btn" onClick={onNote} title="保存为独立笔记，可从笔记面板跳回">
            <IconNote size={14} /> 加入笔记
          </button>
          {t?.status === "done" && (
            <button className="pop-btn" onClick={() => copy(t.text, block.text, "译文")}>
              <IconCopy size={14} /> 复制译文
            </button>
          )}
          <button className="pop-btn" onClick={() => copy(block.text, "", "原文")}>
            <IconCopy size={14} /> 复制原文
          </button>
        </div>
      </div>
    </>
  );
}
