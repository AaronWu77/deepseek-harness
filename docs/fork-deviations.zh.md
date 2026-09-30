# 现存 fork 偏差

[English](fork-deviations.md) | 中文

这里登记 fork 在合入上游更新时需要保留的源码行为，不是所有提交的清单：本地视觉风格和 profile 偏好由其他位置负责。日常分支现已包含 `dsh-v0.1.7-rc.2` 合并，并已在该分支通过以下检查：TypeScript 检查、GUI 测试、文档门禁、配置目录与包依赖门禁。尚未有撤去本地修复的测试使任何偏差退出，用户同意本轮 Windows 本地 fork 暂缓 Linux/POSIX bash Web 回放；该项仍未经验证，不能宣称通过。[同步流程](cookbook/syncing-the-fork.zh.md)规定准入和退出条件。

## 已记录的源码修复

### F-001：保留在有效沙箱模式下的执行

- **行为：**权限请求不扩大当前有效沙箱模式时，不得放弃本来允许执行的操作；不支持的模式仍须拒绝。
- **本地实现：**沙箱提权处理；使用 Git 提交标题 "fix(sandbox): run under the effective mode when a request cannot widen it" 查找原始改动。
- **回归保护：**[沙箱提权行为](../packages/sandbox/sandbox/tests/escalation.spec.ts)和 [PowerShell 执行行为](../packages/shell/tool-pwsh/tests/tools.spec.ts)。在合适的集成分支移除本地修复，确认相关断言会失败。
- **上游状态：**集成 rc.2 树上的指定守卫均通过；撤去 fork 专有实现并证明上游等效仍未验证。
- **退出条件：**移除本地实现后，相同行为测试及相关真实组合工具检查仍然通过。

### F-002：忽略不扩大的 run_code 权限请求

- **行为：**当前有效模式已经更宽时，请求较窄权限的 run_code 应直接执行，不能要求不可能发生的提权；格式错误或不支持的权限请求仍须失败。
- **本地实现：**PTC 工具分发；使用 Git 提交标题 "fix(tools): drop a non-widening sandbox request instead of failing run_code" 查找原始改动。
- **回归保护：**[PTC 工具分发测试](../packages/core/tools/tests/ptc.spec.ts)。撤去本地修复后，同时验证允许执行和拒绝非法请求两种行为。
- **上游状态：**集成 rc.2 树上的指定守卫均通过；撤去 fork 专有实现并证明上游等效仍未验证。
- **退出条件：**集成分支移除本地实现后测试仍通过；如果可见工具结果发生变化，还要运行相应产品路径检查。

### F-003：保持稳定的工具调度标识

- **行为：**不同入口的工具调用若共享调度策略，就必须使用相同的调度标识。
- **本地实现：**工具运行时和 Client API 目录；使用 Git 提交标题 "fix(tools): stabilize scheduler identity across entry points" 查找原始改动。
- **回归保护：**[工具注册测试](../packages/core/tools/tests/tools.spec.ts)；现有[调度决策记录](../.agents/notes/implemented/bug-fix/2026-09-19-stable-tool-scheduler-identity.zh.md)说明缘由。确认撤去本地修复后测试会失败，并覆盖相关的真实组合路径。
- **上游状态：**集成 rc.2 树上的指定守卫均通过；撤去 fork 专有实现并证明上游等效仍未验证。
- **退出条件：**移除 fork 专有代码后，标识共享及真实组合行为仍成立；保留测试或指出上游等效保护。

### F-004：在 profile 持久化前确认 Session 模型选择

- **行为：**Session 接受模型或推理强度选择后即返回，不等待可能缓慢的部署默认模型写入；默认配置写入保持顺序，失败不会撤销 Session 选择。
- **本地实现：**Session Controller 的模型选择命令在 Remote 响应之外按顺序执行尽力而为的 profile 写入。
- **回归保护：**[Session 选择与缓慢默认配置写入测试](../packages/api/session-controller/tests/session-models.host.spec.ts)验证写入受阻时选择响应仍能完成，后续写入保持顺序。
- **上游状态：**上游 PR #5173 也将默认模型写入移至后台，但 fork 仍保证并发写入顺序。合并后的行为测试在保留本地实现时通过；尚未通过移除测试证明等效。
- **退出条件：**合并后撤去 fork 专有代码，相同回归测试仍通过，并覆盖并发写入与错误处理。

### F-005：在 PTC 语法失败时提供正确提示

