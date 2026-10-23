/**
 * 镜像站批注同步（Pages Functions 版）：与站点同域，平板推送不依赖 workers.dev。
 * GET /sync → 列出云端已有批注包的文献；单篇操作在 functions/sync/[id].js。
 * KV 绑定 MIRROR_SYNC 与密钥 SYNC_SECRET 在 Pages 项目设置中配置。
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestGet({ request, env }) {
  const secret = env.SYNC_SECRET || "";
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || supplied !== secret) return json({ error: "unauthorized" }, 401);
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
