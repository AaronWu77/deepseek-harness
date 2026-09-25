# 现存 fork 偏差

[English](fork-deviations.md) | 中文

这里登记 fork 在合入上游更新时可能仍需保留的源码行为，不是所有提交的清单：本地视觉风格和 profile 偏好由其他位置负责。当前基线盘点尚未完成，下列条目也未与最新获取的上游版本核对；不能只凭本页批准一次同步。[同步流程](cookbook/syncing-the-fork.zh.md)规定准入和退出条件。

## 已记录的源码修复

### F-001：保留在有效沙箱模式下的执行

- **行为：**权限请求不扩大当前有效沙箱模式时，不得放弃本来允许执行的操作；不支持的模式仍须拒绝。
- **本地实现：**沙箱提权处理；使用 Git 提交标题 "fix(sandbox): run under the effective mode when a request cannot widen it" 查找原始改动。
- **回归保护：**[沙箱提权行为](../packages/sandbox/sandbox/tests/escalation.spec.ts)和 [PowerShell 执行行为](../packages/shell/tool-pwsh/tests/tools.spec.ts)。在合适的集成分支移除本地修复，确认相关断言会失败。
- **上游状态：**尚未与最新获取的上游版本核对。
- **退出条件：**移除本地实现后，相同行为测试及相关真实组合工具检查仍然通过。

### F-002：忽略不扩大的 run_code 权限请求

- **行为：**当前有效模式已经更宽时，请求较窄权限的 run_code 应直接执行，不能要求不可能发生的提权；格式错误或不支持的权限请求仍须失败。
- **本地实现：**PTC 工具分发；使用 Git 提交标题 "fix(tools): drop a non-widening sandbox request instead of failing run_code" 查找原始改动。
- **回归保护：**[PTC 工具分发测试](../packages/core/tools/tests/ptc.spec.ts)。撤去本地修复后，同时验证允许执行和拒绝非法请求两种行为。
- **上游状态：**尚未与最新获取的上游版本核对。
- **退出条件：**集成分支移除本地实现后测试仍通过；如果可见工具结果发生变化，还要运行相应产品路径检查。

### F-003：保持稳定的工具调度标识

- **行为：**不同入口的工具调用若共享调度策略，就必须使用相同的调度标识。
- **本地实现：**工具运行时和 Client API 目录；使用 Git 提交标题 "fix(tools): stabilize scheduler identity across entry points" 查找原始改动。
- **回归保护：**[工具注册测试](../packages/core/tools/tests/tools.spec.ts)；现有[调度决策记录](../.agents/notes/implemented/bug-fix/2026-09-19-stable-tool-scheduler-identity.zh.md)说明缘由。确认撤去本地修复后测试会失败，并覆盖相关的真实组合路径。
- **上游状态：**尚未与最新获取的上游版本核对。
- **退出条件：**移除 fork 专有代码后，标识共享及真实组合行为仍成立；保留测试或指出上游等效保护。

### F-004：在 profile 持久化前确认 Session 模型选择

- **行为：**Session 接受模型或推理强度选择后即返回，不等待可能缓慢的部署默认模型写入；默认配置写入保持顺序，失败不会撤销 Session 选择。
- **本地实现：**Session Controller 的模型选择命令在 Remote 响应之外按顺序执行尽力而为的 profile 写入。
- **回归保护：**[Session 选择与缓慢默认配置写入测试](../packages/api/session-controller/tests/session-models.host.spec.ts)验证写入受阻时选择响应仍能完成，后续写入保持顺序。
- **上游状态：**尚未与最新获取的上游版本核对。
- **退出条件：**集成后的实现若不靠 fork 专有代码，也能在 profile 持久化之外确认 Session 选择并通过相同回归测试，即可移除。

## 完成基线盘点

下一次集成上游之前，先对照新获取的上游版本盘点全部仅存在于本地的改动。给本页尚未覆盖的每项源码缺陷修复补充条目，并将个人 UI 风格、可移植性改动、纯测试改动和源码启动改动分别分类。写出回归测试名称并不等于验证通过；缺少测试是待办事项，不能算通过。核实后记录相应上游 issue 或 PR；只有撤去修复后测试通过，才能移除退出的条目。本页只保留当前需要维护的行为，不累积版本历史。
