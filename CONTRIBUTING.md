# 贡献指南

先阅读 [README](README.md)、[AGENTS.md](AGENTS.md) 和 [安装文档](docs/INSTALL.md)。

提交问题时提供操作步骤、期望与实际结果、系统／浏览器版本，以及已去掉密钥和私有内容的错误信息。解析问题可附自己有权分享的最小 PDF；请不要上传不允许公开的完整论文、app.db、.env 或带令牌链接。

开发前保留现有工作区修改，使用隔离样例定位问题。修改解析、选择、翻译、批注或导出逻辑时，增加能体现用户行为和实际失败的回归。

添加模型服务请使用 [模型适配接口](docs/MODEL_ADAPTERS.md)，在可信的本机注册钩子里接入，避免把服务商请求直接写进阅读器或 PDF 路由。改动镜像站发布或同步逻辑时，请同时阅读 [平板镜像站](docs/MIRROR.md)，并确认发布产物不包含本机路径、密钥或无权公开的文献。

~~~sh
python scripts/run_tests.py
npm --prefix frontend run build
npm --prefix frontend run test:browser
git diff --check
~~~

不要以用户现有文献作为会改变数据的测试，也不要默认调用付费服务。更新说明书时同步生成 PDF，检查每页渲染，并保持中英文文档、安装脚本和实际功能一致。

提交描述说明问题、修复后的行为和实际验证结果。贡献按项目现有 LICENSE 提供，依赖和模型条款见 [第三方说明](docs/THIRD_PARTY.md)。安全问题请按 [安全策略](SECURITY.md) 私下报告。
