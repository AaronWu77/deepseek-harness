# Agent Note: Workspace 选择在导航竞态下仍可恢复

Status: implemented

[English](2026-09-17-workspace-selection-retry-and-navigation.md) | 中文

## Problem

会话界面把被拒绝或被后续导航取代的 Workspace 选择当作普通完成处理：失败时它会清掉界面上唯一可见的目标标签，而启动时的自动选区也可能在用户已开始手动选择之后才提交。

## Decision

`uiWorkspace.openWorkspace` 只在自己的导航信号仍然有效时提交。`replaceMain` 会在可选的同步准备回调之后重新检查该信号，并在请求被取代时释放已保留的引用，因此被取代的调用仍可能创建 Session，但绝不会选中它，也不会搬移草稿。启动时的自动选区走同一个方法，因而共享同一套布局导航信号，晚到的结果无法覆盖手动选择。[ConversationContent](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx) 把选中的 Workspace 作为 pending 状态持有，并在选择回调 reject 时回滚，先前选中的标签因此保持可见。界面不提供单独的重试控件：选择器仍在，用户重新选一次即可。

## Alternatives considered

**任何失败都清掉 pending 标签**会在选择仍在落定期间隐藏目标。**不取消启动时的自动选区**会让晚到的自动结果覆盖手动选择，因此两条路径共享布局的取消信号。

## Consequences

被拒绝的选择会保留先前选中的标签；被取代的请求会留下它创建的 Session 但不选中它。选择回调与 `openWorkspace` 都是 `Promise<void>`：调用方通过 rejection 而非返回值观察失败。

## Verification

会话测试覆盖 pending 状态、Workspace 成员刷新之前就成功、以及 reject 时的回滚。Workspace 服务测试覆盖提交规则，以及手动导航对启动自动选区的取消。