- **行为：**文件正文被误当程序源码粘贴而产生 run_code 解析错误时，应提示引用或 JSON 序列化正文，不能把错误误报为沙箱拒绝。
- **本地实现：**PTC 语法错误诊断及模型可见提示，由 [PTC 解析错误测试](../packages/core/tools/tests/ptc.spec.ts)和[会话提示词快照](../snapshots/session/ptc-turn/system-prompt.expected.md)保护。
- **上游状态：**合并后的 PTC 测试通过；撤去本地实现后的已记录模型可见输出仍需检查。
- **退出条件：**移除本地代码后，修正提示及可见输出仍通过测试，包括录制会话检查。

### F-006：只在明确的沙箱拒绝后请求提权

- **行为：**run_code 指令仅在明确拒绝后才要求更宽模式及非空理由；普通调用与只读调用均不填写这两个字段。
- **本地实现：**PTC schema 和沙箱拒绝文案，由[工具 schema 测试](../packages/core/tools/tests/ptc.spec.ts)及[沙箱提权测试](../packages/sandbox/sandbox/tests/escalation.spec.ts)保护。
- **上游状态：**合并后的 PTC schema 与提权守卫通过；上游变更后的描述仍需在移除本地提示后对比。
- **退出条件：**移除本地提示后，可见 schema 与拒绝行为仍遵守同一提权规则。

### F-007：验证工具 schema 的字符串 minLength

- **行为：**字符串长度约束以 Unicode 码点拒绝过短的工具参数，并拒绝非法长度及与 oneOf 冲突的字段。
- **本地实现：**JSON Schema 校验和工具 schema 转换，由 [schema 校验测试](../packages/core/tools/tests/json-schema.spec.ts)及[schema 转换测试](../packages/core/tools/tests/schema.spec.ts)保护。
- **上游状态：**合并后的验证器和投影守卫通过；撤去本地实现后的上游等效仍未验证。
- **退出条件：**撤去 fork 专有实现后，集成后的校验与转换测试仍通过。

### F-008：使用单个 Explorer 参数定位 Windows 文件

- **行为：**在 Explorer 中定位文件时，/select, 和目标必须作为同一个参数传入；拆开传参会导致定位失败。
- **本地实现：**原生路径打开器，由 [Windows 与 WSL 定位测试](../packages/util/native-command/tests/path-opener.spec.ts)保护。
- **上游状态：**合并后的 Windows 路径打开守卫通过；真实 Explorer reveal smoke 及移除对比仍待完成。
- **退出条件：**撤去本地实现后，测试及 Windows 定位冒烟检查仍通过。

### F-009：保持设置弹窗位于布局列上方

- **行为：**侧边栏设置弹窗必须可以点击，不能因为布局列创建层叠上下文而被会话内容覆盖。
- **本地实现：**布局及侧边栏样式，由[布局列层叠测试](../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts)保护。
- **上游状态：**合并后的布局守卫、GUI 套件及 Sidebar 浏览器路径通过；撤去本地 stacking 行为后仍需浏览器检查。
- **退出条件：**撤去本地样式后，静态测试与真实浏览器交互均证明弹窗可点击。

### F-010：隐藏已折叠右侧栏的遮罩

- **行为：**右侧栏折叠后，半透明遮罩不能继续绘制到会话区域。
- **本地实现：**[右侧栏样式表](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css)；[Chromium 回归测试](../apps/web/tests/sidebar-right.e2e.ts)验证遮罩在折叠时不绘制、展开时出现，并在再次折叠后消失。
- **上游状态：**专项 Chromium 测试在合并分支保留 fork CSS 时通过。尚未运行移除测试；完整 Web 回放仍有失败。
- **退出条件：**撤去 fork 专有 CSS 后，折叠与展开的浏览器测试及相关 Web 回放仍通过。

### F-011：保留最新的模型选择结果

- **行为：**选择器在持久状态追上前保留已确认的模型，忽略先前请求的迟到失败，并在连接重置或销毁后撤销迟到结果。
- **本地实现：**ModelDirectory 及选择器界面，由[目录竞态测试](../packages/client/ui-model-selection/tests/directory.client.spec.ts)、[选择器测试](../packages/client/ui-model-selection/tests/model-select.client.spec.tsx)和 [Host 集成测试](../packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts)保护。
- **上游状态：**合并后的目录保留 fork 的选择竞态处理，并加入 rc.2 的目录和待处理控件。专项测试通过；移除本地行为与验证构建后的浏览器路径仍须分别完成。
- **退出条件：**撤去本地行为后，上述选择与生命周期测试及相关浏览器路径仍通过。

### F-012：确保 Windows 仓库检查可执行

