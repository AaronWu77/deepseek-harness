# Agent Note: Aurora glass visual language

Status: implemented

English | [中文](2026-09-17-aurora-glass-visual-language.zh.md)

## Problem

Every web-client surface painted an opaque fill — the frame and conversation column took `--dsw-alias-bg-base`, the sidebar took `--dsw-specific-sidebar-fill`, the composer card took `--dsw-specific-input-major`. `backdrop-filter` on a surface with nothing translucent behind it blurs a flat colour, so the glass tokens ui-theme already declared had no visible effect and the light page read as flat white. The product brief asks for an Apple-style translucent language whose main background tone is a flowing light purple/pink/blue.

## Decision

[ui-theme](../../../../packages/client/ui-theme/src/styles/design-platform.css) owns the palette. `--dsw-glass-fill`/`-raised`/`-sunken` are the translucent fills a surface picks by elevation, `--dsw-glass-stroke` and `--dsw-glass-highlight` are its hairline and specular edge, `--dsw-glass-blur`/`-strong`/`-thin` are the three `backdrop-filter` tiers, and `--dsw-glass-scrim` is the translucent sheet the conversation column paints so body text keeps its contrast over the ambient colour. `--dsw-aurora-1` through `--dsw-aurora-5` are five radial colour fields and `--dsw-aurora-drift` is their base period; `--dsw-glass-canvas` remains the static fallback for a host that renders no aurora layer. [base.css](../../../../packages/client/ui-theme/src/styles/base.css) declares the motion tokens those surfaces animate on.

[AppFrame](../../../../packages/client/ui-layout/src/client/AppFrame.tsx) splits into a stage and a floating window. The stage paints the canvas and takes `--dsw-glass-frame-gap` as padding; `.window` is the real three-column grid, inset by that gap, with `--dsw-glass-frame-radius`, a translucent `--dsw-glass-window` gradient, and the prominent elevation. The window deliberately carries no `backdrop-filter` — it sits directly on the ambient canvas, where a blur has no visible work to do and would only make the window a containing block for `position: fixed` descendants. The stage renders the ambient canvas: one element at `inset: -18%` behind the window, which is raised to `z-index: 1`, carrying all five aurora tokens as background images and drifting as a whole. Only `transform` is animated, which keeps the layer on the compositor, and `prefers-reduced-motion` stops it. The fields are sized above the viewport so neighbouring fields overlap; a field that covers only a corner leaves the canvas neutral wherever no other field reaches.

