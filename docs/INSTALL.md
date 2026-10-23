# 安装与配置

## 环境

- Python 3.11 或更新版本，含 venv 和 pip。主要验证环境为 Windows / Python 3.12。
- Node.js 22 或更新版本，含 npm；确保两者能从终端运行。
- Git（用于克隆和贡献）。普通阅读不需要 CUDA、Ollama、Tesseract 或云端账户。

从项目根目录执行，路径有空格时也可以使用 Python 入口：

~~~sh
python scripts/setup.py --check-only
python scripts/setup.py
python scripts/start.py
~~~

如果系统将 Python 命名为 python3，将上述 python 替换为 python3。安装程序会创建 .venv、安装固定的后端依赖和前端锁文件、构建前端、生成练习 PDF。失败时会停止并显示出错的步骤，可以修复环境后重试。

Windows 便捷入口：

~~~powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -CheckOnly
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
~~~

Linux/macOS 使用相同 Python 安装入口。Windows 的交互与浏览器流程已经本机验证；其他系统的入口已做兼容处理，由 CI 配置检查，发布前仍应在目标机器验证。PowerShell 防火墙脚本仅适用于 Windows。

### 手动安装

Windows：

~~~powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
npm --prefix frontend ci
npm --prefix frontend run build
.venv\Scripts\python.exe scripts\make_user_guide.py
python scripts\start.py
~~~

Linux/macOS：

~~~sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
npm --prefix frontend ci
npm --prefix frontend run build
.venv/bin/python scripts/make_user_guide.py
python3 scripts/start.py
~~~

## 文本翻译

默认 Mock 不联网，只展示占位译文。真实翻译通过 OpenAI 兼容的 chat completions 接口。

1. 复制 .env.example 为 .env。
2. 在 .env 填入 TRANSLATION_API_KEY，或自行命名环境变量。
3. 打开设置，填写服务商 Base URL、模型名称、密钥环境变量名称。
4. 选择目标语言和翻译协议，保存设置；编辑 .env 后需重启。

| 协议 | 使用场景 | 行为 |
| --- | --- | --- |
| 编号批量 | 能遵守编号格式的指令模型 | 按批发送，失败时逐条重试 |
| 极简单段 | 专用翻译模型或不保留编号的接口 | 每段单独请求，提示词更简洁 |

本地 Ollama 地址通常是 http://127.0.0.1:11434/v1。先安装、启动服务并准备模型，用 ollama list 确认名称，再填写同样的名字。密钥参数仍需非空值，按本地服务要求设置；Ollama 的兼容接口示例使用占位密钥。参见 [官方文档](https://docs.ollama.com/api/openai-compatibility)。

不提供固定显存、每段耗时或翻译质量承诺；它们取决于模型、量化、硬件和原文长度。应用不会代你拉取或运行语言模型。

## 图片 OCR 与视觉识别

基础安装包含 RapidOCR，默认使用 PP-OCRv4 检测／识别模型和 mobile v2 方向分类。图片 OCR 在本机执行，识别出的文本交给文本翻译服务。原生 PDF 文字存在时优先读取文字层。

“视觉识别”是另一条手动路径：在设置中独立填写支持图片输入的接口和模型。默认 qwen2.5vl:7b 只是示例名称，需自行安装并运行对应服务。使用远程视觉服务会发送所选图片区域。

Tesseract 不是主要 OCR 路径。若调用保留的 Tesseract 工具函数，需自行安装程序和语言包，可用 TESSERACT_CMD 指定可执行文件。

## 可选版面检测

DocLayout-YOLO 不随基础安装自动下载。它可以帮助区分图片、表格、图注及公式，应用使用 CPU 推理：

~~~sh
python scripts/setup.py --with-layout
~~~

已有基础环境时，可以只安装增量依赖。在 Windows 中：

