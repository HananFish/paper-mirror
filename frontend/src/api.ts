import { readingRequest, replayReadingHistory } from './readingHistory';
import { mirrorBundle, mirrorFetch, resolveSiteKind, siteKind } from './mirrorStore';
// 后端 API 封装与类型
export interface DocProgress {
  total_blocks: number;
  translated: number;
  failed: number;
  running: number;
}

export interface DocInfo {
  id: number;
  last_page: number;
  filename: string;
  page_count: number;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  progress: DocProgress;
}

export interface BlockOut {
  id: number;
  page_number: number;
  block_type: "paragraph" | "heading" | "list" | "caption" | "reference" | "table" | "formula" | "image";
  bbox: [number, number, number, number];
  reading_order: number;
  text: string;
  font_size: number;
  metadata?: { rows?: string[][]; confidence?: number; rotation?: number; coordinate_space?: string; font_weight?: number; text_align?: 'left' | 'center'; line_count?: number };
  vision?: { status: string; text: string; error?: string };
  ocr?: {
    status: string;
    lines?: { pbox: number[]; src: string; dst: string; status?: string; confidence?: number; error?: string }[];
    warning?: string;
    completed?: number;
    total?: number;
    error?: string;
    captions?: { total: number; translated: number; failed: number; block_ids: number[]; error?: string | null };
  };
  translation: {
    text: string;
    status: "pending" | "running" | "done" | "failed";
    error: string | null;
    provider: string;
    model: string;
  } | null;
}

export interface TermOut {
  id: number;
  source: string;
  target: string;
  note: string;
}

export interface AppSettings {
  provider: "mock" | "openai";
  batch_size: number;
  target_lang: string;
  auto_translate: boolean;
  openai: { adapter?: string; base_url: string; model: string; api_key_env: string; protocol: "numbered" | "simple" };
  vision: { adapter?: string; base_url: string; model: string; api_key_env: string; protocol: "numbered" | "simple" };
}

export interface SearchHit {
  document_id: number;
  doc_filename: string;
  block_id: number;
  page_number: number;
  kind: "source" | "translation";
  snippet: string;
}

