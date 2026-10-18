---
kind: reference
description: "Map RC2 preservation requirements, optional skin ownership, and Review-Gated extensions."
---
# Fork deviations

English | [中文](fork-deviations.zh.md)

<a id="summary"></a>
## Summary

This reference compares the customized checkout with the official `dsh-v0.2.1-rc.2` baseline. The F-001–F-022 identifiers track the preservation requirements, not 22 new upstream features or a count of changed files. F-017, F-018, and F-022 are owned by optional `dsh-skin`; the other 19 requirements remain with their Host packages or repository scripts. Review-Gated and preset selectability are additional extensions described separately below.

## Table of Contents

- [Summary](#summary)
- [Ownership map](#ownership-map)
- [Review-Gated presets](#review-gated-presets)
- [Local one-shot activation](#local-one-shot-activation)
- [Preservation registry](#preservation-registry)
- [Upstream behavior not counted as customization](#upstream-behavior-not-counted-as-customization)

<a id="ownership-map"></a>
## Ownership map

| Area | Preservation IDs | Owner and purpose |
|---|---|---|
| Execution, permissions, and validation | F-001–F-003, F-005–F-007, F-019 | Host providers and tool execution keep effective permissions, diagnostics, scheduler identity, string validation, and scoped PTC SDK/schema/execution consistent. |
| Model selection | F-004, F-011 | Host and Client preserve acknowledged selections and ordered background saves without stale failures replacing newer choices. |
| Platform and layout | F-008–F-010, F-015, F-016 | Host retains Windows path-opening arguments, overlay-safe columns, collapsed scrim suppression, viewport fullscreen panels, and native drag regions. |
| Build and test support | F-012–F-014, F-021 | Repository scripts handle tracked Loader links, notices, rescope exclusions, and explicit recording inputs. |
| Team membership | F-020 | The optional Team package validates roster membership; unrelated provider children must not acquire Team-lead behavior. |
| Personal appearance | F-017, F-018, F-022 | `dsh-skin` owns AW/STUDIO branding, the StateDot running glyph, and Aurora glass/ink appearance through Host slots and semantic hooks. |

Out-of-tree plugins selected in a profile are separate installations, not edits to official Host source. Their own package documentation defines their behavior. Neither selecting a bundle nor retaining a preservation ID establishes that every native platform, replay fixture, or model route has been verified.

<a id="review-gated-presets"></a>
## Review-Gated presets

The optional [Review-Gated bundle](../packages/experimental/review-gated/README.md) adds RG, RG Worker, and RG Reviewer presets. RG keeps the main conversation and may delegate execution and review. Only RG is selectable for a new Session; the role presets remain available to child binding. This uses the local [preset selectability extension](../packages/preset/agent-preset-registry/README.md#use-this-package), which rejects non-selectable presets as user selections or deployment defaults.

Review is prompt guidance, not a runtime completion or permission gate. The three roles share their tool group and remain subject to existing Host approvals and subagent depth limits. Existing Sessions keep their starting preset. Installing the bundle does not turn every conversation into RG.

## Local one-shot activation

The customized Host includes a local extension to [Subagent](subsystems/subagent.md) for Review-Gated roles. Explicit `lifecycle: 'one-shot'` dispatches detached provider preparation while the existing manager owns real local child creation, permissions, working directory, preset composition, execution and cleanup. The child uses the existing one-shot descriptor and catalog formats and cannot accept follow-up input or cold resume. The extension does not change default dispatch, continuable activation or external provider execution.

The behavioral owner is [local-one-shot.spec.ts](../packages/subagent/subagent/tests/local-one-shot.spec.ts), with adjacent external activation, policy, preset and directory regressions. Retire this deviation when upstream provides equivalent public local-one-shot activation and the Review-Gated role and package suites pass against it without the extension. The upstream package version does not identify this local extension. Its presence does not require the Review-Gated plugin to be loaded.

## Preservation registry

These identifiers retain their behavior owners, including the three skin-owned entries; they are not a list of optional features to extract from the Host. Source-test evidence does not establish upstream retirement, native-platform equivalence, built-profile compatibility, or completed deployment. The runtime keeps `native` and `ptc` presentation modes; it does not restore `both`. The Aurora frame retains the bottom shell slot and elevated scrollbars.

| ID | Behavior and source owner | Closest focused guard | Qualification |
|---|---|---|---|
| F-001 | [Effective mode for supported non-widening requests](../packages/sandbox/sandbox/src/escalation.ts) | [Guard](../packages/sandbox/sandbox/tests/escalation.spec.ts) | Source tests passed; native confinement pending |
| F-002 | [Drop non-widening PTC permission requests](../packages/core/tools/src/ptc.ts) | [Guard](../packages/core/tools/tests/ptc.spec.ts) | Source tests passed |
| F-003 | [Shared scheduler identity across package resolutions](../packages/core/tools/src/index.ts) | [Guard](../packages/core/tools/tests/tools.spec.ts) | Source tests passed; assembled smoke pending |
| F-004 | [Ordered nonblocking default model saves](../packages/api/session-controller/src/commands.ts) | [Guard](../packages/api/session-controller/tests/session-models.host.spec.ts) | Host source tests passed |
| F-005 | [Program syntax and serialization diagnostics](../packages/core/tools/src/ptc.ts) | [Guard](../packages/core/tools/tests/ptc.spec.ts) | Source tests passed; recorded headers pending |
| F-006 | [Explicit-denial and strictly wider escalation guidance](../packages/core/tools/src/ptc.ts) | [Guard](../packages/core/tools/tests/ptc.spec.ts) | Source tests passed; recorded headers pending |
| F-007 | [Unicode-code-point string minLength validation](../packages/core/tools/src/json-schema.ts) | [Guard](../packages/core/tools/tests/json-schema.spec.ts) | Source tests passed |
| F-008 | [Single Explorer selection argument](../packages/util/native-command/src/path-opener.ts) | [Guard](../packages/util/native-command/tests/path-opener.spec.ts) | Source tests passed; Explorer and WSL pending |
| F-009 | [Columns without overlay-conflicting stacking contexts](../packages/client/ui-layout/src/client/AppFrame.module.css) | [Guard](../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts) | Structural and component guards passed; browser pending |
| F-010 | [Collapsed Aurora scrim suppression](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css) | [Guard](../apps/web/tests/sidebar-right.e2e.ts) | Browser guard retained; execution pending |
| F-011 | [Acknowledged model selections and stale-failure suppression](../packages/client/ui-model-selection/src/client/directory.ts) | [Guard](../packages/client/ui-model-selection/tests/directory.client.spec.ts) | Directory and component guards passed |
| F-012 | [Tracked Loader links and Windows junctions](../scripts/read-tracked-loader-config.ts) | [Guard](../scripts/read-tracked-loader-config.spec.ts) | Helper tests passed; one native symlink case skipped |
| F-013 | [Skip missing virtual-store notice manifests](../scripts/gen-third-party-notices.ts) | [Guard](../scripts/gen-third-party-notices.spec.ts) | Generator guards passed |
| F-014 | [Token-scoped rescope exclusions](../scripts/rescope-vendor.ts) | [Guard](../scripts/rescope-vendor.spec.ts) | Script guards passed |
| F-015 | [Viewport-fixed fullscreen right panels](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css) | [Guard](../apps/web/tests/sidebar-right.e2e.ts) | Browser guard retained; native desktop pending |
| F-016 | [Draggable exposed macOS Aurora strip](../packages/client/ui-layout/src/client/AppFrame.module.css) | [Guard](../apps/web/tests/window-drag-coverage.e2e.ts) | Structural guard passed; native desktop pending |
| F-017 | [Sidebar brand slots](../packages/client/ui-sidebar/README.md#skin-integration) occupied by optional `dsh-skin` | The plugin owns brand and teardown tests | Personal artwork is not a Host fallback |
| F-018 | Optional `dsh-skin` replaces the [running glyph](../packages/client/ui-chat/README.md#skin-integration) with StateDot | [Clock guard](../packages/client/ui-chat/tests/running-status.client.spec.tsx); [real-profile glyph switching](../apps/web/tests/skin-running-icon.e2e.ts) | Host retains the upstream whale fallback and elapsed clock |
| F-019 | [Scoped PTC provider for SDK, schema and execution](../packages/core/tools/src/index.ts) | [Guard](../packages/core/agent-tool-presentation/tests/loader-composition.spec.ts) | Real YAML Loader guards passed; profile replay needs built Typert artifacts |
| F-020 | [Exclude nonrostered provider children from Teams](../packages/experimental/agent-team/src/roster.ts) | [Guard](../packages/experimental/agent-team/tests/non-team-subagent-membership.spec.ts) | Real YAML Loader and local-one-shot guards passed; old same-format recording unresolved |
| F-021 | [Explicit first recording and scripted model category](../packages/test-support/session-snapshot/src/session-files.ts) | [Guard](../packages/test-support/session-snapshot/tests/record-inventory.spec.ts) | Helper and manifest guards passed; complete profile replay pending |
| F-022 | Optional `dsh-skin` owns the personal [glass and ink styling](web-styling.md#optional-skins) | The plugin owns palette, rendering-safety and browser checks | Host retains neutral structural and interaction rules |

Retire an entry only after its focused guard and relevant shipped-profile, model-visible, browser, or native-platform case pass without the local implementation. No entry is retired by structural inspection alone. The production same-format Team coexistence recording uses removed delegation arguments; its immutable predecessor remains external rehearsal input until a current-API owner is qualified.

<a id="upstream-behavior-not-counted-as-customization"></a>
## Upstream behavior not counted as customization

Official RC2 already provides the running elapsed clock, the StateDot primitive, sidebar brand slots, Team infrastructure, Agent presets, and the 1017 model badge. The local running-glyph change selects StateDot instead of the whale; it does not introduce a clock. The default whale component, image, stylesheet, and image-inlining build configuration remain the upstream versions. Disabling the skin restores those defaults while keeping the running state, elapsed time, and accessible announcement.
