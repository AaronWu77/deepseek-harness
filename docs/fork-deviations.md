---
kind: reference
description: "Reference active RC2 Host deviations, repository support, and optional preset extensions."
---
# Fork deviations

English | [中文](fork-deviations.zh.md)

<a id="summary"></a>
## Summary

This reference lists active Host and repository-support deviations from official `dsh-v0.2.1-rc.2`. Identifiers remain stable and gaps are intentional; they do not count new features or changed files. Upstream behavior and optional personal-skin features are excluded from the active registry. Review-Gated and preset selectability are additional extensions described separately below.

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
| Model selection | F-011 | The Client preserves acknowledged selections without stale responses or failures replacing newer choices. |
| Platform and layout | F-008, F-010, F-015, F-016 | Host retains Windows path-opening arguments, collapsed scrim suppression, viewport fullscreen panels, and native drag regions. |
| Build and test support | F-012–F-014, F-021 | Repository scripts handle tracked Loader links, notices, rescope exclusions, and explicit recording inputs. |
| Team membership | F-020 | The optional Team package validates roster membership; unrelated provider children must not acquire Team-lead behavior. |

Out-of-tree plugins selected in a profile are separate installations, not edits to official Host source. Their own package documentation defines their behavior. Neither selecting a bundle nor retaining a preservation ID establishes that every native platform, replay fixture, or model route has been verified.

### Related documentation

