---
kind: explanation
description: "记录本地 Host 源码偏离及退役条件。"
---
# Fork 偏离

[English](fork-deviations.md) | 中文

## 本地 one-shot activation

固定 alpha2 Host 包含服务 Review-Gated 角色的本地 [Subagent](subsystems/subagent.zh.md) 扩展。显式 `lifecycle: 'one-shot'` 分派分离的 provider preparation，真实本地子级创建、权限、工作目录、preset 组合、执行及清理由已有 manager 管理。子级沿用 one-shot descriptor 和 catalog 格式，不接受后续输入或冷恢复。扩展不改变默认分派、可续接 activation 或外部 provider 执行。

行为测试由 [local-one-shot.spec.ts](../packages/subagent/subagent/tests/local-one-shot.spec.ts) 负责，并有相邻外部 activation、权限、preset 和目录回归测试。当上游提供等价的公开本地 one-shot activation，且 Review-Gated 角色及包测试无需此扩展即可通过时，退役此偏离。Host 包版本仍为 alpha2，不代表上游发行版已包含此扩展。
