/**
 * 单篇文献的批注包读写：POST 整包覆盖（平板自动推送）、GET 读取（电脑拉取）、
 * DELETE 清除（sync_mirror.py --purge）。鉴权与数据校验与 Workers 版一致。
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequest({ request, env, params }) {
  const secret = env.SYNC_SECRET || "";
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || supplied !== secret) return json({ error: "unauthorized" }, 401);
  const docId = String(params.id || "");
  if (!/^\d+$/.test(docId)) return json({ error: "not found" }, 404);
  const key = `mirror:${docId}`;

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
      document_id: Number(docId),
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
    return json(raw ? JSON.parse(raw) : { document_id: Number(docId), filename: "", annotations: [], notes: [], pushed_at: null });
  }

  if (request.method === "DELETE") {
    await env.MIRROR_SYNC.delete(key);
    return json({ ok: true, deleted: Number(docId) });
  }

  return json({ error: "not found" }, 404);
}
