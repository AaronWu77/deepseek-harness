# Agent Note: code 到 PTC 更名后恢复已退役的 preset 默认值

Status: implemented

[English](2026-09-17-retired-preset-default-recovery.md) | 中文

## Problem

发布前的更名把随附 preset 标识从 `code` 改成了 `ptc`，没有提供兼容别名。settings 命名空间会在升级后保留用户选择的默认值，因此仍含有 `default: code` 的文档会让每个未显式指定的会话创建都以 `agent-preset/not-found` 失败。在 Web 中，这发生在点击工作区之后，使 composer 一直停留在工作区选择状态。

## Decision

模式选择开启时，`AgentPresets` 会把恰好为 `code` 的已保存默认值按更名后的随附 preset `ptc` 读取。这是只作用于 settings 的恢复：`code` 不会加入当前 preset 名单，显式的 `resolve('code')` 仍按未知标识处理。其他未知的已保存默认值仍会在会话尝试使用时失败；部署默认值与关闭模式选择时的行为不变。

[已发布的 Session 格式迁移](../architecture/2026-08-31-released-session-format-migrations.zh.md)继续负责 Session 头部和选择事件中的 `code` 到 `ptc` 转换；本备注覆盖的是独立的用户 settings 层。

## Alternatives considered

**把 `code` 加为名单别名**会让已退役标识重新成为当前 preset API，并可能让同一组装暴露两个名称，因此名单仍只使用 PTC。**把所有缺失的已保存默认值回退到部署默认值**会隐藏动态名单或用户创作中的错误，因此只恢复已知的更名值。**只在启动时改写 settings 文件**会在异步写入提交前留下竞争窗口，因此默认值解析本身会在会话组装前处理旧值。

## Consequences

从旧 preset 词汇升级的用户无需手动编辑 settings 文件即可创建新会话，名单也会将 `ptc` 标为生效的默认值。旧文本可能会保留到用户选择其他默认值为止；显式旧标识与其他不存在的标识仍然报错。

## Verification

agent-presets settings 测试覆盖名单标记、会话组装，以及迁移后对显式退役标识的拒绝。
