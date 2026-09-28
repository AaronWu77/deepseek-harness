# 现存 fork 偏差

[English](fork-deviations.md) | 中文

这里登记 fork 在合入上游更新时可能仍需保留的源码行为，不是所有提交的清单：本地视觉风格和 profile 偏好由其他位置负责。源码基线仍在盘点中。已获取上游并比较源码，但尚未运行合并结果与撤去本地修复后的测试；不能只凭本页批准一次同步。[同步流程](cookbook/syncing-the-fork.zh.md)规定准入和退出条件。

## 已记录的源码修复

### F-001：保留在有效沙箱模式下的执行

- **行为：**权限请求不扩大当前有效沙箱模式时，不得放弃本来允许执行的操作；不支持的模式仍须拒绝。
- **本地实现：**沙箱提权处理；使用 Git 提交标题 "fix(sandbox): run under the effective mode when a request cannot widen it" 查找原始改动。
- **回归保护：**[沙箱提权行为](../packages/sandbox/sandbox/tests/escalation.spec.ts)和 [PowerShell 执行行为](../packages/shell/tool-pwsh/tests/tools.spec.ts)。在合适的集成分支移除本地修复，确认相关断言会失败。
- **上游状态：**已与获取的上游分支比较源码；合并结果及撤去本地补丁后的行为尚未验证。
- **退出条件：**移除本地实现后，相同行为测试及相关真实组合工具检查仍然通过。

### F-002：忽略不扩大的 run_code 权限请求

- **行为：**当前有效模式已经更宽时，请求较窄权限的 run_code 应直接执行，不能要求不可能发生的提权；格式错误或不支持的权限请求仍须失败。
- **本地实现：**PTC 工具分发；使用 Git 提交标题 "fix(tools): drop a non-widening sandbox request instead of failing run_code" 查找原始改动。
- **回归保护：**[PTC 工具分发测试](../packages/core/tools/tests/ptc.spec.ts)。撤去本地修复后，同时验证允许执行和拒绝非法请求两种行为。
- **上游状态：**已与获取的上游分支比较源码；合并结果及撤去本地补丁后的行为尚未验证。
- **退出条件：**集成分支移除本地实现后测试仍通过；如果可见工具结果发生变化，还要运行相应产品路径检查。

### F-003：保持稳定的工具调度标识

- **行为：**不同入口的工具调用若共享调度策略，就必须使用相同的调度标识。
- **本地实现：**工具运行时和 Client API 目录；使用 Git 提交标题 "fix(tools): stabilize scheduler identity across entry points" 查找原始改动。
- **回归保护：**[工具注册测试](../packages/core/tools/tests/tools.spec.ts)；现有[调度决策记录](../.agents/notes/implemented/bug-fix/2026-09-19-stable-tool-scheduler-identity.zh.md)说明缘由。确认撤去本地修复后测试会失败，并覆盖相关的真实组合路径。
- **上游状态：**已与获取的上游分支比较源码；合并结果及撤去本地补丁后的行为尚未验证。
- **退出条件：**移除 fork 专有代码后，标识共享及真实组合行为仍成立；保留测试或指出上游等效保护。

### F-004：在 profile 持久化前确认 Session 模型选择

- **行为：**Session 接受模型或推理强度选择后即返回，不等待可能缓慢的部署默认模型写入；默认配置写入保持顺序，失败不会撤销 Session 选择。
- **本地实现：**Session Controller 的模型选择命令在 Remote 响应之外按顺序执行尽力而为的 profile 写入。
- **回归保护：**[Session 选择与缓慢默认配置写入测试](../packages/api/session-controller/tests/session-models.host.spec.ts)验证写入受阻时选择响应仍能完成，后续写入保持顺序。
- **上游状态：**上游 PR #5173 也将默认模型写入移至后台，但本地实现还保证并发写入顺序。这是待验证的退出候选，不能直接认定重复。
- **退出条件：**合并后撤去 fork 专有代码，相同回归测试仍通过，并覆盖并发写入与错误处理。

