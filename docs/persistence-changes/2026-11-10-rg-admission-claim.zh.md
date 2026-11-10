---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-10-rg-admission-claim

[English](2026-11-10-rg-admission-claim.md) | 中文

## 概述

新增独占任务准入、直接任务准备和可恢复输入认领的必需事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-rg-admission-claim
baseline: false
changes:
  - root: "event:agent/admission/confirmed"
    previous: null
    after: "78ad4cc37ecf00e0ea58dc615c29a746390c7bd6abff9851e309a793b79f8cf4"
    decision: same-version
  - root: "event:agent/admission/opened"
    previous: null
    after: "c6cf9b044710990419e1e0657e97f6eced41c02b887a5e5d5f066d1376f7a460"
    decision: same-version
  - root: "event:agent/claim/intent"
    previous: null
    after: "0f4158b7e8acc7c908f8340d37271a423e7258a2118bbc51e8137e10af784bd3"
    decision: same-version
  - root: "event:agent/claim/settled"
    previous: null
    after: "77cb3ea6b67429b922a659bb824a66ceb1ebc8d5fba797963e332d57d668fcbd"
    decision: same-version
  - root: "event:review-gated/direct-task-prepared"
    previous: null
    after: "1b3368b5400def24c17c15e5ee0b3ba507a3219bdee2e6dc6000f1116e0a9649"
    decision: same-version
  - root: "event:review-gated/task-prepared"
    previous: null
    after: "3aeac8d4fae4ccb993ae47ac2eca5606ae3c808e7d99f93de6ae4537fa747c6c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

当前读取器接受更早的日志。旧读取器会拒绝新的必需事件，不会按旧协议解释；首个准入事件先于显式任务准备，认领意图先于输入移除和直接任务准备。未确认或中断的工作不会自动重放。flush 失败不能确定事件是否已经到达存储。

<a id="verification"></a>
## 验证

Agent loop 测试套件通过 539 项、跳过 1 项，涵盖真实 JSONL 前缀、取消、fork 和检查点。RG 准入与旧投影测试覆盖任务准备和仅有 receipt 的未知历史。

<a id="dev-note"></a>
## 开发备注

无。
