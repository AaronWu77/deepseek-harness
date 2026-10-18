---
kind: reference
description: "记录本地 Host 源码偏离及退役条件。"
---
# Fork 偏离

[English](fork-deviations.md) | 中文

## 本地 one-shot activation

定制 Host 包含服务 Review-Gated 角色的本地 [Subagent](subsystems/subagent.zh.md) 扩展。显式 `lifecycle: 'one-shot'` 分派分离的 provider preparation，真实本地子级创建、权限、工作目录、preset 组合、执行及清理由已有 manager 管理。子级沿用 one-shot descriptor 和 catalog 格式，不接受后续输入或冷恢复。扩展不改变默认分派、可续接 activation 或外部 provider 执行。

行为测试由 [local-one-shot.spec.ts](../packages/subagent/subagent/tests/local-one-shot.spec.ts) 负责，并有相邻外部 activation、权限、preset 和目录回归测试。当上游提供等价的公开本地 one-shot activation，且 Review-Gated 角色及包测试无需此扩展即可通过时，退役此偏离。上游包版本号不能标识此本地扩展。保留扩展不要求加载 Review-Gated 插件。

## 保留行为注册表

这些独立 owner 的行为仍是有效源码偏差。源码测试证据不等于 upstream 退役、原生平台等效、构建后 profile 兼容或部署完成。运行时保留 `native` 与 `ptc` 呈现模式，不恢复 `both`。Aurora frame 保留 shell 底部 slot 与浮起表面的滚动条。

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
| F-018 | [StateDot 运行指示器与经过时间](../packages/client/ui-chat/src/client/chat/RunningStatus.tsx) | [检查](../packages/client/ui-chat/tests/running-status.client.spec.tsx) | 组件检查通过 |
| F-019 | [SDK、schema 与执行使用同一个局部 PTC 提供方](../packages/core/tools/src/index.ts) | [检查](../packages/core/agent-tool-presentation/tests/loader-composition.spec.ts) | 真实 YAML Loader 检查通过；profile 回放需要构建 Typert 产物 |
| F-020 | [非 roster 中的提供方子 agent 不属于 Team](../packages/experimental/agent-team/src/roster.ts) | [检查](../packages/experimental/agent-team/tests/non-team-subagent-membership.spec.ts) | 真实 YAML Loader 与本地一次性调用检查通过；旧同版本格式录制尚未解决 |
| F-021 | [明确首次录制输入与 scripted 模型类别](../packages/test-support/session-snapshot/src/session-files.ts) | [检查](../packages/test-support/session-snapshot/tests/record-inventory.spec.ts) | 辅助函数与 manifest 检查通过；完整 profile 回放待验证 |
| F-022 | 可选 `dsh-skin` 持有个人[玻璃与墨色样式](web-styling.zh.md#optional-skins) | 调色板、渲染安全及浏览器检查由插件持有 | Host 保留中性结构与交互规则 |

只有专项检查与相关正式 profile、模型可见输出、浏览器或原生平台用例无需本地实现就通过时，才退役该条目。仅凭结构检查不会退役任何条目。生产同版本格式的 Team 共存录制使用已移除的委派参数；其不可变前代输入保留为外部演练数据，直到当前 API owner 完成验证。