### F-005：在 PTC 语法失败时提供正确提示

- **行为：**文件正文被误当程序源码粘贴而产生 run_code 解析错误时，应提示引用或 JSON 序列化正文，不能把错误误报为沙箱拒绝。
- **本地实现：**PTC 语法错误诊断及模型可见提示，由 [PTC 解析错误测试](../packages/core/tools/tests/ptc.spec.ts)和[会话提示词快照](../snapshots/session/ptc-turn/system-prompt.expected.md)保护。
- **上游状态：**已检查的上游源码没有本地诊断；合并后的模型可见输出尚未测试。
- **退出条件：**移除本地代码后，修正提示及可见输出仍通过测试，包括录制会话检查。

### F-006：只在明确的沙箱拒绝后请求提权

- **行为：**run_code 指令仅在明确拒绝后才要求更宽模式及非空理由；普通调用与只读调用均不填写这两个字段。
- **本地实现：**PTC schema 和沙箱拒绝文案，由[工具 schema 测试](../packages/core/tools/tests/ptc.spec.ts)及[沙箱提权测试](../packages/sandbox/sandbox/tests/escalation.spec.ts)保护。
- **上游状态：**上游修改了工具描述；合并后的提示与拒绝路径需要对比，不能无条件覆盖。
- **退出条件：**移除本地提示后，可见 schema 与拒绝行为仍遵守同一提权规则。

### F-007：验证工具 schema 的字符串 minLength

- **行为：**字符串长度约束以 Unicode 码点拒绝过短的工具参数，并拒绝非法长度及与 oneOf 冲突的字段。
- **本地实现：**JSON Schema 校验和工具 schema 转换，由 [schema 校验测试](../packages/core/tools/tests/json-schema.spec.ts)及[schema 转换测试](../packages/core/tools/tests/schema.spec.ts)保护。
- **上游状态：**在已检查的上游路径中未发现等效源码改动；合并后的行为尚未测试。
- **退出条件：**撤去 fork 专有实现后，集成后的校验与转换测试仍通过。

### F-008：使用单个 Explorer 参数定位 Windows 文件

- **行为：**在 Explorer 中定位文件时，/select, 和目标必须作为同一个参数传入；拆开传参会导致定位失败。
- **本地实现：**原生路径打开器，由 [Windows 与 WSL 定位测试](../packages/util/native-command/tests/path-opener.spec.ts)保护。
- **上游状态：**已检查的上游路径仍与本地不同；合并后的平台行为尚未验证。
- **退出条件：**撤去本地实现后，测试及 Windows 定位冒烟检查仍通过。

### F-009：保持设置弹窗位于布局列上方

- **行为：**侧边栏设置弹窗必须可以点击，不能因为布局列创建层叠上下文而被会话内容覆盖。
- **本地实现：**布局及侧边栏样式，由[布局列层叠测试](../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts)保护。
- **上游状态：**上游改动了共享布局；合并后的绘制顺序及指针事件需要浏览器验证。
- **退出条件：**撤去本地样式后，静态测试与真实浏览器交互均证明弹窗可点击。

### F-010：隐藏已折叠右侧栏的遮罩

- **行为：**右侧栏折叠后，半透明遮罩不能继续绘制到会话区域。
- **本地实现：**[右侧栏样式表](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css)；原始 CSS 修复没有新增针对性的行为回归测试。
- **上游状态：**上游修改了右侧栏样式。缺少浏览器回归测试与合并结果对比；此条目还不能用于放行发布。
- **退出条件：**先补充浏览器测试，证明撤去 fork 专有 CSS 后折叠与展开行为仍正确，再批准下一次集成。

### F-011：保留最新的模型选择结果

