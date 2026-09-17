# Agent Note: 极光毛玻璃视觉语言

Status: implemented

[English](2026-09-17-aurora-glass-visual-language.md) | 中文

## Problem

Web 客户端的每个表面都刷不透明填充——框架与会话列取 `--dsw-alias-bg-base`，侧栏取 `--dsw-specific-sidebar-fill`，composer 卡片取 `--dsw-specific-input-major`。当身后没有任何半透明内容时，`backdrop-filter` 模糊的只是一块纯色，因此 ui-theme 早已声明的玻璃 token 毫无可见效果，浅色页面读起来是一片死白。产品要求的是 Apple 风格的半透明语言，且主要背景色调是流动的浅紫/粉/蓝。

## Decision

[ui-theme](../../../../packages/client/ui-theme/src/styles/design-platform.css) 持有配色。`--dsw-glass-fill`/`-raised`/`-sunken` 是表面按层级选用的半透明填充，`--dsw-glass-stroke` 与 `--dsw-glass-highlight` 是它的发丝描边与高光边，`--dsw-glass-blur`/`-strong`/`-thin` 是三档 `backdrop-filter`，`--dsw-glass-scrim` 是会话列铺的薄纱，让正文在环境色之上保住对比度。`--dsw-aurora-1` 至 `--dsw-aurora-5` 是五个径向色团，`--dsw-aurora-drift` 是它们的基础周期；`--dsw-glass-canvas` 仍是不渲染极光层时的静态退化。[base.css](../../../../packages/client/ui-theme/src/styles/base.css) 声明这些表面所用的运动 token。

[AppFrame](../../../../packages/client/ui-layout/src/client/AppFrame.tsx) 分成舞台与浮动窗口两部分。舞台铺画布，并以 `--dsw-glass-frame-gap` 作内边距；`.window` 才是真正的三栏网格，按该缝隙内缩，带 `--dsw-glass-frame-radius`、半透明的 `--dsw-glass-window` 渐变与 prominent 高度。窗口刻意不做 `backdrop-filter`——它直接坐在环境画布上，模糊没有可见的活可干，却会让窗口成为 `position: fixed` 后代的包含块。舞台绘制环境画布：`inset: -18%` 处的一个元素铺在列之下，列本身抬到 `z-index: 1`；五个极光 token 是它身上的五张背景图，整体一起漂移。动画只写 `transform`，图层因此留在合成器上；`prefers-reduced-motion` 会停止它。色团尺寸大于视口，使相邻色团互相重叠；只覆盖一角的色团会让画布在其他色团够不到的地方退回中性色。

每个表面只有一个归属。侧栏的玻璃面由 AppFrame 的列承载，因此 `SidebarRoot` 画 `transparent`，而不是再刷一层不透明填充把它盖住。会话列画 `--dsw-glass-scrim` 而非不透明底色，composer 座位的渐隐遮罩也淡出到同一张薄纱。composer 卡片取 `--dsw-glass-fill-raised` 加 `--dsw-glass-blur-strong`，并把它的 elevation 描边重新绑定为 `--dsw-glass-stroke`，让发丝线与玻璃边缘一致。浮层沿用同一套处理。[ui-primitives](../../../../packages/client/ui-primitives/src/Menu.module.css) 的共享菜单与对话框外壳，以及[停靠套件](../../../../packages/client/ui-dockkit/src/components/dockkit.module.css)的浮动面板与上下文菜单，取 `--dsw-glass-fill-raised` 加 `--dsw-glass-blur-strong`，并把 elevation 描边重绑为 `--dsw-glass-stroke`，因此在画布上展开的菜单与 composer 读起来是同一种材质。底色本身带紫→粉→蓝的走向，而不是中性色，因此色团之间的区域不会退回灰色；对话面薄纱停在 38% 白——足以撑住正文对比度，又不会把身下的环境色压平。`--dsw-glass-fill-accent` 用于用户自己的消息气泡，那是正文里唯一承载身份色的表面。这个气泡的形状由边缘而不是填充承担——1px 的顶部镜面高光叠一条极淡的下缘回光——因为气泡背后没有东西可让模糊去涂抹，只靠半透明读起来就是一块扁平的淡色卡片。右侧面板铺与会话列相同的 `--dsw-glass-scrim`；设置面板取 `--dsw-glass-fill-thick`——这是第四档、不透明度更高，用于大到密到必须让填充自己承担可读性的表面，而壳层档把这部分交给了画布。