Each surface has one owner. The sidebar column carries the sidebar's glass in AppFrame, so `SidebarRoot` paints `transparent` rather than a second opaque fill over it. The conversation column paints `--dsw-glass-scrim` instead of an opaque base, and the composer seat's fade mask fades to the same scrim. The composer card takes `--dsw-glass-fill-raised` plus `--dsw-glass-blur-strong`, and rebinds its elevation stroke to `--dsw-glass-stroke` so the hairline matches the glass edge. The floating layers take the same treatment. The shared menu and dialog shells in [ui-primitives](../../../../packages/client/ui-primitives/src/Menu.module.css), and the [docking kit's](../../../../packages/client/ui-dockkit/src/components/dockkit.module.css) floating panel and context menu, take `--dsw-glass-fill-raised` plus `--dsw-glass-blur-strong` and rebind their elevation stroke to `--dsw-glass-stroke`, so a menu opened over the canvas reads as the same material as the composer. The base canvas is tinted purple-to-pink-to-blue rather than neutral, so the region between colour fields never falls back to grey, and the conversation scrim sits at 38% white — enough to hold text contrast without flattening the ambient colour underneath. `--dsw-glass-fill-accent` backs the user's own message bubble, the one surface in the transcript that carries identity colour. The right-hand panel paints the conversation's `--dsw-glass-scrim`, and the settings panel takes `--dsw-glass-fill-thick` — a fourth, more opaque tier for surfaces large and dense enough that the fill itself has to carry readability, which the shell tiers delegate to the canvas.

The ambient canvas deliberately carries no `filter: blur()`: a radial gradient with transparent stops is already soft, while a gaussian over viewport-sized layers would force large offscreen textures for no visible gain.

The transcript carries two more surfaces. An expanded tool call becomes a card — its summary row is the header and the body sits under it — while collapsed rows stay flat, so the cost of the language is the surfaces on screen rather than the calls in the log. [ui-theme](../../../../packages/client/ui-theme/src/styles/design-platform.css) also renders the code family (code, terminal, read, search, diff, web, JSON, and the tool card's IN/OUT body) as an **ink surface**: a dark translucent card in both themes, which the syntax palette is then tuned for in [shiki.css](../../../../packages/client/ui-theme/src/styles/shiki.css) — a light-background palette would leave half its tokens unreadable on that fill. Because the fill is dark while the label scale it inherits is not, each ink surface rebinds `--dsw-alias-label-primary`/`-secondary`/`-tertiary` to the `--dsw-code-ink*` scale on its own container, the same surface-scoped rebinding the elevation stroke and the scrollbar pair use. The composer's chips take the glass hairline and sunken fill, and the primary send control takes `--dsw-brand-gradient`, the one saturated gradient in the interface.

## The prefix pair the minifier collapses

A glass declaration is a pair: `-webkit-backdrop-filter` and `backdrop-filter`. The client bundle runs component sheets through a CSS minifier that collapses that pair into the **last** declaration, so a rule written standard-first, prefixed-second ships only the prefixed property. Chromium reports `CSS.supports('-webkit-backdrop-filter', 'blur(10px)') === false`, so the shipped declaration is inert: the surface kept its translucent fill and silently lost every blur. A live probe of the assembled app found zero elements with a computed `backdrop-filter` out of 372 — the whole glass language was fills only, and a screenshot cannot show the difference because a translucent fill over a pastel canvas looks like a blurred one. The pairs are ordered prefixed-first, and the [backdrop-filter spec](../../../../packages/client/ui-theme/tests/backdrop-filter-styles.client.spec.ts) rejects the reverse order across every package stylesheet.

## Glass is a leaf layer

A working `backdrop-filter` makes its element the containing block for `position: fixed` descendants. The sidebar column hosts the settings overlay, which is `position: fixed; inset: 0`, so painting the glass on the column itself resolved that overlay against a 288px column and collapsed the panel to the column's width. The column therefore paints its glass on a dedicated `.sidebarGlass` layer (`position: absolute; inset: 0; z-index: -1`) beneath its content, which keeps the blur without adopting the descendants. The composition still carries no backdrop-filter on the centre column for the same reason.

## Alternatives considered

**Animating `background-position` on a single gradient layer.** That repaints the whole canvas on the main thread every frame. One composited transform layer costs a single transform.

**Five independently drifting fields.** Kept for as long as it survived; the per-layer rasterization seam above is what retired it. The single layer drifts as a whole, which costs the counter-phase motion between fields.

**`backdrop-filter` on the conversation column.** The column sits directly on the aurora, so it would blur the canvas rather than anything in front of it, and pay for a full-viewport blur pass on top of the scrim.

**Putting the aurora on `body` as a fixed background.** `body` offers only its two pseudo-elements to animate, which caps the field count at two and prevents retargeting one field; the shell already owns the frame that the columns are laid out in.

**A `filter: blur()` wrapper around all five fields.** The fields are viewport-sized, so each filtered layer allocates its own offscreen texture — roughly 13 MB per layer at 2× DPR on a 1680×1050 window — to soften gradients that are already soft.

**Glass on tool cards and message cards too.** Per-frame blur cost scales with the blurred area, so the language stays on the shell and floating layers; transcript cards keep opaque fills.

## Consequences

The light theme now reads as a pastel canvas with translucent chrome; the language is opt-in per surface through the tokens, so a surface that stays opaque is unaffected. The cost is five always-composited layers plus four to six live `backdrop-filter` surfaces per screen, and body text over the aurora depends on `--dsw-glass-scrim` for its contrast. Dark mode keeps the same structure over the existing dark palette; this change tunes only its token values.

Frame pacing stayed at 60 fps (p95 16.8 ms, no jank frame) across 0, 4, and 12 glass surfaces at blur radii of 20, 44, and 150 px, measured at 1680×1050 @2× DPR on an RTX 4080 SUPER. The per-surface VRAM figure stays an estimate rather than a measurement: the Windows GPU process counters could not resolve it, differing by up to 190 MB between two samples of the same configuration.

## Why the aurora is one layer

The ambient canvas was five absolutely positioned spans, each a full-viewport composited layer carrying one large radial gradient. That left a visible vertical tonal seam in the transcript column at some drift phases. Flattening one field's background removed it, and putting all five gradients on a single element removed it too, so it was a multi-layer rasterization artifact rather than a layout or clipping fault: the scanline through the seam ran 4/5/6/5/6/2 across the five layers and 3/3/2/1/1/0/0/1 across one. Merging also drops four composited layers per frame. Softening the gradient stops and dropping `will-change: transform` did not fix it, so the layer count was the cause, not the ramp or the promotion hint.

## Testing

The raised glass tiers carry no palette rung, so the scrollbar contract's elevated-surface set — which the elevation ladder derives — could not see them. The [scrollbar spec](../../../../packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts) now names `--dsw-glass-fill` and `--dsw-glass-fill-raised` explicitly, so a scroll container drawn on glass still has to rebind, and leaves `--dsw-glass-fill-sunken` out because a recessed well is not an elevated surface.

The theme's stylesheet contracts cover the change: the elevation spec's stroke and derived-token rules, the corner-shape pairing, the scrollbar rebinding set, and the client-styles mount order. `pnpm exec vitest run packages/client ui-layout/ui-theme/ui-conversation/ui-sidebar` passes, as does the assembled-app boot through the packed preview deployment.
