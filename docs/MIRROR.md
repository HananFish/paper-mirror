# 平板镜像站（可选）

镜像站把电脑上已经翻译好的文献导出成纯静态网页，部署到任意静态托管后，平板、
手机或另一台电脑无需连接家中主机即可继续阅读、划选和记笔记。批注默认保存在
浏览器本地，也可以自动回流到电脑上的完整版。

适合的场景：

- 在平板或手机上读论文、做批注，不必一直开着家里的电脑。
- 把一批已经校对的译文和批注作为只读副本分享给同组同学（**先确认你有权分享**）。

镜像站是**只读发布**：不能导入新 PDF、调用翻译服务、重新解析或修改术语表。
需要这些操作时回到连接电脑的完整版。

## 工作方式

~~~text
电脑完整版（FastAPI + SQLite）
  │  scripts/publish_site.py
  ▼
site/  静态站点：frontend/dist + data/*.json + 原始/批注版 PDF
  │  wrangler pages deploy
  ▼
平板浏览器 ── 阅读、划选、批注（localStorage）
  │  自动推送 / 导出 JSON
  ▼
Cloudflare Pages Functions + KV（可选）
  │  scripts/sync_mirror.py 或后台每分钟拉取
  ▼
电脑完整版合并（按内容指纹去重，不覆盖已有记录）
~~~

前端会探测 `/api/documents`：返回 JSON 时进入完整模式，否则进入镜像模式。
同一套构建产物因此既能由 FastAPI 托管，也能直接放在静态托管上。

## 1. 发布

先构建前端，再导出文献：

~~~sh
npm --prefix frontend run build
python scripts/publish_site.py
~~~

默认发布所有状态为 `ready` 的文献。也可以只发布指定文献，或输出到其他目录：

~~~sh
python scripts/publish_site.py --doc 1 --doc 4
python scripts/publish_site.py --out mysite
python scripts/publish_site.py --skip-annotated
~~~

产物结构：

~~~text
site/
  index.html, assets/           前端构建副本
  data/library.json             文献清单与 published_at 版本号
  data/doc-{id}.json            文档信息、段落、译文、批注、笔记
  data/{id}.pdf                 原始 PDF
  data/{id}-annotated.pdf       发布时烘焙的高亮批注版 PDF
  data/sync.json                自动同步配置（仅在 .env 配置后生成）
~~~

发布时会去掉本机绝对路径（`file_path`）和错误详情，避免公开站点泄露用户名和
目录结构。**笔记、批注和高亮会原样发布**，发布前请确认内容可以公开。

本地预览：

~~~sh
python scripts/serve_site.py --dir site --port 8010
~~~

打开 `http://127.0.0.1:8010/`。预览服务器补上了 Windows 常见的 `.mjs` MIME 映射，
避免 PDF.js worker 被当成二进制拒载。

## 2. 部署到 Cloudflare Pages

仓库根目录的 `wrangler.toml` 已经指向 `site/` 作为构建输出目录：

~~~sh
npx wrangler pages deploy site --branch main --commit-dirty=true
~~~

首次使用自己的账号时，需要把 `wrangler.toml` 里的 `name` 和 KV `id` 换成自己的：

~~~sh
npx wrangler kv namespace create MIRROR_SYNC
# 把输出的 id 填进 wrangler.toml
npx wrangler pages secret put SYNC_SECRET --project-name <你的项目名>
~~~

`SYNC_SECRET` 只需要在 Pages 项目里设置一次；`functions/sync.js` 和
`functions/sync/[id].js` 会随 `pages deploy` 一起上传。

也可以使用 GitHub Pages、Netlify、对象存储等静态托管：阅读、批注和导出 JSON
仍然可用，但自动推送需要 Pages Functions，其他平台需要自己实现同等的
`GET/POST/DELETE /sync` 接口。当前构建使用根路径资源，部署在子路径
（例如 `https://name.github.io/paper-mirror/`）需要自行调整 Vite `base`。

## 3. 在平板上使用

1. 打开镜像站地址，进入文献库。
2. 阅读器只保留阅读、划选、高亮、附注、笔记和导出；翻译与解析按钮会隐藏。
3. 批注与笔记写入浏览器 `localStorage`，刷新或重新打开不会丢失。
4. 首次打开会把发布内容播种到本地；发布版本更新且本地没有改动时自动跟随新版本。
5. 「导出 → 平板批注备份」可下载 JSON，带回电脑合并。

镜像站的批注 ID 使用负数，不会与电脑数据库的自增 ID 冲突；合并时按
「页码 + 类型 + 目标 + 矩形 + 文本 + 颜色」判断重复，不会重复写入。

## 4. 批注回流电脑

### 自动同步（推荐）

在电脑的 `.env` 中配置：

~~~sh
MIRROR_SYNC_URL=https://<你的站点域名>
MIRROR_SYNC_SECRET=<与 Pages 项目一致的密钥>
~~~

重新运行 `scripts/publish_site.py` 后，`data/sync.json` 会随站点发布，平板端在
批注变化后约 4 秒推送整包到 KV。

电脑端有两种拉取方式：

- 完整版启动时自动启用后台拉取：每 60 秒请求一次 `/sync`，合并新增记录。
- 手动运行：`python scripts/sync_mirror.py`，支持 `--doc` 和 `--purge`。

自动拉取只在默认 `data/` 目录下启用；显式设置 `APP_DATA_DIR`（测试或隔离环境）
时会跳过网络访问，请手动运行 `scripts/sync_mirror.py`。

### 手动导入

在完整版的文献库点击「导入平板批注」，选择平板导出的 JSON。适用于没有配置
Cloudflare、或者只想偶尔合并一次的情况。

## 5. 安全边界

| 项目 | 说明 |
| --- | --- |
| 站点内容 | 公开 URL。论文、译文、批注、笔记任何拿到链接的人都能读取 |
| 同步密钥 | 为了平板能直接推送，密钥会写进公开的 `data/sync.json`；知道地址的人可以伪造批注 |
| 影响范围 | 伪造批注只会污染云端批注包，不会在电脑上执行代码或改写论文文件 |
| 建议 | 用 Cloudflare Access 给站点加邮箱验证；不要发布无权公开的论文；定期 `--purge` 清理云端包 |
| 数据备份 | `site/` 不是备份。完整备份仍是停止应用后复制整个数据目录 |

KV 免费额度每天约 1000 次写入；单人阅读远远够用。整包推送上限 1 MiB，
批注很多时前端会退化为普通请求（不使用 `keepalive`），由防抖计时器重试。

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| 打开站点仍是完整版界面 | 检查静态托管是否把未知路径回退成 `index.html`；`/api/documents` 必须返回非 JSON |
| 平板批注没有自动同步 | 确认 `data/sync.json` 已发布、`SYNC_SECRET` 与 Pages 项目一致；查看浏览器控制台 |
| 电脑拉取提示 401 | `.env` 中的 `MIRROR_SYNC_SECRET` 与 Pages 的 `SYNC_SECRET` 不一致 |
| 电脑拉取提示 404 | 云端有本机已删除的文献；单篇失败会跳过，其余继续合并 |
| 批注版 PDF 404 | 发布时 `--skip-annotated`，或该篇烘焙失败；重新发布即可 |
| 页面资源 404 | 静态托管根路径不对，或没有部署 `assets/` 与 `data/` 目录 |

相关实现：`frontend/src/mirrorStore.ts`、`scripts/publish_site.py`、
`scripts/sync_mirror.py`、`functions/sync.js`。
