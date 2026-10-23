/**
 * 镜像模式：站点静态托管（Cloudflare Pages / GitHub Pages 等）时没有 /api 后端。
 * 探测到后端缺失即切换为镜像：文献与译文来自发布时烘焙的 data/*.json，
 * 批注与笔记存浏览器 localStorage（可导出 JSON 带回电脑合并）。
 * 同一套前端接上家中后端时自动回到完整模式。
 */
import type { AnnotationOut, DocInfo, NoteOut, SearchHit } from "./api";
import { toast } from "./components/Toaster";

export type SiteKind = "full" | "mirror";
let kind: SiteKind | "pending" = "pending";
let detecting: Promise<SiteKind> | null = null;

function setKind(value: SiteKind) {
  kind = value;
}

/** 探测后端是否存在：/api/documents 必须返回 JSON（静态托管会回退成 HTML/404）。 */
export function resolveSiteKind(): Promise<SiteKind> {
  if (kind !== "pending") return Promise.resolve(kind);
  detecting ??= (async () => {
    try {
      const res = await fetch("/api/documents", { headers: { accept: "application/json" } });
      const type = res.headers.get("content-type") || "";
      // 只要后端返回 JSON 就是完整模式：401/403 说明需要配对令牌，
      // 500 说明后端有错误；这些都应显示真实错误，而不是误判成只读镜像。
      if (type.includes("json")) {
        setKind("full");
        return "full" as const;
      }
    } catch {
      /* 静态托管下不可达 */
    }
    setKind("mirror");
    return "mirror" as const;
  })();
  return detecting;
}

export function siteKind(): SiteKind | "pending" {
  return kind;
}

/** 镜像数据是否已可用（组件在数据加载完成后再读，此时探测必已完成）。 */
export function isMirror(): boolean {
  return kind === "mirror";
}

interface DocBundle {
  document: DocInfo;
  blocks: unknown[];
  annotations: AnnotationOut[];
  notes: NoteOut[];
}

const docCache = new Map<number, DocBundle>();
const localStore = new Map<number, { annotations: AnnotationOut[]; notes: NoteOut[]; seededAt: string }>();

function storeKey(docId: number) {
  return `paper-mirror:doc:${docId}`;
}

/** localStorage 在隐私模式或配额耗尽时会抛异常；失败时保留内存状态。 */
function writeLocal(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function publishedAt(): string {
  try {
    return String(JSON.parse(readLocal("paper-mirror:library") || "{}").published_at || "");
  } catch {
    return "";
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`加载失败：${url}（HTTP ${res.status}）`);
  return res.json() as Promise<T>;
}

async function libraryManifest(): Promise<{ published_at: string; documents: DocInfo[] }> {
  const manifest = await fetchJson<{ published_at: string; documents: DocInfo[] }>("./data/library.json");
  // 记下发布版本，供 seededLocal 判断是否需要跟随新版本
  writeLocal("paper-mirror:library", JSON.stringify(manifest));
  return manifest;
}

async function loadDoc(docId: number): Promise<DocBundle> {
  const cached = docCache.get(docId);
  if (cached) return cached;
  const bundle = await fetchJson<DocBundle>(`./data/doc-${docId}.json`);
  docCache.set(docId, bundle);
  return bundle;
}

/** 首次打开时把发布内容播种进本地存储；之后的批注/笔记完全本地化。 */
function seededLocal(docId: number, bundle: DocBundle): { annotations: AnnotationOut[]; notes: NoteOut[]; seededAt: string } {
  const raw = readLocal(storeKey(docId));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { annotations: AnnotationOut[]; notes: NoteOut[]; seededAt: string };
      if (parsed.seededAt === publishedAt()) return parsed;
      // 发布版本更新：本地与发布内容完全一致（没有新改动）时静默跟随新版本
      const untouched =
        JSON.stringify(parsed.annotations) === JSON.stringify(bundle.annotations) &&
        JSON.stringify(parsed.notes) === JSON.stringify(bundle.notes);
      if (untouched) {
        try {
          localStorage.removeItem(storeKey(docId));
        } catch {
          /* 隐私模式下忽略 */
        }
      } else {
        return parsed; // 有本地改动：保留，稍后由导出流程带回家
      }
    } catch {
      /* 损坏则重新播种 */
    }
  }
  const fresh = { annotations: bundle.annotations, notes: bundle.notes, seededAt: publishedAt() };
  writeLocal(storeKey(docId), JSON.stringify(fresh));
  return fresh;
}

