import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocInfo, SearchHit, api } from "../api";
import { isMirror } from "../mirrorStore";
import { Marked } from "../components/SidePanel";
import { toast } from "../components/Toaster";
import { IconBook, IconChevronRight, IconDoc, IconInbox, IconSearch, IconUpload } from "../components/icons";

import InkHero, { InkBackdrop } from "../components/InkHero";

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; dot: string }> = {
    ready: { label: "就绪", dot: "bg-emerald-500" },
    parsing: { label: "解析中", dot: "bg-blue-500 animate-pulse" },
    translating: { label: "翻译中", dot: "bg-blue-500 animate-pulse" },
    parse_failed: { label: "解析失败", dot: "bg-red-500" },
    uploaded: { label: "待解析", dot: "bg-stone-400" },
  };
  const s = map[status] ?? { label: status, dot: "bg-stone-400" };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-stone-600">
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function ProgressBar({ progress, status }: { progress: DocInfo["progress"]; status: string }) {
  const { total_blocks, translated, failed } = progress;
  if (total_blocks === 0) return <span className="text-xs text-stone-400">—</span>;
  const pct = Math.round((translated / total_blocks) * 100);
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-0.5 w-20 overflow-hidden rounded-full bg-stone-200/80">
        <div
          className={`h-full rounded-full transition-all duration-500 ${failed > 0 ? "bg-amber-500" : "bg-stone-600"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-stone-500">
        {translated}/{total_blocks}
        {failed > 0 && <span className="text-red-600"> · {failed} 失败</span>}
      </span>
      {status === "translating" && <span className="text-[11px] text-stone-400">…</span>}
    </div>
  );
}

type SortKey = "updated" | "created" | "name" | "progress";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "最近更新" },
  { key: "created", label: "最近导入" },
  { key: "name", label: "文件名" },
  { key: "progress", label: "翻译进度" },
];

export default function Library() {
  const [docs, setDocs] = useState<DocInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  // 导航悬浮态：滚过首屏后加磨砂底
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (openMenu === null) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-library-menu]')) setOpenMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [openMenu]);
  const fileRef = useRef<HTMLInputElement>(null);
  const mirrorFileRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const aliveRef = useRef(true);
  const refreshVersion = useRef(0);

  // 文件名筛选 + 排序
  const [filter, setFilter] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("updated");

  // 跨文档全文搜索（Enter 触发）
  const [globalHits, setGlobalHits] = useState<SearchHit[] | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const result = await api.listDocuments();
      if (aliveRef.current && version === refreshVersion.current) setDocs(result);
    } catch (e) {
      if (aliveRef.current && version === refreshVersion.current) setError(String(e));
    } finally {
      if (aliveRef.current && version === refreshVersion.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    return () => { aliveRef.current = false; ++refreshVersion.current; };
  }, [refresh]);

  const hasBusyDocs = docs.some((d) => ["parsing", "translating"].includes(d.status));
  useEffect(() => {
    if (!hasBusyDocs) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [hasBusyDocs, refresh]);

  const upload = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        setError("仅支持 PDF 文件");
        return;
      }
      setUploading(true);
      setError("");
      try {
        await api.upload(file);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setUploading(false);
      }
    },
    [refresh]
  );

  const remove = async (id: number) => {
    if (!window.confirm("删除该文献及其全部译文与批注？")) return;
    try {
      const result = await api.remove(id);
      toast(result.warning || "已删除");
      await refresh();
    } catch (e) { setError(String(e)); }
  };

  const importGuide = async () => {
    setUploading(true); setError("");
    try {
      const doc = await api.importGuide();
      window.location.hash = `/read/${doc.id}`;
    } catch (e) { setError(String(e)); }
    finally { setUploading(false); }
  };

  // 平板镜像站导出的批注备份合并进本机文献库
  const importMirrorFile = async (file: File) => {
    setError("");
    try {
      const bundle = JSON.parse(await file.text()) as { document_id?: number; annotations?: unknown[]; notes?: unknown[] };
      const docId = Number(bundle.document_id);
      if (!docId || !Array.isArray(bundle.annotations)) throw new Error("不是平板批注备份文件");
      const r = await api.importMirrorBundle(docId, { annotations: bundle.annotations, notes: bundle.notes || [] });
      toast(`已合并批注 ${r.added_annotations} 条、笔记 ${r.added_notes} 条（跳过重复 ${r.skipped_annotations + r.skipped_notes} 条）`);
    } catch (e) { setError(String(e)); }
  };

  const reparse = async (id: number) => {
    if (!window.confirm("重新解析会重建段落并清空当前译文，批注和笔记会保留。继续？")) return;
    try {
      await api.reparse(id);
      toast("已开始重新解析");
      await refresh();
    } catch (e) { setError(String(e)); }
  };

  const runGlobalSearch = useCallback(async () => {
    const q = filter.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError("");
    try {
      const hits = await api.search(q);
      setGlobalQuery(q);
      setGlobalHits(hits);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }, [filter]);

  const visibleDocs = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    let list = kw && !globalHits ? docs.filter((d) => d.filename.toLowerCase().includes(kw)) : docs;
    list = [...list];
    switch (sortBy) {
      case "created":
        list.sort((a, b) => b.created_at.localeCompare(a.created_at));
        break;
      case "name":
        list.sort((a, b) => a.filename.localeCompare(b.filename));
        break;
      case "progress":
        list.sort((a, b) => {
          const pa = a.progress.total_blocks ? a.progress.translated / a.progress.total_blocks : -1;
          const pb = b.progress.total_blocks ? b.progress.translated / b.progress.total_blocks : -1;
          return pb - pa;
        });
        break;
      default:
        list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return list;
  }, [docs, filter, sortBy, globalHits]);

  // 全文搜索结果按文档分组
  const groupedHits = useMemo(() => {
    if (!globalHits) return [];
    const m = new Map<number, { filename: string; hits: SearchHit[] }>();
    for (const h of globalHits) {
      const g = m.get(h.document_id) ?? { filename: h.doc_filename, hits: [] };
      g.hits.push(h);
      m.set(h.document_id, g);
    }
    return [...m.entries()];
  }, [globalHits]);

  // 监听挂载变化，覆盖筛选清空和首次导入后新出现的区块。
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === 'undefined') {
      root.classList.add('reveal-unavailable');
      return;
    }
    const observed = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.06 }
    );
    const observe = () => {
      for (const el of observed) if (!root.contains(el)) { io.unobserve(el); observed.delete(el); }
      root.querySelectorAll('[data-reveal]').forEach(el => {
        if (!observed.has(el)) { observed.add(el); io.observe(el); }
      });
    };
    observe();
    const changes = new MutationObserver(observe);
    changes.observe(root, { childList: true, subtree: true });
    return () => { changes.disconnect(); io.disconnect(); };
  }, []);

  return (
    <div
      className="library-shell"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (isMirror()) { toast("镜像站只读：请在连接电脑的完整版中导入 PDF"); return; }
        const f = e.dataTransfer.files?.[0];
        if (f) upload(f);
      }}
    >
      <InkBackdrop />
      <div className="library-grain" aria-hidden="true" />
      <header className={`library-header ${scrolled ? "is-scrolled" : ""}`}>
        <div className="library-header-inner">
          <a href="#/" className="library-brand" aria-label="paper-mirror · 译镜首页">
            <span className="library-mark"><IconBook size={21} /></span>
            <span>译镜<span className="library-brand-en">PAPER MIRROR</span></span>
          </a>
          {!isMirror() && (
            <>
              <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
                onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
              <input ref={mirrorFileRef} type="file" accept=".json,application/json" className="hidden"
                onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importMirrorFile(file); }} />
            </>
          )}
          <nav className="library-nav" aria-label="书库操作">
            {!isMirror() && (
              <>
                <button className="library-guide-link" aria-label="打开使用说明书" disabled={uploading} onClick={importGuide}>使用指南</button>
                <button className="library-guide-link" aria-label="合并平板导出的批注备份" disabled={uploading} onClick={() => mirrorFileRef.current?.click()}>导入平板批注</button>
                <button className="btn btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  <IconUpload size={15} />{uploading ? '上传中…' : '导入 PDF'}
                </button>
              </>
            )}
            {isMirror() && <span className="library-guide-link" title="由电脑端发布生成；批注保存在本机浏览器，可在阅读器导出备份">镜像浏览 · 批注存于本机</span>}
          </nav>
        </div>
      </header>
      <main ref={mainRef} className="library-main">
        <InkHero />
        <section id="library" className="library-section" aria-label="文献书库">
        <div className="library-section-heading" data-reveal><h2>文献书库</h2><span>{docs.length ? `${docs.length} 篇文献` : '从一篇论文开始'}</span></div>

        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        {docs.length > 0 && (
          <div className="library-tools" data-reveal>
            <div className="library-search">
              <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                className="library-search-input"
                placeholder="搜索文献，回车检索全文"
                aria-label="筛选文件名或全文搜索"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setGlobalHits(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runGlobalSearch();
                  if (e.key === "Escape") {
                    setFilter("");
                    setGlobalHits(null);
                  }
                }}
              />
            </div>
            {globalHits && (
              <button
                className="h-9 rounded-lg border border-stone-200 bg-white px-3 text-xs text-stone-600 hover:bg-stone-50"
                onClick={() => {
                  setFilter("");
                  setGlobalHits(null);
                }}
              >
                返回全部文献
              </button>
            )}
            <select
              className="library-sort"
              value={sortBy}
              aria-label="文献排序"
              onChange={(e) => setSortBy(e.target.value as SortKey)}
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {!loaded ? <div role="status" className="library-empty">正在加载文献…</div> : globalHits ? (
          <div className="space-y-5">
            <p className="text-sm text-stone-600">
              全文搜索「<span className="font-medium text-stone-900">{globalQuery}</span>」：
              {searching ? "搜索中…" : `${globalHits.length} 条结果`}
            </p>
            {!searching && globalHits.length === 0 && (
              <div className="rounded-xl border border-dashed border-stone-200 py-12 text-center text-sm text-stone-400">
                没有匹配的原文或译文
              </div>
            )}
            {groupedHits.map(([docId, g]) => (
              <div key={docId} className="library-result">
                <div className="mb-2 flex items-center gap-2">
                  <IconDoc size={15} className="text-stone-400" />
                  <a href={`#/read/${docId}`} className="text-sm font-medium text-stone-900 hover:text-indigo-700">
                    {g.filename}
                  </a>
                  <span className="text-[11px] text-stone-400">{g.hits.length} 条</span>
                </div>
                <div className="space-y-1">
                  {g.hits.map((h, i) => (
                    <a
                      key={`${h.block_id}-${h.kind}-${i}`}
                      href={`#/read/${docId}?page=${h.page_number}&block=${h.block_id}`}
                      className="block rounded-lg px-2 py-1.5 text-xs leading-relaxed text-stone-600 hover:bg-stone-50"
                    >
                      <span className={`mr-2 rounded px-1 text-[10px] ${h.kind === "translation" ? "bg-indigo-50 text-indigo-500" : "bg-stone-100 text-stone-500"}`}>
                        {h.kind === "translation" ? "译文" : "原文"}
                      </span>
                      <span className="text-stone-400">第 {h.page_number} 页 · </span>
                      <Marked text={h.snippet} query={globalQuery} />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : docs.length === 0 ? (
          isMirror() ? (
            <div className="library-empty" style={{ cursor: "default" }}>
              <span className="library-empty-icon"><IconDoc size={28} /></span>
              <span className="text-sm font-medium">镜像站暂无文献</span>
              <span className="text-xs">在电脑端导入并翻译后，运行 scripts/publish_site.py 发布到这里</span>
            </div>
          ) : (
          <button
            className="library-empty"
            onClick={() => fileRef.current?.click()}
          >
            <span className="library-empty-icon">
              <IconUpload size={28} />
            </span>
            <span className="text-sm font-medium">导入第一篇论文 PDF</span>
            <span className="text-xs">拖入文件，开始原文与译文的对照阅读</span>
          </button>
          )
        ) : visibleDocs.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-stone-200 py-16 text-center text-sm text-stone-400">
            没有匹配「{filter}」的文献
          </div>
        ) : (
          <div className="library-list" data-reveal>
            {visibleDocs.map((d) => (
              <div key={d.id} className="library-row">
                <span className="library-document-icon" aria-hidden="true"><IconDoc size={23} /><span>PDF</span></span>
                <div className="library-document">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <a href={`#/read/${d.id}`} title={d.filename} className="truncate text-[14px] font-medium text-stone-900 hover:text-stone-600">
                      {d.filename}
                    </a>
                    <StatusChip status={d.status} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-xs text-stone-400">
                    {d.page_count > 0 && <span>{d.page_count} 页</span>}
                    <span>{new Date(d.created_at).toLocaleDateString()}</span>
                    {d.status === "parse_failed" && d.error && (
                      <span className="truncate text-red-500">{d.error}</span>
                    )}
                  </div>
                </div>

                <div className="library-progress">
                  <ProgressBar progress={d.progress} status={d.status} />
                </div>

                <div className="library-actions">
                  <a href={`#/read/${d.id}`} className="library-read">阅读<IconChevronRight size={14} /></a>
                  {!isMirror() && (
                  <div className="relative" data-library-menu>
                    <button className="library-menu-trigger" aria-label={`更多操作：${d.filename}`} aria-expanded={openMenu === d.id}
                      aria-controls={`document-menu-${d.id}`} onClick={() => setOpenMenu(openMenu === d.id ? null : d.id)}>
                      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                    </button>
                    {openMenu === d.id && <div id={`document-menu-${d.id}`} className="library-menu">
                      <button onClick={() => { setOpenMenu(null); void reparse(d.id); }}>重新解析</button>
                      <button className="text-red-700" onClick={() => { setOpenMenu(null); void remove(d.id); }}>删除文献</button>
                    </div>}
                  </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <footer className="library-footer"><span>让文字相映，让思考沉淀。</span>{!isMirror() && <a href="/api/documents/sample.pdf" download="UserGuide.pdf">下载说明书<IconChevronRight size={12} /></a>}</footer>
        </section>

        {uploading && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/20 backdrop-blur-[2px]">
            <div className="card pop-in px-8 py-6 text-center">
              <div className="text-sm font-medium text-stone-700">正在上传与解析…</div>
              <div className="mt-1 text-xs text-stone-400">大文件需要一点时间</div>
            </div>
          </div>
        )}
        {dragging && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-indigo-600/10 backdrop-blur-[1px]">
            <div className="rounded-2xl border-2 border-dashed border-indigo-400 bg-white/90 px-16 py-10 text-center text-indigo-500">
              <IconInbox size={36} className="mx-auto" />
              <div className="mt-2 text-sm font-medium text-indigo-700">松开即可导入</div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