export interface AnnotationOut {
  id: number;
  document_id: number;
  block_id: number | null;
  page_number: number;
  kind: "highlight" | "underline" | "comment" | "note";
  target: string;
  bbox: number[];
  rects: number[][];
  selected_text: string;
  content: string;
  color: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface NoteOut {
  id: number;
  document_id: number;
  title: string;
  content: string;
  page_number: number | null;
  block_id: number | null;
  quote: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

async function rawReq<T>(url: string, init?: RequestInit): Promise<T> {
  // 静态托管（无后端）时自动落入镜像模式：数据来自发布产物，批注存浏览器本地
  if ((await resolveSiteKind()) === "mirror") return mirrorFetch<T>(url, init);
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

function req<T>(url: string, init?: RequestInit): Promise<T> {
  return readingRequest<T>(url, init, rawReq);
}

/** Fetch first so HTTP errors are visible, then download a named local blob. */
export async function downloadExport(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const body = await res.json(); detail = body.detail || detail; } catch { /* retain status */ }
    throw new Error(detail);
  }
  if (res.headers.get("content-type")?.includes("text/html")) throw new Error("导出接口返回了网页，请检查后端是否已重启");
  const blob = await res.blob();
  if (!blob.size) throw new Error("导出文件为空");
  const disposition = res.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl; link.download = filename; link.style.display = "none";
  document.body.appendChild(link);
  link.click(); link.remove();
  // Allow the browser download manager to consume the URL before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export const api = {
  undoReading: (id: number) => replayReadingHistory(id, 'undo', rawReq),
  redoReading: (id: number) => replayReadingHistory(id, 'redo', rawReq),
  importGuide: () => req<{ id: number }>("/api/documents/sample", { method: "POST" }),
  listDocuments: () => req<DocInfo[]>("/api/documents"),
  getDocument: (id: number) => req<DocInfo>(`/api/documents/${id}`),
  getBlocks: (id: number) => req<BlockOut[]>(`/api/documents/${id}/blocks`),
  recoverCaptions: (id: number) => req<{ recovered: number }>(`/api/documents/${id}/recover-captions`, {method: 'POST'}),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<DocInfo>("/api/documents", { method: "POST", body: fd });
  },
  remove: (id: number) => req<{ deleted: number; warning?: string }>(`/api/documents/${id}`, { method: "DELETE" }),
  reparse: (id: number) => req<{ started: boolean }>(`/api/documents/${id}/parse`, { method: "POST" }),
  translate: (id: number, body: { provider?: string; force?: boolean } = {}) =>
    req<{ started: boolean; provider: string }>(`/api/documents/${id}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ocrFigure: (docId: number, blockId: number) =>
    req<{ started: boolean }>(`/api/documents/${docId}/blocks/${blockId}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  setLastPage: (docId: number, lastPage: number) =>
    req<{ last_page: number }>(`/api/documents/${docId}/last-page`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_page: lastPage }),
    }),
  translateFigures: (docId: number) =>
    req<{ started: boolean }>(`/api/documents/${docId}/figures/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  retranslate: (blockId: number) =>
    req<{ started: boolean }>(`/api/blocks/${blockId}/retranslate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  fileUrl: (id: number) => (siteKind() === "mirror" ? `data/${id}.pdf` : `/api/documents/${id}/file`),
  exportJsonUrl: (id: number) => `/api/documents/${id}/export.json`,
  exportMdUrl: (id: number, mode: "bilingual" | "zh" | "source" = "bilingual") =>
    `/api/documents/${id}/export.md?mode=${mode}`,
  exportAnnotatedPdfUrl: (id: number) =>
    siteKind() === "mirror" ? `data/${id}-annotated.pdf` : `/api/documents/${id}/export-annotated.pdf`,
  /** 镜像站：导出平板上的批注/笔记为 JSON，带回家中电脑合并。 */
  mirrorBundle,
  /** 完整模式：把平板导出的批注备份合并进本机文献库。 */
  importMirrorBundle: (docId: number, payload: { annotations: unknown[]; notes: unknown[] }) =>
    req<{ added_annotations: number; skipped_annotations: number; added_notes: number; skipped_notes: number }>(
      `/api/documents/${docId}/import-mirror`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    ),
  search: (q: string) => req<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  terms: () => req<TermOut[]>("/api/terms"),
  addTerm: (source: string, target: string) =>
    req<TermOut>("/api/terms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, target }),
    }),
  deleteTerm: (id: number) => req<{ deleted: number }>(`/api/terms/${id}`, { method: "DELETE" }),
  settings: () => req<AppSettings>("/api/settings"),
  modelAdapters: () => req<Record<'text' | 'vision' | 'ocr' | 'layout', string[]>>("/api/model-adapters"),
  saveSettings: (patch: Partial<AppSettings>) =>
    req<AppSettings>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  annotations: (id: number) => req<AnnotationOut[]>(`/api/documents/${id}/annotations`),
  addAnnotation: (id: number, body: Partial<AnnotationOut>) =>
    req<AnnotationOut>(`/api/documents/${id}/annotations`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  updateAnnotation: (id: number, annotationId: number, body: Partial<AnnotationOut>) =>
    req<AnnotationOut>(`/api/documents/${id}/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteAnnotation: (id: number, annotationId: number) =>
    req<{ deleted: number }>(`/api/documents/${id}/annotations/${annotationId}`, { method: "DELETE" }),
  notes: (id: number) => req<NoteOut[]>(`/api/documents/${id}/notes`),
  addNote: (id: number, body: Partial<NoteOut>) =>
    req<NoteOut>(`/api/documents/${id}/notes`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  updateNote: (id: number, noteId: number, body: Partial<NoteOut>) =>
    req<NoteOut>(`/api/documents/${id}/notes/${noteId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  deleteNote: (id: number, noteId: number) =>
    req<{ deleted: number }>(`/api/documents/${id}/notes/${noteId}`, { method: "DELETE" }),
};

export const STATUS_LABEL: Record<string, string> = {
  uploaded: "待解析",
  parsing: "解析中",
  ready: "就绪",
  parse_failed: "解析失败",
  translating: "翻译中",
};