- **行为：**Windows 上读取已追踪的 Loader 配置和建立临时 NodeNext consumer 链接无需目录符号链接权限；失败时提示出错阶段。
- **本地实现：**已追踪配置读取器及 NodeNext 目录链接辅助函数，由[配置读取测试](../scripts/read-tracked-loader-config.spec.ts)及[目录链接测试](../scripts/node-next-directory-link.spec.ts)保护。
- **上游状态：**合并后的 tracked-config 与 directory-link 守卫通过；保留本地辅助函数时，完整 Windows hygiene lane 的 18 项门禁均通过。撤去后的等效性仍未验证。
- **退出条件：**撤去本地辅助函数后，上游等效检查仍在 Windows 通过，并继续拒绝无效 Loader 配置。

### F-013：跳过公告生成中缺失的虚拟清单

- **行为：**生成打包第三方许可证公告时，扫描虚拟存储候选目录，若其中没有目标包的清单文件，应跳过该目录而不是让整个盘点失败。
- **本地实现：**公告生成器，由[虚拟清单测试](../scripts/gen-third-party-notices.spec.ts)保护。
- **上游状态：**合并后的生成器测试和公告生成检查在保留本地修复时通过；尚未运行移除测试证明上游等效。
- **退出条件：**撤去本地实现后，生成器及清单缺失测试仍通过。

### F-014：避免 vendor 重命名误改 UI 语言标识

- **行为：**vendor 包名重写应保留恰好与包名相同的 UI 字典标识，同时继续改写真正的包引用。
- **本地实现：**vendor 重命名脚本，由[重命名分类测试](../scripts/rescope-vendor.spec.ts)保护。
- **上游状态：**上游按文件跳过的规则掩盖了 fork 对包引用的精准改写；合并后的分类测试发现问题。移除该规则后，行为和 vendor 重命名检查均通过。
- **退出条件：**撤去本地例外后，相同测试及 vendor 同步检查仍通过。

### F-015：让全屏右侧栏贴合整个视口

- **行为：**即使 Aurora 玻璃三栏窗口有外边距，全屏右侧栏仍覆盖视口；普通面板继续停靠在内缩窗口内。
- **本地实现：**[右侧栏样式表](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css)，由[全屏浏览器场景](../apps/web/tests/sidebar-right.e2e.ts)保护。
- **上游状态：**合并后的绝对定位面板止于内缩窗口。固定定位并采用 border-box 后，16 项右侧栏浏览器检查均通过（含窄屏）；Desktop runtime 构建通过，但 Electron 原生交互、打包及完整 Web 回放仍待验证。
- **退出条件：**移除 fork 定位规则后，普通停靠与全屏视口覆盖在 Chromium 和 Desktop 中仍正确。

### F-016：让 macOS Aurora 顶部留白可拖动

- **行为：**内缩玻璃窗口上方的环境色带属于 macOS 窗口拖动区域，但窗口内的交互控件不能因此变成拖动目标。
- **本地实现：**[框架样式表](../packages/client/ui-layout/src/client/AppFrame.module.css)，由[macOS 浏览器拖动场景](../apps/web/tests/window-drag-coverage.e2e.ts)保护。
- **上游状态：**Aurora 外边距使顶端色带位于 rc.2 的 chrome 标题拖动区之外。新增色带后，五项 macOS 浏览器拖动检查均通过，Desktop runtime 构建也通过；Electron 原生窗口交互仍待验证。
- **退出条件：**移除这段拖动样式后，顶端没有无法拖动的区域，交互控件也不会变为窗口拖动目标。

### F-017：侧边栏徽标固定显示个人品牌

- **行为：**侧边栏品牌始终显示个人 AW 标志与固定的 `Studio` 字样，任何语言下都不再显示构建版本、提交或 dirty 标记。
- **本地实现：**[标志组件](../packages/client/ui-sidebar/src/client/BrandMark.tsx)、[徽标标记](../packages/client/ui-sidebar/src/client/SidebarRoot.tsx)，以及 [zh](../packages/client/locale/src/locales/zh.ts) 与 [en](../packages/client/locale/src/locales/en.ts) 字典中值同为 `Studio` 的 `brand.wordmark` 键，由[侧边栏徽标测试](../packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx)和[侧边栏外壳快照](../packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap)保护。
- **上游状态：**上游用 `brand.localBuild` 加上 `DSH_CLIENT_VERSION`、`DSH_CLIENT_COMMIT_HASH` 和 `DSH_CLIENT_GIT_DIRTY` 组合同一徽标。`sidebar.brand.mark` 与 `sidebar.brand.name` 插槽仍是 profile 级覆盖点。
- **退出条件：**不再需要该个人标志与固定标题，或改用 profile 覆盖替代源码改动。

### F-018：运行状态不依赖上游品牌插画

