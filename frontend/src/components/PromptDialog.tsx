import { useEffect, useRef, useState } from "react";
import { IconClose } from "./icons";

export interface PromptSpec {
  title: string;
  initial?: string;
  placeholder?: string;
  okText?: string;
  /** 传入时校验失败则不关闭；返回错误文案 */
  validate?: (text: string) => string | null;
  onOk: (text: string) => void;
  onCancel?: () => void;
}

/** 轻量文字输入对话框：替代 window.prompt，支持多行、Ctrl+Enter 提交、Esc 取消。 */
export function PromptDialog({ spec }: { spec: PromptSpec }) {
  const [text, setText] = useState(spec.initial ?? "");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const cancel = () => {
    spec.onCancel?.();
  };
  const ok = () => {
    const v = spec.validate?.(text);
    if (v) {
      setErr(v);
      return;
    }
    spec.onOk(text);
  };

  return (
    <div className="fade-in fixed inset-0 z-[70] flex items-center justify-center bg-stone-900/25 p-4 backdrop-blur-[2px]" onClick={cancel}>
      <div
        className="modal-in w-[420px] max-w-full rounded-2xl border border-stone-200/70 bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-stone-900">{spec.title}</h2>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            onClick={cancel}
          >
            <IconClose size={15} />
          </button>
        </div>
        <textarea
          ref={ref}
          className="min-h-28 w-full resize-y rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 outline-none transition-colors focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          placeholder={spec.placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ok();
          }}
        />
        {err && <p className="mt-1.5 text-xs text-red-600">{err}</p>}
        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-stone-400">Ctrl + Enter 提交</span>
          <button className="btn btn-outline h-8" onClick={cancel}>
            取消
          </button>
          <button className="btn btn-primary h-8" onClick={ok}>
            {spec.okText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