| Question | Owning document |
|---|---|
| Personal-skin installation, updates, and first-migration rollback | [dsh-skin deployment](https://github.com/AaronWu77/dsh-skin/blob/main/DEPLOY.md) |
| Slots, semantic hooks, and skin restrictions | [Web styling](web-styling.md#optional-skins) |
| Collapse, fullscreen, and independent floating panes | [Right Sidebar presentations](../packages/client/ui-sidebar-right/README.md#presentations) |
| Shell clipping, content scrolling, and native chrome | [Layout skin integration](../packages/client/ui-layout/README.md#skin-integration) |
| Default-model saves and Session acknowledgements | [Session Controller](../packages/api/session-controller/README.md) |

<a id="review-gated-presets"></a>
## Review-Gated presets

The optional [Review-Gated bundle](../packages/experimental/review-gated/README.md) keeps delivery in one main conversation with optional managed one-shot workers and reviewers. Its single Host settings document starts unconfigured; new RG Sessions freeze role model pools, defaults, reasoning choices, reviewer inheritance, and attempt limits. Each role defaults to two accepted attempts per human task; failure or cancellation does not refund them. Structured PTC reports and scope rechecks determine recorded review status.

Only RG is selectable; role presets require reserved child starts. The local [preset registry extension](../packages/preset/agent-preset-registry/README.md#understand-the-implementation) initializes consumers after a blank-session selection commits. Main may work directly. Review is neither a delivery gate nor a permission grant, and reviewer read-only behavior is guidance. Existing Host approvals and depth limits still apply. Legacy RG Sessions gain no automatic authorization; see the [upgrade guide](upgrade-guide/v0.2.2-rc.1/rg-model-pools/guide.md). Installing the bundle does not convert ordinary Sessions.

## Local one-shot activation

The customized Host includes a local extension to [Subagent](subsystems/subagent.md) for Review-Gated roles. Explicit `lifecycle: 'one-shot'` dispatches detached provider preparation while the existing manager owns real local child creation, permissions, working directory, preset composition, execution and cleanup. The child uses the existing one-shot descriptor and catalog formats and cannot accept follow-up input or cold resume. The extension does not change default dispatch, continuable activation or external provider execution.

The behavioral owner is local-one-shot.spec.ts, with adjacent external activation, policy, preset and directory regressions. Retire this deviation when upstream provides equivalent public local-one-shot activation and the Review-Gated role and package suites pass against it without the extension. The upstream package version does not identify this local extension. Its presence does not require the Review-Gated plugin to be loaded.

## Preservation registry

These identifiers name current local implementations, not a list of optional features to extract from the Host. Source-test evidence does not establish upstream retirement, native-platform equivalence, built-profile compatibility, or completed deployment. The runtime keeps `native` and `ptc` presentation modes; it does not restore `both`. The Aurora frame retains the bottom shell slot and elevated scrollbars.

### Runtime patches

| ID | Behavior and source owner | Closest focused guard | Qualification |
|---|---|---|---|
| F-001 | [Effective mode for supported non-widening requests](../packages/sandbox/sandbox/src/escalation.ts) | [Guard](../packages/sandbox/sandbox/tests/escalation.spec.ts) | Source tests passed; native confinement pending |
| F-002 | [Drop non-widening PTC permission requests](../packages/core/tool-executor-ptc/src/ptc.ts) | [Guard](../packages/core/tool-executor-ptc/tests/ptc.spec.ts) | Source tests passed |
| F-005 | [Program syntax and serialization diagnostics](../packages/core/tool-executor-ptc/src/ptc.ts) | [Guard](../packages/core/tool-executor-ptc/tests/ptc.spec.ts) | Source tests passed; recorded headers pending |
| F-006 | [Explicit-denial and strictly wider escalation guidance](../packages/core/tool-executor-ptc/src/ptc.ts) | [Guard](../packages/core/tool-executor-ptc/tests/ptc.spec.ts) | Source tests passed; recorded headers pending |
| F-007 | [Unicode-code-point string minLength validation](../packages/core/tools/src/json-schema.ts) | [Guard](../packages/core/tools/tests/json-schema.spec.ts) | Source tests passed |
| F-008 | [Single Explorer selection argument](../packages/util/native-command/src/path-opener.ts) | [Guard](../packages/util/native-command/tests/path-opener.spec.ts) | Source tests passed; Explorer and WSL pending |
| F-010 | [Immediate collapsed scrim removal](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css) | [Animation and float guards](../apps/web/tests/sidebar-skin-layout.e2e.ts) | Real-profile guards passed with skin on and off |
| F-011 | [Acknowledged model selections and stale-failure suppression](../packages/client/ui-model-selection/src/client/directory.ts) | Guard | Directory and component guards passed |
| F-015 | [Viewport fullscreen with solid backing](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css) | [Viewport and backing guards](../apps/web/tests/sidebar-skin-layout.e2e.ts) | Real-profile browser guards passed; native desktop pending |
| F-016 | [Draggable exposed macOS Aurora strip](../packages/client/ui-layout/src/client/AppFrame.module.css) | [Guard](../apps/web/tests/window-drag-coverage.e2e.ts) | Structural guard passed; native desktop pending |
| F-020 | [Exclude nonrostered provider children from Teams](../packages/experimental/agent-team/src/roster.ts) | Guard | Real YAML Loader and local-one-shot guards passed; old same-format recording unresolved |

### Repository, build, and recording support

These entries serve contributors and release workflows; they are not additional runtime features of ordinary conversations.

| ID | Behavior and source owner | Closest focused guard | Qualification |
|---|---|---|---|
| F-012 | [Tracked Loader links and Windows junctions](../scripts/read-tracked-loader-config.ts) | [Guard](../scripts/read-tracked-loader-config.spec.ts) | Helper tests passed; one native symlink case skipped |
| F-013 | [Skip missing virtual-store notice manifests](../scripts/gen-third-party-notices.ts) | [Guard](../scripts/gen-third-party-notices.spec.ts) | Generator guards passed |
| F-014 | [Token-scoped rescope exclusions](../scripts/rescope-vendor.ts) | [Guard](../scripts/rescope-vendor.spec.ts) | Script guards passed |
| F-021 | [Explicit first recording and scripted model category](../packages/test-support/session-snapshot/src/session-files.ts) | [Guard](../packages/test-support/session-snapshot/tests/record-inventory.spec.ts) | Helper and manifest guards passed; complete profile replay pending |

Retire an entry only after its focused guard and relevant shipped-profile, model-visible, browser, or native-platform case pass without the local implementation. No entry is retired by structural inspection alone. The production same-format Team coexistence recording uses removed delegation arguments; its immutable predecessor remains external rehearsal input until a current-API owner is qualified.

<a id="upstream-behavior-not-counted-as-customization"></a>
## Upstream behavior not counted as customization

Official RC2 already serializes default-model saves, waits for configuration reconciliation, and isolates failed saves. The Session Controller acknowledges the Session selection without awaiting those saves; the [real-profile regression](../packages/api/session-controller/tests/session-models.host.spec.ts) covers overlapping selection and reload. Sidebar and center columns must not create an additional stacking context that traps overlays; the layout guard retains this upstream constraint without forbidding the window’s own layer.

Official RC2 already provides the running elapsed clock, the StateDot primitive, sidebar brand slots, Team infrastructure, Agent presets, and the 1017 model badge. The local running-glyph change selects StateDot instead of the whale; it does not introduce a clock. The default whale component, image, stylesheet, and image-inlining build configuration remain the upstream versions. Disabling the skin restores those defaults while keeping the running state, elapsed time, and accessible announcement.
