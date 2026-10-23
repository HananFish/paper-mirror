import { lazy, Suspense, useEffect, useState } from "react";
import Library from "./pages/Library";
const Reader = lazy(() => import("./pages/Reader"));
import { Toaster } from "./components/Toaster";

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const m = hash.match(/^#\/read\/(\d+)/);
  return (
    <>
      <Suspense fallback={<div className="p-6 text-stone-500">加载阅读器…</div>}>
        {m ? <Reader key={hash} docId={Number(m[1])} /> : <Library />}
      </Suspense>
      <Toaster />
    </>
  );
}
