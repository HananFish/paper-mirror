# paper-mirror 模型接入指南

现有 OpenAI 兼容服务只需修改设置中的地址、模型和密钥环境变量。对于非兼容协议或本地推理库，四类接口可以独立替换；无需修改 PDF 坐标、阅读器、图注关联或笔记导出代码。

| 类型 | 默认实现 | 接口约定 | 选择方式 |
| --- | --- | --- | --- |
| text | openai；另保留离线 Mock | `translate(texts, glossary, context)` → 等长的译文列表；失败位置返回 `None` | 设置：文本服务类型；`openai.adapter` |
| vision | openai | `recognize(png, target_lang, glossary)` → 非空文字或 Markdown | 设置：视觉服务类型；`vision.adapter` |
| ocr | rapidocr | 调用 `model(png)` → `[{quad, src, confidence}]` | 本机环境变量 `OCR_ADAPTER` |
| layout | doclayout；未安装时返回 None，使用启发式解析 | 调用 `model(page, dpi)` → `[{name, bbox, conf}]` 或 None | 本机环境变量 `LAYOUT_ADAPTER` |

类型定义与注册入口位于 `backend/app/model_adapters.py`。`GET /api/model-adapters` 只返回注册名称，不读取模型、访问网络或返回密钥。Mock 是独立的演示模式，不作为真实模型缓存。

## 注册一个新模型

在 `backend/app/custom_adapters.py` 的 `register()` 中注册工厂。这是可信的本机 Python 扩展；HTTP 客户端只能选择已注册名称，不能指定 Python 模块、文件路径或执行代码。

```python
def register():
    from .model_adapters import register_adapter
    register_adapter('text', 'my-service', make_text_model)


def make_text_model(config, settings):
    # 在这里按需导入 SDK、读取环境变量或加载本地模型。
    # 下面仅演示接入点；实际实现自己的接口调用。
    from .my_service import MyTextModel
    return MyTextModel(config, settings['target_lang'])
```

`MyTextModel` 需提供 `name`、`model` 和 `translate()`；`model` 应与配置中的模型标识一致。不要合并或重排片段。保留数字、公式、术语和上下文语义；部分失败用 `None` 表示，调用层会保留原文并报告失败。可选 `last_error` 提供不含凭据的错误说明。工厂接收服务配置和全局设置，重启后注册一次；禁止覆盖同名适配器。

重启后，选择“OpenAI 兼容接口”服务商模式，再在“文本服务类型”里选择新适配器。`openai` 配置字段为兼容旧版本保留，新适配器也使用其中的 `base_url`、`model`、`api_key_env`、`protocol`。例如通过设置 API 选择：

```json
{"provider":"openai","openai":{"adapter":"my-service","base_url":"https://service.example/v1","model":"my-model","api_key_env":"MY_SERVICE_KEY"}}
```

视觉工厂返回提供 `recognize()` 的对象；OCR 和版面工厂返回可调用对象。工厂签名均为 `(config, settings)`；当前 OCR/版面选择使用环境变量，因此传入空配置和设置，自定义参数应从受控的本机配置或环境变量读取。

## 坐标、缓存和安全

- OCR 的 `quad` 是裁剪 PNG 像素坐标，四点按左上、右上、右下、左下顺序排列，`confidence` 为 0–1。文字使用 `src`。由现有提取层换算 PDF 坐标；适配器不要自行换算。
- 版面 `bbox` 是传入页面的 PDF 点坐标，顺序为左、上、右、下。沿用类别：`title`、`plain text`、`abandon`、`figure`、`figure_caption`、`table`、`table_caption`、`table_footnote`、`isolate_formula`、`formula_caption`。不可用时返回 None；不伪造检测结果。
- 视觉文字暂不贴回原位，显示在校对窗口，可保存到笔记与区域批注。不要从文字输出推测坐标。
- 文本适配器标识参与翻译缓存键，OCR 标识参与图片缓存键。切换适配器后点击重新翻译/识别；现有翻译记忆仍可按原文、目标语言和术语表复用，需要强制重译时使用强制选项。
- 密钥通过 `api_key_env` 指定的环境变量读取，可复用 `model_adapters.api_key()`。不要写入设置、译文、异常内容或日志。不接受客户端传来的密钥字段。
- 按需加载 SDK/权重，禁止 API 请求时自动下载模型。共享推理对象需要线程锁；服务适配器需要超时、输出校验和适当的重试。

添加新适配器后，使用临时 `APP_DATA_DIR`、模拟服务和生成 PDF 测试；不要用真实文献和付费调用做回归。运行 `python scripts/run_tests.py`、前端构建与浏览器检查。示例与合同测试见 `scripts/test_model_adapters.py`。