环境画布刻意不带 `filter: blur()`：带透明色标的径向渐变本身已经足够柔和，而为视口尺寸的图层加高斯只会白白生成巨大的离屏纹理。

正文里还有两类表面。展开的工具调用会变成一张卡——摘要行是它的表头，正文压在下面——而收起的行保持扁平，因此这门语言的成本取决于屏上实际展开的表面数，而不是日志里有多少次调用。[ui-theme](../../../../packages/client/ui-theme/src/styles/design-platform.css) 还把代码族（代码、终端、读取、检索、差异、网页、JSON，以及工具卡的 IN/OUT 正文）渲染为**墨色表面**：两种主题下都是深色半透明卡片，[shiki.css](../../../../packages/client/ui-theme/src/styles/shiki.css) 的语法色板也据此调过——按浅底选的色板放到这块深底上会有一半读不出来。由于填充是深色而它继承的文字阶梯不是，每块墨色表面都在自己的容器上把 `--dsw-alias-label-primary`/`-secondary`/`-tertiary` 重绑到 `--dsw-code-ink*` 阶梯，用的是与 elevation 描边、滚动条变量同一套表面级重绑契约。composer 的 chip 取玻璃发丝线与下沉档填充，主发送控件取 `--dsw-brand-gradient`——界面上唯一一处饱和渐变。

## 被压缩器合并掉的前缀对

一条玻璃声明是一对：`-webkit-backdrop-filter` 与 `backdrop-filter`。客户端 bundle 会把组件样式表过一遍 CSS 压缩器，它把这一对合并成**最后一条**声明，因此写成"标准在前、前缀在后"的规则，产物里只剩前缀属性。Chromium 报告 `CSS.supports('-webkit-backdrop-filter', 'blur(10px)') === false`，于是这条声明完全无效：表面保住了半透明填充，却静默丢掉了全部模糊。对装配后应用的一次实时探测发现，372 个元素里没有一个计算出 `backdrop-filter`——整门玻璃语言只剩填充，而截图看不出差别，因为浅色画布上的半透明填充与模糊结果长得一样。现在所有配对都改成前缀在前，且 [backdrop-filter spec](../../../../packages/client/ui-theme/tests/backdrop-filter-styles.client.spec.ts) 会跨全部包样式表拒绝相反的顺序。

## 玻璃是一张叶子层

生效的 `backdrop-filter` 会让所在元素成为 `position: fixed` 后代的包含块。侧栏列里挂着设置浮层，而它是 `position: fixed; inset: 0`，因此把玻璃直接画在列上会把该浮层解析到一条 288px 宽的列里，面板被压成列的宽度。于是该列改为把玻璃画在内容之下、专用的 `.sidebarGlass` 层上（`position: absolute; inset: 0; z-index: -1`），既保住模糊又不再吸附后代。出于同一原因，中列同样不承载 backdrop-filter。

把玻璃移出列同时也撤掉了列的层叠上下文。壳层各列现在都不声明 `z-index`：带 `z-index` 的列会把它内部挂载的每一个 `position: fixed` 浮层关在里面——设置对话框挂在侧栏页脚、自己声明 `z-index: 1000`，却输给会话列自己的 `z-index`，被画到正文下面且收不到任何指针事件，于是设置根本点不动，那层半透明的正文覆盖还让它看起来像"面板本身是透明的"；`.window` 是壳层为环境画布定序所需的唯一层叠上下文，侧栏玻璃层改为靠绘制顺序落在内容之下而不是负 `z-index`，并由一条 [AppFrame 样式表 spec](../../../../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts) 守住这条规则——jsdom 渲染没有布局也没有绘制，看不见这类问题。

