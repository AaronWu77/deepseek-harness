---
kind: upgrade-guide
description: "PI-AI 1.4.0 内置目录移除了旧 Codex 模型 ID，并更新了原生工具声明行为。"
---

# PI-AI 1.4.0 模型目录

[English](guide.md) | 中文

## 变更

PI-AI 内置目录不再列出 `openai-codex/gpt-5.5` 或 `openai-codex/gpt-5.5-spark`。依赖这些内置条目的 profile 必须选择其提供商支持的模型。显式 profile 模型声明和外部插件目录仍由各自的实现负责；升级不会重写用户配置。

`openai-codex/gpt-6.1-sol` 等模型使用原生增量工具声明。初始及后续工具出现在对话的 `additional_tools` 条目中；请求检查器不得假设初始工具只出现在顶层 `tools` 字段。SDK 负责这些线上格式和缓存前缀的选择。

## 迁移

1. 对照升级后的提供商目录与账户实际模型权限检查配置的模型 ID，将已移除的内置 ID 替换为可用模型；不能仅根据内置条目推断账户权限。
2. 更新针对原生增量工具声明的自定义线上请求断言。DSH 工具注册表与公开工具 schema 不需要迁移。
3. 在切换已部署的提供商之前，通过 PI-AI 对话更新及重放回归验证工具添加、移除和模型切换。