~~~powershell
.venv\Scripts\python.exe -m pip install -r backend\requirements-layout.txt
.venv\Scripts\python.exe scripts\install_layout.py
.venv\Scripts\python.exe scripts\install_layout.py --check-only
~~~

Linux/macOS 将 Python 路径改为 .venv/bin/python。

下载来源为上游公开的 juliozhao/DocLayout-YOLO-DocStructBench，文件名为 doclayout_yolo_docstructbench_imgsz1024.pt，存储到 data/models/layout/（或 APP_DATA_DIR 对应目录）。安装脚本使用 Hugging Face 下载缓存并通过临时文件安装；已有权重不会覆盖。也可从 [官方项目](https://github.com/opendatalab/DocLayout-YOLO) 获取权重后放到同一路径。

若下载受网络限制，可以继续使用启发式解析；模型缺失不会阻止基础阅读。安装模型后重启应用。

## 平板镜像站（可选）

已翻译的文献可以导出为静态站点，部署到 Cloudflare Pages 后在平板或手机上继续阅读和批注：

~~~sh
npm --prefix frontend run build
python scripts/publish_site.py
python scripts/serve_site.py --dir site --port 8010
~~~

部署、自动同步、安全边界和常见问题见 [平板镜像站](MIRROR.md)。基础安装不需要 Cloudflare 账号，也不需要执行这一步。

## 测试与开发

~~~sh
python scripts/run_tests.py
npm --prefix frontend run build
npm --prefix frontend run test:browser
~~~

浏览器测试默认使用 Windows 已安装的 Edge。Linux/macOS 使用 Playwright Chromium，先运行：

~~~sh
npm --prefix frontend exec -- playwright install chromium
~~~

Linux 若缺系统库，可在合适权限下使用 playwright install --with-deps chromium。PLAYWRIGHT_CHANNEL 可覆盖默认浏览器，例如 chrome。测试不依赖作者机器上的 Codex 运行库。

全部自动回归在临时数据目录执行，不读取现有 app.db、不修改原文，也不调用付费翻译服务。--api / --full 保留为离线兼容参数。--real-papers 是显式选择的本机真实论文检查，不是 CI 必需条件。

开发可在 backend/ 目录用项目虚拟环境运行 uvicorn app.main:app --reload --host 127.0.0.1 --port 8000，并在 frontend/ 运行 npm run dev。

## 端口与数据目录

~~~sh
python scripts/start.py --port 8080
python scripts/start.py --lan
~~~

自定义数据目录通过 APP_DATA_DIR 环境变量或 .env 配置。备份前停止应用并复制整个数据目录；仅复制 app.db 而忽略 WAL 或原文 PDF 不是完整备份。APP_ACCESS_TOKEN 用于局域网配对，未指定时启动脚本会生成临时令牌。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| python 或 node 找不到 | 安装并加入 PATH，重新打开终端；运行 --check-only |
| 安装失败 | 查看 pip/npm 错误；先解决代理、证书或依赖问题，不关闭安全校验 |
| 前端没有构建 | 运行 npm --prefix frontend run build，再重启 |
| 端口占用 | 使用 --port 指定空闲端口 |
| 翻译失败 | 核对模型名称、API URL、密钥变量和协议；按界面错误重试 |
| 图注缺失 | 点击“翻译图片及图注”；位图未检测到时框选 OCR 或视觉识别 |
| PDF 里找不到笔记 | 检查导出文件末尾的可见笔记附录，并确保笔记保存成功 |
| 扫描文献没有正文 | 当前没有整篇扫描件 OCR 管线；可以框选处理局部区域 |
| 镜像站显示“加载失败” | 确认已运行 publish_site.py 并完整部署 data/ 与 assets/ 目录；见 [平板镜像站](MIRROR.md) |
| 平板批注没有回到电脑 | 检查 .env 的 MIRROR_SYNC_URL / MIRROR_SYNC_SECRET，或改用「导入平板批注」JSON |
