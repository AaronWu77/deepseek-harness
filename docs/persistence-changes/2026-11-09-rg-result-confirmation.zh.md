---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-rg-result-confirmation

[English](2026-11-09-rg-result-confirmation.md) | 中文

## 概述

为已完成的 RG 角色结果增加持久化准备和确认事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-rg-result-confirmation
baseline: false
changes:
  - root: "event:review-gated/result-confirmed"
    previous: null
    after: "626cdd354afb3995ce2f09e4f2a85dfd911ff18b1114e64d9e963c10a7a5b218"
    decision: same-version
  - root: "event:review-gated/result-prepared"
    previous: null
    after: "13881311db106a08b31c5937ff9cf92f4451e64c12949a229fafc8ecc496969e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 RG 状态事件仍可读取。准备结果只有在匹配的确认事件记录准备阶段已通过 Session flush 屏障后才对外发布。旧读取器会拒绝这两个新的必读事件判别值，不会静默忽略；后续 flush 失败不会回滚已经写入的确认标记。

<a id="verification"></a>
## 验证

真实 JSONL 恢复测试覆盖准备中与已确认的审查者和执行者结果、准备失败及销毁。投影测试覆盖检查点回放、不匹配或重复确认以及 fork 边界。

<a id="dev-note"></a>
## 开发备注

无。
