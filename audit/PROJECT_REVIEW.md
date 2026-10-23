# 项目审查报告

> 本文保留修复前的审查证据。后续修复与验证状态见 [FIXES.md](FIXES.md)，历史探针已转为正式回归断言。

审查日期：2026-10-09。审查对象是当前工作区，包括已有未提交修改及新增前端组件；未修改应用源代码、用户数据库或已有文献。新增本报告、离线复现脚本和复现记录。

结论：前端可以构建，现有解析样例通过，但后台任务状态、翻译记忆、阅读器初始化与批注导出存在可确认的问题。建议先修复下面的 P1，再处理 P2。P1 表示核心功能失效或输出明显错误；P2 表示特定操作、配置或时序下失效。

## 验证范围与限制

- 已阅读后端模型、数据库、配置、解析、翻译、OCR、后台任务及全部 API 路由；前端阅读器、文献库、PDF 组件、弹窗、侧栏和 API 封装；安装、启动及测试脚本。
- `npm run build`：通过 TypeScript 检查与 Vite 生产构建。受限沙箱中首次 realpath 操作报 EPERM，正常权限重跑通过，因此不算项目构建 bug。主 JS 包约 581 kB，gzip 约 177 kB。
- `scripts/run_tests.py`：18/18 通过，其中一条断言永远成立，见测试改进建议。
- `audit/review_probes.py`：使用项目内临时目录、独立 SQLite 数据库和离线服务替身，逐项调用实际路由函数与后台函数。不是通过 HTTP 服务器的端到端测试，也没有调用任何真实翻译服务。输出见 [probe-results.txt](audit/probe-results.txt)。
- 未运行原有 `--api` / `--full`：它们会重解析现有文献，`--full` 还可能调用付费模型。未执行浏览器交互测试、大文件压力测试和公网部署测试。
- 前端条目标注“代码确认”，表示有明确的组件生命周期或控制流证据，但尚未在浏览器自动化中复现。审查不能保证不存在其他问题。

## P1：优先修复

### 1. 翻译初始化失败后，文档永久停在 translating【运行复现】

位置：[documents.py:155](backend/app/routers/documents.py:155)、[tasks.py:201](backend/app/tasks.py:201)。

接口先提交 `translating`，后台才执行 `load_settings()` 和 `get_provider()`。缺失 API key、未知 provider 或数据库异常时，全文任务没有统一的异常收尾。后续翻译和重解析都被状态检查拒绝，通常只能重启恢复。

复现：让 provider 初始化抛出 `ValueError("missing key")`，提交接口仍返回 started，随后文档状态为 `translating`。

建议：接收任务前验证配置；任务使用 try/except/finally 记录错误、回滚并恢复可重试状态。单段任务的 provider 初始化也在错误处理之外，需要一起处理。启动恢复也应覆盖中断的 parsing、running 翻译段及 OCR 状态。

### 2. Mock 占位译文污染全局翻译记忆，切换真实模型后仍显示占位结果【运行复现】

位置：[tasks.py:245](backend/app/tasks.py:245)、[tasks.py:290](backend/app/tasks.py:290)。

Mock 结果与真实译文进入同一翻译记忆；读取时不区分来源，还把复用结果的 cache_key 改成当前真实服务商的键。用户按默认配置试用之后换真实模型，普通“翻译全文”仍会显示 `【Mock译】`，并可被统计为翻译完成。跨文档也受影响。

复现：文档 A 用 mock 翻译，文档 B 相同原文用离线真实服务替身翻译；B 的来源为 `tm:mock`，真实服务调用次数为 0。

建议：Mock 不写入正式 TM，或使用独立命名空间；读取时排除已有 Mock 记忆；处理已经污染的数据。前端提供清晰的强制重翻入口。

### 3. 有附注的 PDF 导出直接失败【运行复现】

位置：[documents.py:322](backend/app/routers/documents.py:322)。

`page.add_freetext_annot()` 使用了 `fill=` 参数，当前安装的 PyMuPDF 接口参数为 `fill_color=`。只要存在 comment/note 批注就进入此分支。前端“高亮并附注”保存文本后将 kind 设为 comment，因此日常使用即可触发。

复现错误：`Page.add_freetext_annot() got an unexpected keyword argument 'fill'`，路由返回 500。

建议：修正参数并补导出回归用例。高亮附注应保留高亮对象，把附注写入其 content；目前改成 FreeText 还会把文字盖到正文上。中文可见文本需选择支持中文的字体并进行渲染验证。

### 4. 第 3 页起的文字层永远不会加载，无法划选高亮【代码确认】

位置：[PdfPane.tsx:998](frontend/src/components/PdfPane.tsx:998)。

