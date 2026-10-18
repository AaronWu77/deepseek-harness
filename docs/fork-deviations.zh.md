---
kind: reference
description: "说明 RC2 保留要求、可选皮肤归属及 Review-Gated 扩展。"
---
# Fork 偏离

[English](fork-deviations.md) | 中文

<a id="summary"></a>
## 概述

本参考以官方 `dsh-v0.2.1-rc.2` 为基线说明当前定制 checkout。F-001–F-022 是保留要求的固定编号，不代表 22 个上游新增功能，也不是改动文件数。F-017、F-018、F-022 由可选 `dsh-skin` 持有；其余 19 项仍由 Host 包或仓库脚本维护。Review-Gated 与预设可选性属于额外扩展，下文单独说明。

## 目录

- [概述](#summary)
- [归属地图](#ownership-map)
- [Review-Gated 预设](#review-gated-presets)
- [本地 one-shot activation](#local-one-shot-activation)
- [保留行为注册表](#preservation-registry)
- [不计入定制的上游行为](#upstream-behavior-not-counted-as-customization)

<a id="ownership-map"></a>
## 归属地图

| 类别 | 保留编号 | 所属实现与作用 |
|---|---|---|
| 执行、权限与验证 | F-001–F-003、F-005–F-007、F-019 | Host 提供方和工具执行维持有效权限、诊断、调度器标识、字符串验证以及局部 PTC SDK/schema/执行的一致性。 |
| 模型选择 | F-004、F-011 | Host 与 Client 保留已确认选择和有序后台保存，避免过期失败覆盖较新的选择。 |
| 平台与布局 | F-008–F-010、F-015、F-016 | Host 保留 Windows 路径打开参数、浮层安全的列布局、收起时的遮罩抑制、视口全屏面板及原生拖拽区域。 |
| 构建与测试支持 | F-012–F-014、F-021 | 仓库脚本处理受跟踪的 Loader 链接、notices、rescope 排除项以及明确的录制输入。 |
| Team 成员判定 | F-020 | 可选 Team 包验证 roster 成员身份，避免无关的提供方子级获得 Team lead 行为。 |
| 个人外观 | F-017、F-018、F-022 | `dsh-skin` 通过 Host slot 和语义钩子持有 AW/STUDIO 品牌、StateDot 运行图案及极光玻璃与墨色外观。 |

profile 选择的仓外插件属于独立安装，不是官方 Host 源码改动；各插件文档定义自身行为。选择 bundle 或保留某个编号，都不代表已验证所有原生平台、回放数据或模型路由。

<a id="review-gated-presets"></a>
## Review-Gated 预设

可选 [Review-Gated bundle](../packages/experimental/review-gated/README.zh.md) 增加 RG、RG Worker 与 RG Reviewer 预设。RG 保持主会话，并可委派执行和审查。只有 RG 可用于新建 Session；角色预设仍可绑定到子级。这依赖本地[预设可选性扩展](../packages/preset/agent-preset-registry/README.zh.md#use-this-package)，不可选预设不能作为用户选择或部署默认值。

审查属于提示词指导，不是运行时的完成门禁或权限门禁。三个角色共享工具组，仍受已有 Host 审批和子代理深度限制约束。已有 Session 保留启动时的预设；安装 bundle 不会把每个会话都变成 RG。

<a id="local-one-shot-activation"></a>
## 本地 one-shot activation

定制 Host 包含服务 Review-Gated 角色的本地 [Subagent](subsystems/subagent.zh.md) 扩展。显式 `lifecycle: 'one-shot'` 分派分离的 provider preparation，真实本地子级创建、权限、工作目录、preset 组合、执行及清理由已有 manager 管理。子级沿用 one-shot descriptor 和 catalog 格式，不接受后续输入或冷恢复。扩展不改变默认分派、可续接 activation 或外部 provider 执行。

行为测试由 [local-one-shot.spec.ts](../packages/subagent/subagent/tests/local-one-shot.spec.ts) 负责，并有相邻外部 activation、权限、preset 和目录回归测试。当上游提供等价的公开本地 one-shot activation，且 Review-Gated 角色及包测试无需此扩展即可通过时，退役此偏离。上游包版本号不能标识此本地扩展。保留扩展不要求加载 Review-Gated 插件。

<a id="preservation-registry"></a>
## 保留行为注册表

这些编号保留各自的行为 owner，其中包括三项皮肤归属；它们不是可从 Host 任意抽离的可选功能清单。源码测试证据不等于 upstream 退役、原生平台等效、构建后 profile 兼容或部署完成。运行时保留 `native` 与 `ptc` 呈现模式，不恢复 `both`。Aurora frame 保留 shell 底部 slot 与浮起表面的滚动条。

| ID | 行为与源码 owner | 最近的专项检查 | 验证范围 |
|---|---|---|---|
| F-001 | [保持受支持的非升级请求的有效模式](../packages/sandbox/sandbox/src/escalation.ts) | [检查](../packages/sandbox/sandbox/tests/escalation.spec.ts) | 源码测试通过；原生隔离待验证 |
| F-002 | [省略 PTC 非升级权限请求](../packages/core/tools/src/ptc.ts) | [检查](../packages/core/tools/tests/ptc.spec.ts) | 源码测试通过 |
| F-003 | [跨包解析共享调度器标识](../packages/core/tools/src/index.ts) | [检查](../packages/core/tools/tests/tools.spec.ts) | 源码测试通过；组合应用待验证 |
| F-004 | [按顺序异步保存默认模型](../packages/api/session-controller/src/commands.ts) | [检查](../packages/api/session-controller/tests/session-models.host.spec.ts) | Host 源码测试通过 |
| F-005 | [程序语法与序列化诊断](../packages/core/tools/src/ptc.ts) | [检查](../packages/core/tools/tests/ptc.spec.ts) | 源码测试通过；录制请求头待验证 |
| F-006 | [明确拒绝后才请求严格更宽的升级](../packages/core/tools/src/ptc.ts) | [检查](../packages/core/tools/tests/ptc.spec.ts) | 源码测试通过；录制请求头待验证 |
| F-007 | [按 Unicode 码点验证字符串 minLength](../packages/core/tools/src/json-schema.ts) | [检查](../packages/core/tools/tests/json-schema.spec.ts) | 源码测试通过 |
| F-008 | [单个 Explorer 文件选择参数](../packages/util/native-command/src/path-opener.ts) | [检查](../packages/util/native-command/tests/path-opener.spec.ts) | 源码测试通过；Explorer 与 WSL 待验证 |
| F-009 | [列不创建妨碍浮层的层叠上下文](../packages/client/ui-layout/src/client/AppFrame.module.css) | [检查](../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts) | 结构与组件检查通过；浏览器待验证 |
| F-010 | [关闭时不绘制 Aurora 遮罩](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css) | [检查](../apps/web/tests/sidebar-right.e2e.ts) | 保留浏览器检查；执行待验证 |
| F-011 | [保持已确认模型选择并抑制过期失败](../packages/client/ui-model-selection/src/client/directory.ts) | [检查](../packages/client/ui-model-selection/tests/directory.client.spec.ts) | 目录与组件检查通过 |
| F-012 | [受 Git 跟踪的 Loader 链接与 Windows junction](../scripts/read-tracked-loader-config.ts) | [检查](../scripts/read-tracked-loader-config.spec.ts) | 辅助函数测试通过；一个原生符号链接用例跳过 |
| F-013 | [跳过 virtual-store 中缺失的 notices manifest](../scripts/gen-third-party-notices.ts) | [检查](../scripts/gen-third-party-notices.spec.ts) | 生成器检查通过 |
| F-014 | [按标记限定 rescope 排除项](../scripts/rescope-vendor.ts) | [检查](../scripts/rescope-vendor.spec.ts) | 脚本检查通过 |
| F-015 | [右侧全屏面板固定于视口](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css) | [检查](../apps/web/tests/sidebar-right.e2e.ts) | 保留浏览器检查；原生桌面待验证 |
| F-016 | [macOS Aurora 顶部露出条可拖动](../packages/client/ui-layout/src/client/AppFrame.module.css) | [检查](../apps/web/tests/window-drag-coverage.e2e.ts) | 结构检查通过；原生桌面待验证 |
| F-017 | 可选 `dsh-skin` 占据[侧栏品牌插槽](../packages/client/ui-sidebar/README.zh.md#skin-integration) | 品牌与清理测试由插件持有 | 个人图案不再是 Host 默认回退 |
| F-018 | 可选 `dsh-skin` 将[运行图案](../packages/client/ui-chat/README.zh.md#skin-integration)替换为 StateDot | [计时检查](../packages/client/ui-chat/tests/running-status.client.spec.tsx)；[真实 profile 图案切换](../apps/web/tests/skin-running-icon.e2e.ts) | Host 保留上游鲸尾回退和耗时时钟 |
| F-019 | [SDK、schema 与执行使用同一个局部 PTC 提供方](../packages/core/tools/src/index.ts) | [检查](../packages/core/agent-tool-presentation/tests/loader-composition.spec.ts) | 真实 YAML Loader 检查通过；profile 回放需要构建 Typert 产物 |
| F-020 | [非 roster 中的提供方子 agent 不属于 Team](../packages/experimental/agent-team/src/roster.ts) | [检查](../packages/experimental/agent-team/tests/non-team-subagent-membership.spec.ts) | 真实 YAML Loader 与本地一次性调用检查通过；旧同版本格式录制尚未解决 |
| F-021 | [明确首次录制输入与 scripted 模型类别](../packages/test-support/session-snapshot/src/session-files.ts) | [检查](../packages/test-support/session-snapshot/tests/record-inventory.spec.ts) | 辅助函数与 manifest 检查通过；完整 profile 回放待验证 |
| F-022 | 可选 `dsh-skin` 持有个人[玻璃与墨色样式](web-styling.zh.md#optional-skins) | 调色板、渲染安全及浏览器检查由插件持有 | Host 保留中性结构与交互规则 |

只有专项检查与相关正式 profile、模型可见输出、浏览器或原生平台用例无需本地实现就通过时，才退役该条目。仅凭结构检查不会退役任何条目。生产同版本格式的 Team 共存录制使用已移除的委派参数；其不可变前代输入保留为外部演练数据，直到当前 API owner 完成验证。

<a id="upstream-behavior-not-counted-as-customization"></a>
## 不计入定制的上游行为

官方 RC2 已有运行耗时时钟、StateDot 基础组件、侧栏品牌 slot、Team 基础设施、Agent 预设和 1017 模型标记。本地运行图案定制只是选用 StateDot 替代鲸尾，没有新增时钟。默认鲸尾组件、图片、样式表和图片内联构建配置保持上游版本。禁用皮肤恢复这些默认实现，运行状态、耗时与无障碍播报保持不变。