function localState(docId: number, bundle: DocBundle) {
  let state = localStore.get(docId);
  if (!state) {
    state = seededLocal(docId, bundle);
    localStore.set(docId, state);
  }
  return state;
}

function persist(docId: number) {
  const state = localStore.get(docId);
  if (state) {
    writeLocal(storeKey(docId), JSON.stringify(state));
    scheduleSync(docId);
  }
}

// ---- 自动同步：批注变更防抖推送到云端中转（配置来自发布时烘焙的 data/sync.json）----
interface SyncConfig {
  url: string;
  secret: string;
}
let syncConfig: SyncConfig | null | undefined; // undefined = 尚未加载
const syncTimers = new Map<number, number>();
let syncFailNotified = false;

async function loadSyncConfig(): Promise<SyncConfig | null> {
  if (syncConfig !== undefined) return syncConfig;
  try {
    const res = await fetch("./data/sync.json", { cache: "no-cache" });
    const body = res.ok ? ((await res.json()) as SyncConfig) : null;
    syncConfig = body && body.url && body.secret ? body : null;
  } catch {
    syncConfig = null;
  }
  return syncConfig;
}

function scheduleSync(docId: number) {
  if (siteKind() !== "mirror") return;
  window.clearTimeout(syncTimers.get(docId));
  syncTimers.set(docId, window.setTimeout(() => {
    syncTimers.delete(docId);
    void flushSync(docId);
  }, 4000));
}

/** 立即推送某篇文献的本地批注包（供防抖计时器与页面隐藏兜底调用）。 */
export async function flushSync(docId: number): Promise<void> {
  const config = await loadSyncConfig();
  const state = localStore.get(docId);
  if (!config || !state) return;
  const bundle = docCache.get(docId);
  const body = JSON.stringify({
    document_id: docId,
    filename: bundle?.document.filename || "",
    annotations: state.annotations,
    notes: state.notes,
  });
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/sync/${docId}`, {
      method: "POST",
      // keepalive 的请求体在浏览器里通常上限 64 KiB；批注多时退化为普通请求，
      // 由 pagehide/visibilitychange 之外的防抖计时器负责重试。
      keepalive: new Blob([body]).size < 60_000,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}` },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeLocal(`paper-mirror:sync:${docId}`, new Date().toISOString());
  } catch {
    // 静默失败保留待推送状态：下次变更或刷新会再试；只在首次失败时提醒
    if (!syncFailNotified) {
      syncFailNotified = true;
      toast("批注自动同步失败，稍后自动重试", "err");
    }
  }
}

function flushAllPending() {
  for (const [docId, timer] of [...syncTimers]) {
    window.clearTimeout(timer);
    syncTimers.delete(docId);
    void flushSync(docId);
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushAllPending);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAllPending();
  });
}

function nowIso() {
  return new Date().toISOString();
}

function nextId(records: { id: number }[]) {
  return records.reduce((min, r) => Math.min(min, r.id), 0) - 1;
}

async function readBody<T>(init?: RequestInit): Promise<T> {
  if (!init?.body) return {} as T;
  return JSON.parse(String(init.body)) as T;
}