- **行为：**运行状态使用共享的主题矢量加载图标及其减少动态效果处理，不使用鲸鱼图片或独立动画计时器；实时耗时和无障碍播报保持不变。
- **本地实现：**[运行状态](../packages/client/ui-chat/src/client/chat/RunningStatus.tsx)及其[样式表](../packages/client/ui-chat/src/client/chat/ChatView.module.css)复用 StateDot；Client bundle 不包含运行图片复制步骤。
- **回归保护：**[运行状态测试](../packages/client/ui-chat/tests/running-status.client.spec.tsx)及 [ChatView 集成测试](../packages/client/ui-chat/tests/chat-view.client.spec.tsx)检查装饰性矢量图标、实时计时、礼貌播报，以及 Session 停止后的移除。
- **上游状态：**0.2.0-rc.2 使用动态鲸鱼遮罩和静态鲸鱼后备图标；本 fork 保留 [Chat README](../packages/client/ui-chat/README.zh.md)所述的 Aurora 呈现。
- **退出条件：**受支持的 profile 级覆盖能提供相同行为的 Aurora 图标，或上游将运行装饰改为品牌无关实现。

### 外部插件兼容性

六个树外 bundle `dsh-codex-connect`、`dsh-better-sidebar`、`dsh-find-plugin`、`dsh-context`、`dsh-daily-planner` 与 `dsh-pointer-trails` 已各自在所属仓库中接受 `0.1.7-rc.2`，并保留 peer 原本允许的较早版本。它们在 rc.2 上的安装、类型检查、构建与测试均通过，六个都能在 rc.2 profile 中加载。兼容改动主要是 peer 范围与依赖锁定；dsh-context 另按固定间隔重新读取平台余额，使常驻的额度组件跟随账户而不是跟随挂载时刻。仍有两项消费者路径限制，均由插件仓库自己承担：已发布的 rc.2 UI primitives 与 client-store bundle 需要 `@deepseek-ai/dsh-util-code-language`、Zustand 与 Immer，而仓库 `verify-package-dependencies` 门禁要求这些 Client 浏览器构建输入保持 dev dependency，因此相关插件仅在测试中声明它们；Codex Connect 的 `ModelDirectoryState` fixture 已带上 rc.2 新增的 `pending` 字段。已发布包的消费者路径仍需符合政策的构建或加载修复及独立安装验证。

## 其他本地改动及待核查项

本地视觉选择由 [Aurora glass 设计决策](../.agents/notes/implemented/feature/2026-09-17-aurora-glass-visual-language.zh.md)负责，不能当作上游缺陷修复。[本地 Web 启动脚本](../scripts/build-and-run-web.cmd)包含机器专属绝对路径并跳过重新构建；在作为 Desktop 开发依据前，应移到共享源码之外或改为可移植实现。纯测试补充及生成快照由对应行为负责，不是独立的现存修复。

历史 Workspace 导航修复与 fork 已集成的上游基线之间已无源码差异；现存[导航测试](../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts)仍有价值，但这不是当前 fork 专有实现。一份旧版默认 preset 恢复决策仍声称会把已退役的 preset 标识映射为 PTC，但原 agent-presets 包及回归测试已不在当前源码树中。新的[预设注册表策略](../packages/preset/agent-preset-registry/src/index.ts)读取默认选择时没有显式映射。先查明旧设置值能否进入新注册表，再判定是否回归或退出[原始决策记录](../.agents/notes/implemented/bug-fix/2026-09-17-retired-preset-default-recovery.zh.md)；若能进入，补充现行路径测试。

[Windows Queue 操作回放](../apps/web/tests/queue-actions.e2e.ts)在本平台仍未通过：排队中的消息正在发送时，正在运行的 Turn-process 控件处于禁用且折叠态，但现有 golden 预期禁用且展开并显示部分推理。随后出现的 replay 未完全消耗及等待响应错误由该断言失败引起。[本包 live-Turn 测试](../packages/client/ui-chat/tests/chat-view.client.spec.tsx)通过，且要求禁用但展开的控件，因此浏览器差异不是已批准的显示策略变更。turn-process 视图、其样式表、共享的 disclosure 原语与 golden 均与上一版本一致，因此该浏览器差异早于本次合并，仍需继续查明；没有削弱产品行为或 golden。

## 完成基线盘点

下一次集成上游之前，先对照新获取的上游版本盘点全部仅存在于本地的改动。给本页尚未覆盖的每项源码缺陷修复补充条目，并将个人 UI 风格、可移植性改动、纯测试改动和源码启动改动分别分类。写出回归测试名称并不等于验证通过；缺少测试是待办事项，不能算通过。核实后记录相应上游 issue 或 PR；只有撤去修复后测试通过，才能移除退出的条目。本页只保留当前需要维护的行为，不累积版本历史。