- **行为：**选择器在持久状态追上前保留已确认的模型，忽略先前请求的迟到失败，并在连接重置或销毁后撤销迟到结果。
- **本地实现：**ModelDirectory 及选择器界面，由[目录竞态测试](../packages/client/ui-model-selection/tests/directory.client.spec.ts)、[选择器测试](../packages/client/ui-model-selection/tests/model-select.client.spec.tsx)和 [Host 集成测试](../packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts)保护。
- **上游状态：**上游也修改了模型目录；必须比较合并后的行为，不能只根据文件名称保留补丁。
- **退出条件：**撤去本地行为后，上述选择与生命周期测试及相关浏览器路径仍通过。

### F-012：确保 Windows 仓库检查可执行

- **行为：**Windows 上读取已追踪的 Loader 配置和建立临时 NodeNext consumer 链接无需目录符号链接权限；失败时提示出错阶段。
- **本地实现：**已追踪配置读取器及 NodeNext 目录链接辅助函数，由[配置读取测试](../scripts/read-tracked-loader-config.spec.ts)及[目录链接测试](../scripts/node-next-directory-link.spec.ts)保护。
- **上游状态：**已检查的上游脚本没有这些辅助函数；需在集成工作区重新运行 Windows hygiene 检查。
- **退出条件：**撤去本地辅助函数后，上游等效检查仍在 Windows 通过，并继续拒绝无效 Loader 配置。

### F-013：跳过公告生成中缺失的虚拟清单

- **行为：**生成打包第三方许可证公告时，扫描虚拟存储候选目录，若其中没有目标包的清单文件，应跳过该目录而不是让整个盘点失败。
- **本地实现：**公告生成器，由[虚拟清单测试](../scripts/gen-third-party-notices.spec.ts)保护。
- **上游状态：**源码交集与生成公告检查仍需在集成后验证。
- **退出条件：**撤去本地实现后，生成器及清单缺失测试仍通过。

### F-014：避免 vendor 重命名误改 UI 语言标识

- **行为：**vendor 包名重写应保留恰好与包名相同的 UI 字典标识，同时继续改写真正的包引用。
- **本地实现：**vendor 重命名脚本，由[重命名分类测试](../scripts/rescope-vendor.spec.ts)保护。
- **上游状态：**尚未将上游与本地发布流程集成；退出前需重跑重命名检查。
- **退出条件：**撤去本地例外后，相同测试及 vendor 同步检查仍通过。

## 其他本地改动及待核查项

本地视觉选择由 [Aurora glass 设计决策](../.agents/notes/implemented/feature/2026-09-17-aurora-glass-visual-language.zh.md)负责，不能当作上游缺陷修复。[本地 Web 启动脚本](../scripts/build-and-run-web.cmd)包含机器专属绝对路径并跳过重新构建；在作为 Desktop 开发依据前，应移到共享源码之外或改为可移植实现。纯测试补充及生成快照由对应行为负责，不是独立的现存修复。

历史 Workspace 导航修复与 fork 已集成的上游基线之间已无源码差异；现存[导航测试](../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts)仍有价值，但这不是当前 fork 专有实现。一份旧版默认 preset 恢复决策仍声称会把已退役的 preset 标识映射为 PTC，但原 agent-presets 包及回归测试已不在当前源码树中。新的[预设注册表策略](../packages/preset/agent-preset-registry/src/index.ts)读取默认选择时没有显式映射。先查明旧设置值能否进入新注册表，再判定是否回归或退出[原始决策记录](../.agents/notes/implemented/bug-fix/2026-09-17-retired-preset-default-recovery.zh.md)；若能进入，补充现行路径测试。

## 完成基线盘点

下一次集成上游之前，先对照新获取的上游版本盘点全部仅存在于本地的改动。给本页尚未覆盖的每项源码缺陷修复补充条目，并将个人 UI 风格、可移植性改动、纯测试改动和源码启动改动分别分类。写出回归测试名称并不等于验证通过；缺少测试是待办事项，不能算通过。核实后记录相应上游 issue 或 PR；只有撤去修复后测试通过，才能移除退出的条目。本页只保留当前需要维护的行为，不累积版本历史。