`LazyTextLayer` 创建 `hostRef`，但 JSX 从未把它绑定到 DOM。IntersectionObserver 的 effect 每次首次执行都因 null 返回。只有 pageNumber <= 2 初始 visible 为 true；第 3 页起永久返回 null。

建议：始终渲染一个带 `ref={hostRef}` 的宿主节点，观察宿主，进入可见区域后渲染 TextSpans。回归检查第一页、第 3 页及文末页的划选。

## P2：功能与稳定性问题

### 5. 旋转页面的译文、高亮和裁剪坐标错位【运行复现】

位置：[parsing.py:44](backend/app/parsing.py:44)、[PdfPane.tsx:258](frontend/src/components/PdfPane.tsx:258)、[regions.py:35](backend/app/routers/regions.py:35)。

解析混用旋转后的 page.rect 尺寸和未旋转的文本 bbox；前端对 bbox 只乘 scale，而 PDF.js 按页面旋转渲染。点击、译文覆盖及 Shift 框选与真实内容不能对齐。

复现：把生成页设为 90°，存储 bbox 为 `[72, 88.18, 245.62, 103.29]`，实际显示 bbox 应为 `[738.71, 72, 753.83, 245.62]`。

建议：明确保存坐标体系；显示使用 viewport 变换，点击/裁剪使用逆变换。覆盖 0/90/180/270° 和非默认 CropBox 的测试。

### 6. “适应宽度”与窗口缩放监听没有初始化【代码确认】

位置：[PdfPane.tsx:153](frontend/src/components/PdfPane.tsx:153)。

初次渲染 pdfDoc 为 null，组件返回“PDF 加载中”，带 rootRef 的节点尚不存在。`useEffect([])` 提前返回，PDF 就绪后不会再执行。rootWidth 因此维持默认 1200，窗口调整、侧栏打开和窄屏下宽度计算都不正确。

建议：让宿主节点在加载阶段就存在，或在 DOM 挂载/PDF 就绪时重新绑定观察器。

### 7. 单段重译和图形翻译没有跟踪任务完成【代码确认】

位置：[Reader.tsx:193](frontend/src/pages/Reader.tsx:193)、[Reader.tsx:343](frontend/src/pages/Reader.tsx:343)、[Reader.tsx:371](frontend/src/pages/Reader.tsx:371)。

持续轮询只看文档 parsing/translating。单段任务和 OCR 不更新文档状态。单段仅在约 0.5s、2s 刷新，README 给出的本地模型约 4s/段已经超出窗口；单图也只有有限次刷新；“识别全部图形”没有主动 load 或轮询。结果可能留在“处理中”或仍显示旧内容，直到用户重新进入页面。

建议：依据段落 running 与 OCR running 跟踪任务，收到 done/failed 后停止；提交后先 await 接口再启动刷新。统一清理所有计时器。

### 8. 阅读位置恢复在 PDF 页面就绪前执行，跳转被吞掉【代码确认，依赖时序】

位置：[PdfPane.tsx:240](frontend/src/components/PdfPane.tsx:240)、[Reader.tsx:168](frontend/src/pages/Reader.tsx:168)。

registerJumper 在 PDF 加载时就执行，pages 为空仍会让父组件 jumperReady 为 true。如果文档 API 先完成，恢复 effect 立刻把 restoredRef 设为 true，并调用一个找不到页面 DOM 的跳转函数。PDF 后来就绪也不会再恢复。

建议：页面 DOM 就绪后才注册有效跳转，或让 jump 返回成功标识，成功后才标记 restored。直接从一篇 Reader 切到另一篇时，App 未加 docId key，恢复引用与 URL memo 也未重置，需一并处理。

### 9. 任务缺乏互斥，重复解析和跨任务竞争可破坏结果【运行复现入口问题，竞争后果未压测】

位置：[documents.py:128](backend/app/routers/documents.py:128)、[misc.py:117](backend/app/routers/misc.py:117)、[tasks.py:97](backend/app/tasks.py:97)。

已处于 parsing 的文档仍允许重新提交解析；接口也未在排队时预先设置 parsing。同一文档两个任务可能交替删除/rebuild blocks。单段重译、OCR、删除没有统一检查解析/翻译状态；运行中的任务可能继续写已删除的段落。全文接口的状态读取与写入也不是原子抢占。

复现：把文档设为 parsing 后调用重新解析，仍返回成功并安排新后台任务。

建议：按文档维护任务互斥/队列，数据库原子抢占任务；明确重复提交、取消和删除期间的行为。给 TranslationSegment.block_id 添加适当唯一约束，TM 写入用 upsert。

