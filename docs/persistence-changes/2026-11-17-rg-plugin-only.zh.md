---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-rg-plugin-only

[English](2026-11-17-rg-plugin-only.md) | 中文

## 概述

撤回 fork 本地的必需 Session 事件：它们原本承载 Review-Gated 任务状态、claim、admission、Git 交付与模型选择策略。纯插件形态的 Review-Gated 因此不再新增任何必需事件判别符。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-rg-plugin-only
baseline: false
changes:
  - root: "event:agent/admission/confirmed"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:agent/admission/opened"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:agent/claim/intent"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:agent/claim/settled"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:model/selection-policy"
    previous: "2026-11-08-rg-model-pools"
    after: null
    decision: same-version
  - root: "event:review-gated/direct-task-prepared"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:review-gated/git-state"
    previous: "2026-11-09-rg-local-git"
    after: null
    decision: same-version
  - root: "event:review-gated/result-confirmed"
    previous: "2026-11-09-rg-result-confirmation"
    after: null
    decision: same-version
  - root: "event:review-gated/result-prepared"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:review-gated/state"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
  - root: "event:review-gated/task-prepared"
    previous: "2026-11-10-rg-admission-claim"
    after: null
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

写入版本号不变，因为没有已发布代际被移动、删除或重写。Review-Gated 现在把持久事实写成可忽略的 `plugin:review-gated/*` 记录，消费方缺席时当前读取器会丢弃它们。被撤回的判别符原本是「读取必需」：包含它们的 Session 会被当前读取器拒绝，而不是在状态缺失的情况下继续解释。请在丢弃这类 Session 前，用写入它的构建导出或检查。不存在降级路径。

<a id="verification"></a>
## 验证

聚合类型检查五道门禁全部通过；Review-Gated 测试套件 677 通过、2 跳过；持久化目录重新生成后，本确认通过 `verify-persistence-changes`。

<a id="dev-note"></a>
## 开发备注

无。