## Alternatives considered

**在单个渐变图层上动画 `background-position`。** 那会每帧在主线程重绘整块画布。一个合成器上的 transform 图层只要一次变换。

**五个各自独立漂移的色团。** 它存活了一段时间；上面那处逐层栅格化接缝就是它被撤掉的原因。单层整体漂移，代价是失去色团之间的反相运动。

**给会话列加 `backdrop-filter`。** 会话列直接坐在极光之上，模糊它等于模糊画布本身，而且要在薄纱之外再付一次全视口模糊。

**把极光作为固定背景放在 `body` 上。** `body` 只有两个伪元素可供动画，色团数量被卡在两个，也无法单独调整其中一个；而 shell 本就拥有列所布局的那个框架。

**用一层 `filter: blur()` 包住全部五个色团。** 色团是视口尺寸的，每个被滤镜的图层都要分配自己的离屏纹理——在 1680×1050、2× DPR 下每层约 13 MB——只为柔化本来就柔的渐变。

**把工具卡与消息卡也做成玻璃。** 每帧模糊开销随模糊面积增长，因此这门语言只停留在壳层与浮层上；对话内的卡片保持不透明填充。

## Consequences

浅色主题现在读起来是一块柔和彩色画布配半透明外壳；这门语言按表面经 token 逐处启用，保持不透明的表面不受影响。代价是五个常驻合成图层，加上每屏四到六个活跃的 `backdrop-filter` 表面；而极光之上的正文对比度依赖 `--dsw-glass-scrim`。深色模式在既有深色配色上沿用同一结构；本次改动只调整它的 token 取值。

帧节奏在 0、4、12 层玻璃、模糊半径 20、44、150 px 的全部组合下都保持 60 fps（p95 16.8 ms、无卡顿帧），测试环境为 1680×1050 @2× DPR 的 RTX 4080 SUPER。单层显存数字仍只是估算而非实测：Windows 的 GPU 进程计数器分辨不出它，同一配置两次采样之间就相差多达 190 MB。

## 为什么极光是一层

环境画布原本是五个绝对定位的 span，每个都是铺满视口的合成图层、各带一张大径向渐变。某些漂移相位下，正文列里会出现一道可见的竖向日阶接缝。把其中一个色团的背景改成纯色后接缝消失，把五张渐变合并到同一个元素后也消失，因此它是多图层栅格化的伪影，而不是布局或裁剪故障：穿过接缝的扫描线在五层版本上是 4/5/6/5/6/2，在单层版本上是 3/3/2/1/1/0/0/1。合并同时每帧少掉四个合成图层。软化色标和去掉 `will-change: transform` 都没能修好它，所以成因是图层数量，不是渐变斜率也不是提升提示。

## Testing

抬升档的玻璃填充不带任何调色板层级，因此滚动条契约那套由层级推导的"高层级表面集合"看不见它们。[滚动条 spec](../../../../packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts) 现在显式点名 `--dsw-glass-fill` 与 `--dsw-glass-fill-raised`，使画在玻璃上的滚动容器同样必须重绑；而 `--dsw-glass-fill-sunken` 被排除，因为凹槽并不是高层级表面。

主题的样式表契约覆盖了本次改动：elevation spec 的描边与派生 token 规则、corner-shape 配对、滚动条重绑定集合，以及 client-styles 的挂载顺序。`pnpm exec vitest run packages/client` 中 ui-theme/ui-conversation/ui-sidebar 相关的 spec 通过，打包后的 preview 部署也能完成真实应用的启动装配。
