---
description: "可选 RG 预设：在一个主会话中按需使用执行者与独立审查者，通过 Persona 与提示词协作，不增加额外权限门禁。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-review-gated

[English](README.md) | 中文

## 概述

添加三个可选的 Agent 预设：RG 在一个会话中协调工作，并按需启动执行者与审查者子代理。Persona 定义各角色，附加提示词说明主代理何时委派与审查。现有预设、权限和审批规则不变，也不增加工具或完成门禁。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 选择预设

该实验性组合包不在随附的官方目录中。在源码检出中，可用 `dsh plugin --profile web add <packages/experimental/review-gated 的绝对路径>` 安装到当前 profile，或在插件页使用本地安装目标 `link:<绝对路径>`，然后重启 Web Host。新建会话并选择 **RG** Agent 预设。**RG Worker** 与 **RG Reviewer** 由主代理通过 `rg_worker`、`rg_reviewer` 启动；它们不能作为会话预设直接选择。

自定义 profile 可执行 `dsh plugin --profile <name> add @deepseek-ai/dsh-experimental-review-gated` 安装，再在新会话中选择 RG。

已有会话保留启动时的预设。会话开始首轮后切换预设不属于本组合包的能力。选择器只显示 **RG**；两个角色预设置为 `selectable: false`，仍可由主代理的子级工具解析。

### 你会得到

主代理在同一会话中保留任务、澄清、进度和最终答复。它可以直接工作，也可以把边界明确的任务交给 RG Worker。对实质性修改完成整合与验证后，主代理通常启动 RG Reviewer 进行独立检查，再修复有依据的问题或解释为何拒绝。允许按用户明确要求跳过审查，但必须如实报告。

三个角色预设共享同一套不受限的 PTC 工具组，包括 shell、文件系统、网页、后台任务、计划与子代理控制。RG 不增加权限限制：审查者默认只检查而不修改属于提示词指导，不是强制沙箱。现有安全、审批、计划模式与 Host 子代理深度限制仍然生效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入三个 `@deepseek-ai/dsh-agent-preset` 声明，不覆盖任何现有预设。每个声明挂载带作用域的 `@deepseek-ai/dsh-persona` 行和上文的共享 PTC 工具组。只有 `rg` 声明挂载协调指导插件，以及两个普通 `@deepseek-ai/dsh-tool-subagent` 实例，其 `agentPreset` 分别选择执行者与审查者。

[`src/index.ts`](src/index.ts) 在主代理预设作用域内注册一个附加系统提示词段落。它从不使用 `complete`，也从不注册部署级人设槽位，因此所选 Persona 与第一方指导保持生效。唯一配置项 `maxReviewRounds` 会被渲染为提示词中的建议审查预算。插件不拦截工具调用、完成或子代理生命周期。

角色选择使用进程内 spawn，这也是唯一接受 `agentPreset` 的后端；fork 不能改变子级人设。具名工具共享既有 `send_message`、中断和子级列举控制，因为路由依据调用 Agent 与子级 id，而不是来源工具名。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- Persona——各预设挂载的带作用域角色行。
- Agent 预设——声明、激活与会话绑定。
- 子代理委派——激活、消息、取消与子级预设。
- 实验性分组索引——可选组合包与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

### 主代理指导

#### 模型看到什么

主代理模型收到上文稳定的 `review-gated:coordination` 指导段落，以及所选 Persona 与共享工具指导。执行者与审查者模型收到各自的 Persona 和相同工具指导，但没有 RG 协调段落。子级完成通知与工具结果由现有子代理运行时提供。

#### Token 影响

主代理在每次组装请求时增加一次固定指导文本；配置的预算会代入该文本。执行者与审查者预设只增加各自的 Persona 文本。每个请求仍携带共享 PTC 工具组未变的工具 schema。

#### KV Cache 影响

所选预设的 Persona 与指导在其版本内稳定，因此不会在轮次之间使缓存前缀失效。启用或禁用组合包、修改预算或切换预设会使请求前缀变化一次。已有会话保留其预设版本，直到被替换。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 审查步骤是提示词约定，不是强制门禁。主代理可以不经审查直接交付，运行时也不会验证声称的审查确已发生。
- 三个角色获得相同工具。审查者尽管默认被要求不修改，仍能编辑文件或运行命令；发生这种情况时，主代理必须报告并把修改当作新工作处理。
- 主代理可以直接工作，也可对小型任务跳过委派。没有任何机制强制启动独立执行者或审查者。
- 审查预算是建议性的，只按模型报告的尝试次数计算；失败的启动、取消或无法判断的报告不构成通过，但不会被机器计数。
- 角色选择依赖进程内 spawn。fork 子级继承父预设，不能切换到 RG Worker 或 RG Reviewer。
- 超过 Host 配置的 `subagent.maxDepth` 的递归委派会被现有运行时拒绝；RG 不会提高该上限。
- 这些声明需要 Agent 预设注册表。Web 与 Desktop 已提供；自定义 profile 必须先挂载 `@deepseek-ai/dsh-agent-preset-registry`，本组合包才能激活 RG。
- 已有会话保留启动时的预设，不会获得 RG 指导。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

组合包刻意把随附 PTC 工具列表复制到每个角色，而不是共享 YAML 锚点：预设声明独立激活，后续 patch 又会替换整个配置，共享可变对象会让版本相互耦合。随附 PTC 工具变化时需同步三份列表。指导插件不持有状态，只渲染已校验的预算。

</details>
