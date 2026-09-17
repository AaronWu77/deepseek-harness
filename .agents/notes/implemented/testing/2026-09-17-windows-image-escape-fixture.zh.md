# Agent Note: 面向 Windows 的仓库图片越界检查夹具

Status: implemented

[English](2026-09-17-windows-image-escape-fixture.md) | 中文

## Problem

`publishableImage` 的否定测试从仓库夹具创建指向外部文件的文件符号链接。Windows 对该操作要求开发者模式或提升权限，因此文档门禁可能在执行仓库越界断言之前就失败。

## Decision

夹具创建外部文件，在 Windows 上用目录 junction、其它平台用目录符号链接把外部目录挂载到仓库内，然后通过这个链接目录访问文件。生产检查仍会解析文件的真实路径，并因解析结果位于仓库外而拒绝它。直接访问外部文件的断言继续与链接路径断言并存。

## Alternatives considered

**要求开发者模式或管理员权限。** 否决：测试夹具不应要求与路径归属规则无关的宿主策略。

**在 Windows 上跳过越界用例。** 否决：该否定断言保护文档发布器不复制仓库外文件，必须在原始夹具失败的平台上运行。

**Mock `realpathSync` 或生产辅助函数。** 否决：Mock 虽可避开权限失败，却不再验证强制安全规则所依赖的真实路径解析。

## Consequences

文档站点测试使用其它 Windows-safe 仓库夹具已经采用的目录链接原语。它无需特权创建文件链接，就能验证相关的目录遍历和真实路径越界行为；在宿主允许该链接类型时，生产实现仍支持文件符号链接。

## Verification

`scripts/project-doc-site.spec.ts` 同时覆盖链接文件路径和直接外部文件；`pnpm run doc-sync` 会在文档站点检查中包含该套件。
