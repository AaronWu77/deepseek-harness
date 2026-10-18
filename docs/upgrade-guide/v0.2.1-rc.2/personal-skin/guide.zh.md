---
kind: upgrade-guide
description: "个人品牌与极光配色通过可选皮肤 bundle 提供，不再作为 Host 默认值。"
---
# 个人皮肤 bundle

[English](guide.md) | 中文

## 变更

此定制 Host 使用上游鱼标与本地构建信息作为侧栏回退，并使用中性默认配色。AW/STUDIO 品牌及极光玻璃与墨色由可选 `dsh-skin` bundle 持有。既有 Session 数据、工具、权限与模型选择不变。

## 迁移

部署配套 Host 前，构建插件并通过 `dsh plugin --profile web add link:<plugin-path>` 安装到 Web profile。按照插件的停服迁移说明备份 profile、构建 Host 和插件，再从主工作区重启。不要只向旧定制 Host 加载皮肤：部分配色会重复，品牌尺寸也会不同。

禁用皮肤会移除其个人品牌注册与样式表；Host 的功能几何、浮动面板修复、原生窗口集成和运行指示保持不变。后续只开发皮肤时，可使用插件构建 watcher 配合既有 Web HMR 接收器。