/** 把镜像的 URL 空间路由到静态数据或 localStorage，维持与后端相同的请求/响应形状。 */
export async function mirrorFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const fail = (message: string): never => { throw new Error(message); };
  let m = url.match(/^\/api\/documents\/(\d+)(?:\/(blocks|annotations|notes|file|last-page)(?:\/(-?\d+))?)?$/);
  if (m) {
    const docId = Number(m[1]);
    const bundle = await loadDoc(docId);
    const section = m[2];
    if (!section) {
      if (method !== "GET") fail("镜像站为只读");
      const lastPage = Number(readLocal(`paper-mirror:lastpage:${docId}`) || 0);
      return { ...bundle.document, ...(lastPage ? { last_page: lastPage } : {}) } as T;
    }
    if (section === "blocks") return bundle.blocks as T;
    if (section === "last-page") {
      const body = await readBody<{ last_page?: number }>(init);
      writeLocal(`paper-mirror:lastpage:${docId}`, String(body.last_page || 1));
      return { last_page: body.last_page } as T;
    }
    if (section !== "annotations" && section !== "notes") fail("镜像站不支持此操作");
    const state = localState(docId, bundle);
    const collection = section === "annotations" ? state.annotations : state.notes;
    const recordId = m[3] ? Number(m[3]) : null;
    if (method === "GET") return collection as T;
    if (method === "POST") {
      const body = await readBody<Record<string, unknown>>(init);
      const record = {
        ...body,
        id: nextId(collection),
        document_id: docId,
        created_at: nowIso(),
        updated_at: nowIso(),
      } as unknown as AnnotationOut & NoteOut;
      collection.push(record);
      persist(docId);
      return record as T;
    }
    const index = collection.findIndex((r) => r.id === recordId);
    if (index < 0) fail("记录不存在（可能发布版本已更新）");
    if (method === "PATCH") {
      const body = await readBody<Record<string, unknown>>(init);
      collection[index] = { ...collection[index], ...body, id: collection[index].id, document_id: docId, updated_at: nowIso() };
      persist(docId);
      return collection[index] as T;
    }
    if (method === "DELETE") {
      collection.splice(index, 1);
      persist(docId);
      return { deleted: recordId } as T;
    }
    fail("镜像站不支持此操作");
  }
  m = url.match(/^\/api\/documents$/);
  if (m) {
    const manifest = await libraryManifest();
    return manifest.documents as T;
  }
  m = url.match(/^\/api\/search\?q=(.+)$/);
  if (m && method === "GET") {
    const query = decodeURIComponent(m[1]).toLowerCase();
    const manifest = await libraryManifest();
    const hits: SearchHit[] = [];
    for (const doc of manifest.documents) {
      const bundle = await loadDoc(doc.id);
      for (const block of bundle.blocks as { id: number; page_number: number; reading_order: number; text: string; translation?: { status: string; text: string } | null }[]) {
        const at = block.text.toLowerCase().indexOf(query);
        if (at >= 0) {
          hits.push({ document_id: doc.id, doc_filename: doc.filename, block_id: block.id, page_number: block.page_number, kind: "source", snippet: block.text.slice(Math.max(0, at - 30), at + 80) });
        }
        if (block.translation?.status === "done") {
          const ti = block.translation.text.toLowerCase().indexOf(query);
          if (ti >= 0) {
            hits.push({ document_id: doc.id, doc_filename: doc.filename, block_id: block.id, page_number: block.page_number, kind: "translation", snippet: block.translation.text.slice(Math.max(0, ti - 30), ti + 80) });
          }
        }
        if (hits.length >= 400) return hits as T;
      }
    }
    return hits as T;
  }
  return fail("镜像站为只读浏览，此功能需要连接家中电脑使用");
}

/** 平板批注备份：下载 JSON，带回家中电脑用「导入平板批注」合并。 */
export function mirrorBundle(docId: number): Promise<{ document_id: number; filename: string; exported_at: string; annotations: AnnotationOut[]; notes: NoteOut[] }> {
  return loadDoc(docId).then((bundle) => {
    const state = localState(docId, bundle);
    return {
      document_id: docId,
      filename: bundle.document.filename,
      exported_at: nowIso(),
      annotations: state.annotations,
      notes: state.notes,
    };
  });
}
