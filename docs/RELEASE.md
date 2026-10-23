# GitHub 发布检查

## 本机验证

~~~sh
python scripts/setup.py --check-only
python scripts/check_public_repo.py
python scripts/run_tests.py
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend run test:browser
npm --prefix frontend run test:history
git diff --check
~~~

每次手册变更后重新生成 docs/UserGuide.pdf，并检查全部页面。公开演示截图使用隔离的生成样例，不使用个人文献库。

Windows PowerShell 可通过以下命令在浏览器回归中重建截图（生成样例库、人工演示译文，不调用真实服务）：

~~~powershell
$env:PUBLIC_SCREENSHOT_DIR = (Join-Path (Get-Location) 'docs/screenshots')
npm --prefix frontend run test:browser
Remove-Item Env:PUBLIC_SCREENSHOT_DIR
~~~

## 提交内容

提交源码、锁文件、安装脚本、AGENTS.md、README、文档、说明书、许可和 CI 配置。不提交 data/、.venv/、node_modules/、frontend/dist/、site/、.env、模型权重或测试临时文件。镜像站的同步密钥和 wrangler 本地状态（cloud/**/.dev.vars、cloud/**/.wrangler/）同样不能入库。

README 顶部的 CI 徽章默认以注释保留；推送到 GitHub 后，把 `OWNER` 换成实际用户名并取消注释，再确认 Actions 页面已经真实运行成功。

检查 git status --short 和暂存区；核对新增截图、JSON、日志和历史提交是否包含密钥、访问令牌、私有路径或未授权文献。仅有 .gitignore 不会删除已跟踪的秘密。发现暴露的密钥时先撤销密钥，再处理历史。

新增的后端、前端和脚本模块如果仍是未跟踪文件，必须和修改一起提交。只提交已跟踪文件（例如使用 `git commit -am`）会让克隆缺少 `app/httputil.py`、`frontend/src/mirrorStore.ts`、`functions/` 等模块，首次启动直接报 ImportError 或构建失败。提交后在另一个空目录克隆并运行一次 `python scripts/setup.py`，确认新克隆可独立安装。

## 镜像站检查

如果本次改动涉及平板镜像站，额外执行：

~~~sh
npm --prefix frontend run build
python scripts/publish_site.py --out site-check --doc 1
python scripts/serve_site.py --dir site-check --port 8010
~~~

确认阅读器没有“只读”错误条、译文与原文双栏正常、批注可以保存；检查 `site-check/data/library.json` 与 `doc-*.json` 不含 `file_path` 或本机绝对路径；确认 `site-check/data/sync.json` 中的密钥确实可以公开，或发布前删除该文件。检查完成后删除 `site-check/`，不要提交。

## 安装验证

在干净克隆中使用基础 setup，先运行 Mock 流程，导入说明书，完成划选、独立改色、页笔记和全部导出。可选 DocLayout-YOLO 安装应单独验证，语言模型需由用户自行配置。

GitHub Actions 配置检查 Windows 与 Linux 的构建和离线测试；工作流文件存在不代表云端已经运行成功。本地尚未安装 Linux/macOS 环境时，不宣称这些平台已经通过完整交互验证。

## 许可和发布

保留现有源码 LICENSE 与第三方说明，核对 PyMuPDF、可选 DocLayout-YOLO 的 AGPL 条件和所用模型条款。GitHub 发布不自动改变任何依赖许可。

创建自己的远程仓库后添加 remote，再推送经过检查的提交。应用数据仍留在本机；不将本机阅读器作为公开的多用户 Web 服务部署。

建议仓库名为 `paper-mirror`，展示名称为 **paper-mirror · 译镜**。当前模型扩展接口和接入示例见 [MODEL_ADAPTERS.md](MODEL_ADAPTERS.md)，本次发布审查见 [RELEASE_REVIEW.md](../audit/RELEASE_REVIEW.md)。秘密扫描只覆盖常见特征与本地可用历史，发布前仍需人工核对新加入的文件。
