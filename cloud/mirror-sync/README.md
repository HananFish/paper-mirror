# 早期独立 Worker（已弃用）

`cloud/mirror-sync/` 是最初的 Cloudflare Worker + KV 同步实现。2026-10-12 起，
同步接口已迁移到镜像站自身域名下的 Pages Functions（仓库根目录 `functions/`），
平板推送和电脑拉取都访问同一站点，不再依赖 `workers.dev`。

当前部署与使用步骤见 [docs/MIRROR.md](../../docs/MIRROR.md)。

保留此目录只为参考早期实现；新部署不需要它。若 Cloudflare 账号里仍有同名
Worker，可以在控制台删除。
