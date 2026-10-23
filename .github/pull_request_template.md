## 改动说明

<!-- 这个 PR 解决了什么问题？用户会看到什么变化？ -->

## 验证方式

<!-- 写清实际运行过的命令和结果；没有运行的检查请说明原因。 -->

- [ ] `python scripts/run_tests.py`
- [ ] `npm --prefix frontend run build`
- [ ] `npm --prefix frontend run test:history`
- [ ] `npm --prefix frontend run test:browser`
- [ ] 手动验证（请描述）：

## 数据与隐私检查

- [ ] 没有提交 `.env`、`data/`、`site/`、`app.db`、私有论文、模型权重或访问令牌
- [ ] 新增测试使用临时 `APP_DATA_DIR`，不调用付费服务
- [ ] 如果改了手册，已重新生成 `docs/UserGuide.pdf` 并检查页面

## 相关 issue

<!-- 例如：Closes #12 -->
