---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-rg-local-git

[English](2026-11-09-rg-local-git.md) | 中文

## 概述

新增本地 Git 交付授权、候选提交、角色绑定和操作状态的必读事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-rg-local-git
baseline: false
changes:
  - root: "event:review-gated/git-state"
    previous: null
    after: "e46a4172a641805a1709cdb2eefcd3abd86b05d95126f04b485bcb8eb1927c97"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session 没有 Git 授权并保留原 RG 策略。当前读取器识别独立必读事件并验证版本化负载；不认识该判别值的读取器会拒绝事件，而不是忽略交付授权。中断操作不会重放，不覆盖任何 Session 代际。

<a id="verification"></a>
## 验证

本地 Git 投影测试覆盖完整回放、检查点后缀恢复、无 Git 授权的旧 Session，以及无效事件数据的封闭失败；4 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