### 10. 修改术语表后，缓存译文不更新【运行复现】

位置：[translators.py:27](backend/app/translators.py:27)、[tasks.py:264](backend/app/tasks.py:264)。

段落缓存键只有服务商、模型、提示版本和原文；TM 键只有语言和原文。术语表没有参与任何缓存校验，读取记忆后也没有应用新术语。UI 宣称“后续所有翻译强制使用”无法满足。

复现：先 Mock 翻译，再新增 transformer → 变换器，再执行普通全文翻译，仍没有“变换器”。

建议：引入术语表版本/指纹，定义修改术语后的失效策略；服务 Base URL、协议等影响输出的配置也应参与段落缓存身份。target_lang 当前只用于 TM 键，提示词仍固定中文，若开放语言设置需真正传给 provider。

### 11. 设置 API 接受非法类型，可以把应用配置写坏【运行复现】

位置：[settings_store.py:27](backend/app/settings_store.py:27)、[misc.py:145](backend/app/routers/misc.py:145)。

PUT 接收任意 dict，缺少类型/枚举/范围校验。写入 `{"openai": null}` 时返回成功，下次读取在合并字典时 TypeError，设置接口及需要配置的翻译功能随后失败。错误 JSON、非整数 batch_size 等也没有恢复机制；直接覆盖文件还可能被并发读取到半份 JSON。

建议：使用 Pydantic 请求模型、嵌套类型和范围约束；原子写入临时文件并替换；损坏配置提供可诊断恢复方式，避免共享嵌套默认字典。

### 12. 更新笔记可关联其他文档段落，导致文档删除失败【运行复现】

位置：[documents.py:496](backend/app/routers/documents.py:496)。

创建笔记验证 block 所属文档，但更新时直接 setattr，允许把 A 的 note.block_id 设成 B 的 block。删除 B 只删除 B 自己的笔记，因此 A 的笔记外键阻止删除 B 的段落。

复现：跨文档 PATCH 被接受；随后删除 B 触发 `IntegrityError`。

建议：更新和创建共用关联校验；校验页码范围、block/page 一致性。批注 PATCH 同样需要类型、kind、坐标、长度等验证。

### 13. 导出高亮丢失逐行范围和颜色【运行复现】

位置：[documents.py:313](backend/app/routers/documents.py:313)。

前端保存 rects 与 bbox，导出只使用 bbox。两行高亮变成一个大框，中间未选中的内容也被高亮；用户颜色完全未应用。

复现：两个分离行矩形、绿色 `#bbf7d0`，导出只有 1 个 quad，颜色为默认黄色 `[1, 1, 0]`。

建议：按行转换 Quad 列表并设置颜色/透明度，测试高亮、下划线、附注及跨栏选区。与第 3 项一起修复。

### 14. 笔记/批注面板的“回到原位置”没有真正跳页【代码确认】

位置：[Reader.tsx:502](frontend/src/pages/Reader.tsx:502)、[Modals.tsx:262](frontend/src/components/Modals.tsx:262)。

jumpToNote 只设置 selected，没有调用已有 jump。PdfPane 也没有在 selectedId 变化时滚动。区域笔记即使有 page_number、无 block_id 也无法导航；批注面板对无 block_id 的批注直接不执行跳转。

建议：有 block 时定位块；无 block 时按 page_number 定位页，区域批注可按 bbox 定位。

### 15. 新环境按 setup 安装后，图形 OCR 缺少必需包【依赖清单确认】

位置：[ocr.py:74](backend/app/ocr.py:74)、[requirements.txt](backend/requirements.txt)。

图形 OCR 调用 `rapidocr_onnxruntime`，但 requirements 和 setup 都没有安装它。当前机器已安装，因此本机正常不能证明全新安装正常。YOLO 也是可选且未安装，解析可正确回退；RapidOCR 缺失则直接使图形翻译失败。

建议：把 RapidOCR 纳入依赖或明确提供 OCR 可选依赖组、安装步骤和启动能力检测。

### 16. 编号协议示例与解析正则不一致【运行复现】

位置：[translators.py:137](backend/app/translators.py:137)。

SYSTEM_PROMPT 的示例为 `<<<0>>`，实际输入与正则要求 `<<<0>>>`。模型按系统示例输出多段时会解析失败，触发逐条降级，增加调用与延迟。单段降级还有可能把编号原样写入译文。

复现：系统示例格式的两段文本被 `_split_numbered` 拒绝。

建议：统一示例，检查重复编号、空输出、输出数量及 finish_reason。可先测试解析协议，无需调用真实模型。

### 17. 图形 OCR 错误提示分支永远不可达【代码确认】

