/**
 * paper-mirror 镜像站批注同步（Cloudflare Worker + KV）。
 *
 * 平板镜像站把本地批注/笔记整包推送到 KV；电脑端 scripts/sync_mirror.py
 * 拉取后走与手动导入相同的指纹去重合并。所有请求需携带
 * `Authorization: Bearer <SYNC_SECRET>`（wrangler secret put SYNC_SECRET）。
 *
 * 端点：
 *   POST  /sync/{docId}  整包覆盖存储（平板自动推送）
 *   GET   /sync/{docId}  读取某篇文献的云端批注包
 *   DELETE /sync/{docId} 清除某篇文献的云端包（--purge）
 *   GET   /sync          列出云端已有包的文献
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": env.SITE_ORIGIN || "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    } });

    const secret = env.SYNC_SECRET || "";
    const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!secret || supplied !== secret) return json({ error: "unauthorized" }, 401);

    // 浏览器推送必须来自镜像站本身；无 Origin 头的命令行拉取不受影响
    const siteOrigin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
    const origin = request.headers.get("origin");
    if (origin && siteOrigin && origin.replace(/\/$/, "") !== siteOrigin) {
      return json({ error: "cross-origin push rejected" }, 403);
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/sync\/(\d+)$/);
    if (match) {
      const key = `mirror:${match[1]}`;
      if (request.method === "POST") {
        if (Number(request.headers.get("content-length") || 0) > 1024 * 1024) {
          return json({ error: "payload too large" }, 413);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        if (!Array.isArray(body.annotations) || !Array.isArray(body.notes)) {
          return json({ error: "annotations and notes must be arrays" }, 400);
        }
        const stored = {
          document_id: Number(match[1]),
          filename: String(body.filename || ""),
          annotations: body.annotations,
          notes: body.notes,
          pushed_at: new Date().toISOString(),
        };
        await env.MIRROR_SYNC.put(key, JSON.stringify(stored));
        return json({ ok: true, stored_at: stored.pushed_at,
          annotations: stored.annotations.length, notes: stored.notes.length });
      }
      if (request.method === "GET") {
        const raw = await env.MIRROR_SYNC.get(key);
        return json(raw ? JSON.parse(raw) : { document_id: Number(match[1]), filename: "", annotations: [], notes: [], pushed_at: null });
      }
      if (request.method === "DELETE") {
        await env.MIRROR_SYNC.delete(key);
        return json({ ok: true, deleted: Number(match[1]) });
      }
    }

    if (url.pathname === "/sync" && request.method === "GET") {
      const list = await env.MIRROR_SYNC.list({ prefix: "mirror:" });
      const docs = [];
      for (const key of list.keys) {
        const raw = await env.MIRROR_SYNC.get(key.name);
        if (!raw) continue;
        const bundle = JSON.parse(raw);
        docs.push({
          document_id: bundle.document_id,
          filename: bundle.filename,
          pushed_at: bundle.pushed_at,
          annotations: bundle.annotations.length,
          notes: bundle.notes.length,
        });
      }
      return json({ docs });
    }

    return json({ error: "not found" }, 404);
  },
};
