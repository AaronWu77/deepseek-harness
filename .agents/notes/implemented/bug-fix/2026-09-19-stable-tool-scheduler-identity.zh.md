# Agent Note: 源码入口与 profile 入口之间的稳定 scheduler 身份

Status: implemented

[English](2026-09-19-stable-tool-scheduler-identity.md) | 中文

## 问题

源码 `dsh` 启动通过 `tsx/esm` 运行，其 `paths` 投影可能加载 workspace package 的源码入口。profile 插件则根据 package exports 解析到 `lib`。因此，`@deepseek-ai/dsh-agent-loop` 与 `@deepseek-ai/dsh-tools` 可能在同一个 Node 进程中从不同入口执行。`TOOL_RUNTIME_SCHEDULER` 原先使用模块局部的 `Symbol()`，使 agent-loop 查找到了不同于 ToolRuntime 调度器的属性，所有模型工具调用都会在进入 `prepare` 之前失败。

## 决策

`TOOL_RUNTIME_SCHEDULER` 使用 `Symbol.for('@deepseek-ai/dsh-tools.scheduler')`，同时保留其内部 unique symbol 类型。该键使用进程级 registry 名称而不是模块实例身份，因此源码入口与 profile 入口可以访问同一个调度器属性。调度器仍是内部实现，并从生成的 service API 中排除。

## 考虑过的替代方案

**让源码启动器把所有 package 都解析到源码。** 不予采纳：这会把启动解析变更扩展到完整 profile 依赖图，并让 profile 加载的 package 依赖源码树入口语义。

**让 profile loader 把所有 package 都解析到 `lib`。** 不予采纳：这会移除源码启动的零构建路径，并让启动器行为依赖 package 产物是否存在。

**在 agent-loop 中增加缺失调度器的 fallback。** 不予采纳：这会掩盖模块身份缺陷，并可能选择无关属性，而不是保持单一的调度器约定。

## 后果

源码入口与 profile package 入口可以共享该调度能力，而不要求进程中只有一个模块实例。其他依赖对象或 class 身份的运行时导出仍受现有源码／产物启动规则约束；本决策只覆盖这个 symbol-keyed scheduler。tools 单元测试固定 global registry key，dual-resolution Web smoke 则执行一次嵌套 PTC binding，使 scheduler lookup 能完成而不会在 `prepare` 处失败。