位置：[PdfPane.tsx:718](frontend/src/components/PdfPane.tsx:718)、[PdfPane.tsx:759](frontend/src/components/PdfPane.tsx:759)。

failed 状态满足 `!hasResult && !running`，提前返回“普通识别按钮”，后面“识别失败，点击重试”分支永远不会渲染。用户看不到依赖缺失、连接失败等真实原因。

建议：先分流 failed，显示 error 与重试；成功但零识别结果也提供明确反馈。

### 18. PDF 实例和异步读取缺乏完整清理【代码确认，内存影响未量测】

位置：[PdfPane.tsx:123](frontend/src/components/PdfPane.tsx:123)。

加载 effect 的 cleanup 只标记 cancelled；已成功加载的 PDFDocumentProxy 没有 destroy。遍历 getPage 的循环后也没再次检查 cancelled，旧文档可能在切换后回写状态。懒渲染一旦 visible 就不再释放 canvas，长文献浏览后会保留所有访问页的像素缓存。

建议：保存 loadingTask 和 doc 引用并在卸载/切换时销毁，异步阶段检查取消；对已离开视口较远的页面释放 canvas 或采用页级虚拟化。

## 优化建议与剩余风险

1. **测试先补真实缺口。** [run_tests.py:58](scripts/run_tests.py:58) 的 `or True` 使“无页脚残留”永远通过；真实论文及样例位于 git 忽略的 data 目录，全新 clone 不能独立复现测试。API 测试硬编码文档 1/2、固定 sleep 且重解析现有文献，建议改为临时库、生成 fixture、任务完成条件等待。优先覆盖本报告的初始化、缓存和导出问题。
2. **数据库查询。** 文献列表对每篇执行两次进度统计，形成 1+2N 查询；Reader 每 1.5s 全量读取 blocks 与 annotations。建议分组聚合统计，提供轻量进度接口、更新时间或增量接口。大文本全文搜索可考虑 SQLite FTS5；当前排序最后改成 document_id 升序，会覆盖“最近更新优先”的查询顺序。
3. **大 PDF 内存。** 上传先 `file.read()` 全读再判断 300MB，超限文件仍占用内存；建议分块读取、边计算哈希边落盘，超限即停止。PdfPane 在显示前串行 getPage 全文，也会拖慢长文献首屏。
4. **删除磁盘清理。** 删除文献只清数据库，不删除 PDF 和导出副本，长期使用 data 持续增长。可提供明确的数据保留策略与孤立文件清理功能。
5. **局域网访问边界。** [start.ps1:21](scripts/start.ps1:21) 默认绑定 0.0.0.0，API 没有鉴权，CORS 允许任意来源。在端口对其他设备可达时，这些设备可以读文献、改设置、删数据或触发真实翻译。建议默认仅回环地址，局域网模式显式启用并增加访问令牌/Origin 校验。恶意网页访问还取决于浏览器本地网络保护，未进行浏览器攻击验证。
6. **配置与安装一致性。** APP_DATA_DIR 在加载 .env 之前决定，写在 .env 中不生效；layout 权重路径又固定在 repo/data，未跟随 APP_DATA_DIR。PowerShell `$ErrorActionPreference = 'Stop'` 不足以可靠终止所有原生命令失败，安装/构建后应检查 `$LASTEXITCODE`。Python 依赖只有下限，应锁定经验证的版本；两个 Vite 配置建议统一。
7. **错误反馈与重试。** 文献库 remove/reparse 等 async handler 没有统一 catch；部分失败只留下控制台 rejection。翻译 fallback 吞掉原始异常，应保留服务状态码、限流信息与合理退避，避免用户无法区分密钥错误、网络故障和输出格式错误。
8. **性能与维护。** 主 JS 包可按 Reader/PDF.js 动态拆分；按 page_number 预分组 blocks/annotations，避免每次更新每页反复 filter；清理 tasks 中未使用的视觉函数/import。README 的“尚未完成全文搜索/左栏驱动滚动”等说明与现有实现不一致，应更新能力和边界描述。

## 推荐修复顺序

1. 任务异常收尾、Mock TM 隔离、附注 PDF 导出参数、LazyTextLayer 宿主。
2. PDF 宽度监听、跳转就绪、单段/OCR 完成跟踪、旋转坐标。
3. 任务互斥、设置/关联验证、术语缓存策略、逐行高亮导出。
4. 新环境可复现测试、依赖锁定、局域网访问控制、长文献性能。

离线复现命令：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
.\.venv\Scripts\python.exe -u audit\review_probes.py
```

该脚本打印缺陷证据，退出 0 仅表示探针执行完成，并不代表项目没有 bug。修复后应把这些场景转成带正确期望值的回归断言。
