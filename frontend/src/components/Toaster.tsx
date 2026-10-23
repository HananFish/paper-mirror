import { useEffect, useState } from "react";
import { IconCheck, IconWarning } from "./icons";

interface ToastItem {
  id: number;
  msg: string;
  kind: "ok" | "err";
}

type PushFn = (msg: string, kind?: "ok" | "err") => void;
let pushFn: PushFn = () => {};

/** 全局轻提示：任意组件内 `toast("已复制")` / `toast("失败原因", "err")`。 */
export function toast(msg: string, kind: "ok" | "err" = "ok") {
  pushFn(msg, kind);
}

/** 挂载在 App 根部一次即可。 */
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let seq = 0;
    pushFn = (msg, kind = "ok") => {
      const id = ++seq;
      setItems((s) => [...s.slice(-3), { id, msg, kind }]);
      window.setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 2400);
    };
    return () => {
      pushFn = () => {};
    };
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pop-in flex items-center gap-2 rounded-full px-4 py-2 text-[13px] text-white shadow-lg backdrop-blur ${
            t.kind === "err" ? "bg-red-600/95" : "bg-stone-900/90"
          }`}
        >
          {t.kind === "err" ? <IconWarning size={14} /> : <IconCheck size={14} />}
          {t.msg}
        </div>
      ))}
    </div>
  );
}
