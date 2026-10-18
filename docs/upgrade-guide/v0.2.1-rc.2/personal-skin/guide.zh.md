---
kind: upgrade-guide
description: "个人品牌与极光配色通过可选皮肤 bundle 提供，不再作为 Host 默认值。"
---
# 个人皮肤 bundle

[English](guide.md) | 中文

## 变更

此定制 Host 使用上游鱼标与本地构建信息作为侧栏回退，并使用中性默认配色。AW/STUDIO 品牌、极光玻璃与墨色以及 StateDot 运行图案由可选 `dsh-skin` bundle 持有。未启用皮肤时，Chat 使用上游鲸尾图案；计时仍由 Host 拥有。既有 Session 数据、工具、权限与模型选择不变。

## 迁移

旧定制 Host 应按[皮肤部署说明](https://github.com/AaronWu77/dsh-skin/blob/main/DEPLOY.md)停服、备份 profile、构建配套 Host 和插件，通过 `dsh plugin --profile web add link:<plugin-path>` 安装 bundle，再从该 Host checkout 重启。不要只向旧定制 Host 加载皮肤：部分配色会重复，品牌尺寸也会不同。已经迁移且已安装 bundle 的 Host 使用同一文档的日常更新章节，不重复首次迁移，也不重装其他插件。

启用运行图案插槽前，同时更新 Host 与皮肤并重启。禁用皮肤会移除其个人品牌、运行图案注册与样式表，恢复鲸尾而不重置时钟；Host 的功能几何、浮动面板修复和原生窗口集成保持不变。只开发皮肤时遵循插件 README 的[热更新条件](https://github.com/AaronWu77/dsh-skin/blob/main/README.md#development-and-hot-reload)，单独启动 watcher 不保证当前 GUI 更新。
