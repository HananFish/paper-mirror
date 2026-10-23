# 第三方依赖与模型

项目自有源码使用根目录 LICENSE。下表记录主要上游来源，最终以安装版本自带的许可证、声明和模型卡为准；本项目许可证不替代依赖许可证。

| 组件 | 用途 | 上游及许可证信息 |
| --- | --- | --- |
| PyMuPDF / MuPDF | PDF 解析、渲染、写入 | [官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)：AGPL 或商业许可 |
| PDF.js | 浏览器 PDF 与文字层 | [官方项目](https://github.com/mozilla/pdf.js)：Apache-2.0 |
| RapidOCR | 本地 OCR | [官方项目](https://github.com/RapidAI/RapidOCR)：Apache-2.0；配套模型保留其上游条款 |
| DocLayout-YOLO（可选） | 版面检测 | [官方项目](https://github.com/opendatalab/DocLayout-YOLO)：AGPL-3.0；权重另按模型仓库条款 |
| FastAPI / React / Vite / Tailwind CSS | API 与界面 | 各上游 MIT；完整依赖见 requirements 和 npm 锁文件 |
| Playwright（开发） | 浏览器回归 | [官方项目](https://github.com/microsoft/playwright)：Apache-2.0 |

语言模型不随项目分发。应用可连接用户选择的本地／远程服务，模型的授权、输入处理和费用由其服务与模型条款决定。

当前仓库保留已有的自有源码 MIT 授权。分发包含 AGPL 依赖的组合程序或提供网络服务前，需根据上游条件确定分发方式；不能将该组合简单宣称为完全不受 AGPL 条件约束的 MIT 软件。

公开截图及 UserGuide.pdf 由项目生成的示例内容制作，不包含用户论文、数据库或访问凭据。不分发 Windows 系统字体或外部论文。
