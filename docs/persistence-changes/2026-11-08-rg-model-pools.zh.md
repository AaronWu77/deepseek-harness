---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-rg-model-pools

[English](2026-11-08-rg-model-pools.md) | 中文

## 概述

增加必读的 Session 模型选择策略、Review-Gated 策略/任务/报告状态，以及 review-gated 消息来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-rg-model-pools
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d8bc9dd2a347c71dbc7b200bdc6345974b073602f94af4328eb6e85e79068a84"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "32c9e21b7693be4ebd658b3b8a1cfd65249706e8b17cdfe7698f5015adf94fca"
    decision: same-version
  - root: "event:model/selection-policy"
    previous: null
    after: "f35bf4de57224b74d6aac41fab3b3b1b28446a9b71cdb5ae760f6e8521c2b0e9"
    decision: same-version
  - root: "event:review-gated/state"
    previous: null
    after: "85d752f28042235947ac8a59e6bd83d0cb609cc489f85d220fff5616284ab0b5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a0d76339551efd209f9bcdd1d6eecb9a0e173ead17f2bfdf87aecd5ca2616825"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "c785c157069d6cbbcb8ebc2dcdd7cb3b9f3ee605f1913af1e66d8aa8cf49056e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

写入版本保持不变。当前读取器接受已有 Session：没有模型策略时，普通模型选择保持不受限；没有冻结 RG 策略的旧 RG Session 不会获得角色授权，继续 RG 工作前必须新建会话。旧读取器不能静默忽略新授权或报告：model/selection-policy 与 review-gated/state 是独立的必读事件判别值，review-gated 是独立的消息来源判别值；封闭目录会在执行前拒绝这些未知必读变体。不移动、删除或重写任何已提交 Session 代际，也不存在降级回退。新模型策略负载是包含完整策略或 null 的对象，RG 状态具有显式版本字段。

<a id="verification"></a>
## 验证

Session 格式目录、V3-to-V4 读取器和持久化 schema 快照：26 个文件、431 个测试通过。通用模型选择策略：17 个测试通过；模型 API 与选择器回归：121 个测试通过。RG 已发布 headless profile 组合测试通过，主代理/执行者/审查者使用不同路由，模型请求仅直接暴露 PTC。新无密钥 RG 场景录制、刷新、回放均成功；类型化身份与归一化测试共 98 个通过。场景适配时，严格读取器对尚未登记的 review-gated/state 事件明确拒绝，而非丢弃；重新生成当前目录后才接受。

<a id="dev-note"></a>
## 开发备注

无。
