---
kind: upgrade-guide
description: "Session flush 需要绑定写入器明确确认持久化。"
---

# Session flush 持久化确认

[English](guide.md) | 中文

## 变更

`ctx.sessions.flush(session)` 现在只有在监听器明确确认精确 Session 已持久化时才返回 `true`。不返回值的监听器只是观察者，不代表已经持久化。缺少确认时，依赖持久化的会话检查点策略、Review-Gated 交付和其他消费方会拒绝后续工作。

## 迁移

1. 使用能将实时 Session 绑定到其所属写入器的持久化后端。内置 JSONL 后端与 AgentLoop 会为新建和恢复的 agent 完成绑定。
2. 自定义后端应实现可选的 `SessionHandle.bindSession(session)` 能力。所有者必须先写入完整的已有 Session 前缀，再在发布前立即绑定，期间不得追加 Session 事件。已绑定事件只能路由到精确 Session，且绑定持续到写入器关闭。
3. 只有在仍由该后端持有的绑定写入器排空并刷新请求的 Session 后，才从监听器返回 `@deepseek-ai/dsh-session` 的 `SESSION_FLUSH_DURABLE`。观察者不应返回确认。不支持此能力的提供方不能确认实时检查点。
4. 如果调用方依赖持久化，请检查 `ctx.sessions.flush(session)` 返回的布尔值，把 `false` 视为未确认；处理抛出的失败时不要假定部分写入已经回滚。
5. 如果 ACP、goal 续轮、Agent Teams、翻译、手动压缩或实时日志导出拒绝工作，请核实 Session 写入器绑定，并在重试前检查可能的部分效果。

此更改不会重写 Session 日志。所有权与失败行为请参阅[持久化约定](../../../../packages/session/session-persistence/README.zh.md)和[检查点策略](../../../../packages/session/session-checkpoint-policy/README.zh.md)。
