# Active fork deviations

English | [中文](fork-deviations.zh.md)

This is the working inventory of source behavior this fork may need to retain across upstream integrations. It is not a list of all commits: local product styling and profile preferences have different owners. The source inventory is still being audited. The isolated rc.2 integration has passed focused model-selection checks, the GUI suite and the TypeScript check; no local-fix removal test or external-plugin compatibility check has approved a sync. The Linux/POSIX bash Web replay remains unverified and is deferred for this Windows-only local trial at the user’s request; do not report it as passing. Do not use this page alone to approve a daily-branch sync. The [synchronization procedure](cookbook/syncing-the-fork.md) defines admission and retirement.

## Recorded source fixes

### F-001: Preserve execution under an effective sandbox mode

- **Behavior:** A permission request that does not widen the effective sandbox mode must not discard the permitted operation; unsupported modes still fail closed.
- **Local implementation:** Sandbox escalation handling; find the original change by the Git subject "fix(sandbox): run under the effective mode when a request cannot widen it".
- **Regression guard:** [sandbox escalation behavior](../packages/sandbox/sandbox/tests/escalation.spec.ts) and [PowerShell execution behavior](../packages/shell/tool-pwsh/tests/tools.spec.ts). Verify the relevant assertions fail when the local correction is removed on a suitable integration branch.
- **Upstream status:** The named integrated guards pass on the rc.2 tree; removing the fork-only implementation and proving upstream equivalence remain unverified.
- **Retire when:** The same behavioral guards and relevant composed tool checks pass with the local implementation removed.

### F-002: Ignore a non-widening run_code request

- **Behavior:** Under an already broader effective mode, a run_code request for a narrower permission must execute without asking for impossible escalation; malformed or unsupported permission requests still fail.
- **Local implementation:** PTC tool dispatch; find the original change by the Git subject "fix(tools): drop a non-widening sandbox request instead of failing run_code".
- **Regression guard:** [PTC tool dispatch tests](../packages/core/tools/tests/ptc.spec.ts). Verify both allowed execution and invalid-request rejection without the local correction.
- **Upstream status:** The named integrated guards pass on the rc.2 tree; removing the fork-only implementation and proving upstream equivalence remain unverified.
- **Retire when:** The guards pass on the integrated branch without the local implementation, including a product-path check if the observable tool result changes.

### F-003: Keep a stable tool scheduler identity

- **Behavior:** Tool dispatch through different entry points must use the same scheduler identity when they share scheduling policy.
- **Local implementation:** Tool runtime and Client API catalog; find the original change by the Git subject "fix(tools): stabilize scheduler identity across entry points".
- **Regression guard:** [tool registry test](../packages/core/tools/tests/tools.spec.ts); the existing [scheduler decision record](../.agents/notes/implemented/bug-fix/2026-09-19-stable-tool-scheduler-identity.md) carries the rationale. Confirm the guard fails without the local correction and covers the relevant composed route.
- **Upstream status:** The named integrated guards pass on the rc.2 tree; removing the fork-only implementation and proving upstream equivalence remain unverified.
- **Retire when:** A shared identity and composed behavior survive removal of the fork-only code; retain or identify equivalent upstream coverage.

### F-004: Acknowledge Session model selection before profile persistence

- **Behavior:** An accepted model or reasoning-effort selection returns after the Session changes even if writing the deployment default is slow; default writes remain ordered and failures do not roll back the Session.
- **Local implementation:** Session Controller model-selection command serializes best-effort profile writes outside the Remote response.
- **Regression guard:** [Session selection and slow default writes](../packages/api/session-controller/tests/session-models.host.spec.ts) checks that selection responses settle before a blocked profile write and that later writes keep their order.
- **Upstream status:** Upstream PR #5173 also saves the default in the background, but the fork still orders overlapping saves. The integrated behavior test passes with that code retained; no removal test has established equivalence.
- **Retire when:** The same regression passes without fork-only code after integration, including overlapping saves and error handling.

### F-005: Explain PTC syntax failures without retrying a sandbox

- **Behavior:** A run_code parser error caused by pasting file contents as program source suggests quoting or JSON-serializing that content, without disguising the failure as a sandbox denial.
- **Local implementation:** PTC syntax-error diagnostic and model-facing prompt, guarded by [PTC parser-error tests](../packages/core/tools/tests/ptc.spec.ts) and [session prompt snapshots](../snapshots/session/ptc-turn/system-prompt.expected.md).
- **Upstream status:** The integrated PTC tests pass; the recorded model-visible output still needs a post-removal check.
- **Retire when:** The correction and its visible guidance pass with local code removed, including a recorded-session check.

### F-006: Reserve escalation for explicit sandbox denials

- **Behavior:** run_code guidance asks for a strictly wider mode and a non-empty justification only after an explicit denial; ordinary and read-only calls omit both fields.
- **Local implementation:** PTC schema and sandbox refusal text, guarded by [tool-schema tests](../packages/core/tools/tests/ptc.spec.ts) and [sandbox escalation tests](../packages/sandbox/sandbox/tests/escalation.spec.ts).
- **Upstream status:** The integrated PTC schema and escalation guards pass; the changed upstream descriptions still need a removal comparison.
- **Retire when:** Without the local guidance, the visible schema and denial behavior still enforce the same escalation rule.

### F-007: Validate string minLength in tool schemas

- **Behavior:** String length constraints reject too-short tool arguments by Unicode code points; malformed constraints and forbidden oneOf siblings are rejected.
- **Local implementation:** JSON Schema validation and tool schema projection, guarded by [schema validator tests](../packages/core/tools/tests/json-schema.spec.ts) and [schema conversion tests](../packages/core/tools/tests/schema.spec.ts).
- **Upstream status:** The integrated validator and projection guards pass; upstream equivalence after removing the local implementation remains unverified.
- **Retire when:** The integrated validator and projection tests pass without the fork-only implementation.

### F-008: Reveal Windows files with one Explorer argument

- **Behavior:** Revealing a file passes Explorer /select, and the target together as one argument; separate arguments silently fail to select it.
- **Local implementation:** Native path opener, guarded by [Windows and WSL reveal tests](../packages/util/native-command/tests/path-opener.spec.ts).
- **Upstream status:** The integrated Windows path-opener guard passes; a real Explorer reveal smoke and removal comparison remain open.
- **Retire when:** The tests and a Windows reveal smoke pass without local code.

### F-009: Keep settings dialogs above shell columns

- **Behavior:** Sidebar settings remain clickable instead of being trapped under the conversation by a shell-column stacking context.
- **Local implementation:** Layout and sidebar styles, guarded by [column stacking tests](../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts).
- **Upstream status:** The integrated layout guard, GUI suite, and Sidebar browser paths pass; removing the local stacking behavior still needs a browser check.
- **Retire when:** The dialog stays clickable after removing local styles, with the static guard and a real-browser interaction passing.

### F-010: Suppress the collapsed right-sidebar scrim

- **Behavior:** Collapsing the right sidebar must not leave its translucent overlay painting across the conversation.
- **Local implementation:** [Right-sidebar stylesheet](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css); a [Chromium regression](../apps/web/tests/sidebar-right.e2e.ts) checks that its scrim does not paint while collapsed, reappears when opened and disappears after closing.
- **Upstream status:** The focused Chromium check passes on the integrated branch with the fork CSS retained. Removing it has not been tested; the full Web replay still has failures.
- **Retire when:** The collapse and expansion browser test passes after removing the fork-only CSS, and the relevant Web replay passes.

### F-011: Preserve the latest model-selection outcome

- **Behavior:** The chooser retains an accepted model while durable state catches up, ignores an older failed request, and revokes late results after connection reset or disposal.
- **Local implementation:** ModelDirectory and chooser presentation, guarded by [directory race tests](../packages/client/ui-model-selection/tests/directory.client.spec.ts), [chooser tests](../packages/client/ui-model-selection/tests/model-select.client.spec.tsx), and [Host integration tests](../packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts).
- **Upstream status:** The merged directory retains the fork’s selection race behavior while adopting the rc.2 catalog and pending controls. Focused tests pass; removing fork behavior and checking the built browser path remain separate requirements.
- **Retire when:** The stated selection and lifecycle tests, plus a relevant browser path, pass without local behavior.

### F-012: Keep Windows repository checks executable

- **Behavior:** Tracked Loader configs and temporary NodeNext consumer links resolve on Windows without requiring directory symlink privilege; failed setup reports the failing phase.
- **Local implementation:** Tracked-config reader and NodeNext directory-link helper, guarded by [tracked-config tests](../scripts/read-tracked-loader-config.spec.ts) and [directory-link tests](../scripts/node-next-directory-link.spec.ts).
- **Upstream status:** The integrated tracked-config and directory-link guards pass; the complete Windows hygiene lane passes 18/18 gates with the local helpers retained. Removal equivalence remains unverified.
- **Retire when:** Equivalent upstream checks pass on Windows without local helpers and still reject malformed Loader configurations.

### F-013: Skip absent virtual manifests in notices generation

- **Behavior:** Scanning virtual-store candidates for bundled third-party notices skips directories without the requested package manifest instead of failing the entire inventory.
- **Local implementation:** Notices generator, guarded by [virtual-manifest tests](../scripts/gen-third-party-notices.spec.ts).
- **Upstream status:** The merged generator test and generated-notices check pass with the local fix retained; no removal test has established upstream equivalence.
- **Retire when:** The generator and its missing-manifest test pass without the local implementation.

### F-014: Keep vendor rescoping out of UI locale identifiers

- **Behavior:** Vendor-package rewrites preserve a UI dictionary id that happens to match a package name, while still rewriting genuine package references.
- **Local implementation:** Vendor rescope script, guarded by [rescope classification tests](../scripts/rescope-vendor.spec.ts).
- **Upstream status:** An upstream file-level skip masked the fork’s narrower import rewrite; the integrated classification test caught it. Removing that skip restores the behavior, and the rescope check passes.
- **Retire when:** The same test and vendor sync check pass without the local exception.

### F-015: Anchor fullscreen right panels to the viewport

- **Behavior:** A fullscreen right panel covers the viewport even when the normal three-column window is inset by Aurora glass; normal panels still dock to that inset window.
- **Local implementation:** [Right-sidebar stylesheet](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css), guarded by the [fullscreen browser scenarios](../apps/web/tests/sidebar-right.e2e.ts).
- **Upstream status:** The merged absolute-position panel stopped at the inset window. The fixed, border-box panel passes all 16 Sidebar browser checks, including narrow mode; the Desktop runtime build passes, but native Electron interaction, packaging, and the full Web replay remain open.
- **Retire when:** Removing the fork position rule preserves both normal docking and fullscreen viewport coverage in Chromium and Desktop.

### F-016: Drag the exposed macOS Aurora top strip

- **Behavior:** The ambient strip above the inset glass window belongs to the macOS window drag region without making controls inside the window draggable.
- **Local implementation:** [Frame stylesheet](../packages/client/ui-layout/src/client/AppFrame.module.css), guarded by the [macOS browser drag scenarios](../apps/web/tests/window-drag-coverage.e2e.ts).
- **Upstream status:** The Aurora inset leaves a top strip outside rc.2’s chrome-owned header drag regions. All five macOS browser drag checks pass with the new strip; the Desktop runtime build also passes, but native Electron window interaction remains open.
- **Retire when:** Removing this strip’s drag region leaves no dead area at the top and does not turn interactive controls into window drag targets.

### External plugin compatibility

The five external bundles `dsh-codex-connect`, `dsh-better-sidebar`, `dsh-find-plugin`, `dsh-context`, and `dsh-daily-planner` declare peer ranges that reject `0.1.7-rc.2`; no version exemption was granted. Disposable copies using published rc.2 packages pass install/typecheck/build for Better Sidebar, dsh-context, find-plugin, and Daily Planner. Codex Connect installs and builds, but its unmodified test fixture fails typecheck because the new `ModelDirectoryState.pending` field is absent; a disposable test-only `pending: null` update restores its typecheck and passes seven focused fast-mode tests. Better Sidebar tests fail to import the published UI primitives bundle without code-language; Daily Planner client suites fail to import the published client-store bundle without Zustand. All 62 Daily Planner tests pass when code-language, Zustand, and Immer are added only to the disposable consumer. The repository’s `verify-package-dependencies` gate requires these Client browser build inputs to remain dev-only; moving them to runtime dependencies was rejected and rolled back. Their published-package consumer path still needs a policy-compliant build or loader fix and a new standalone install check. `dsh-pointer-trails` has no DSH peer, builds in a disposable copy, and has an unrelated missing `@stylistic/eslint-plugin` lint dependency. Keep original plugin checkouts and live profiles unchanged pending reviewed compatibility updates.

## Other local changes and unresolved checks

The [Aurora glass design decision](../.agents/notes/implemented/feature/2026-09-17-aurora-glass-visual-language.md) owns local visual choices; do not mistake them for upstream defect fixes. The [local Web launcher](../scripts/build-and-run-web.cmd) contains a machine-specific absolute path and skips a rebuild; move this convenience outside shared source or make it portable before relying on it for Desktop development. Test-only additions and generated snapshots remain with their owning behavior, not separate active fixes.

A historical Workspace navigation fix has no source difference between this fork and its already integrated upstream base; its [navigation tests](../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) remain useful, but it is not an active fork-only implementation. An older saved-default recovery decision still claims that a retired preset id is mapped to PTC, but its former agent-presets package and regression test are absent from the current tree. The new [preset registry policy](../packages/preset/agent-preset-registry/src/index.ts) reads a selected default without that explicit mapping. Determine whether the old settings value can reach the new registry before asserting a regression or retiring the [original decision record](../.agents/notes/implemented/bug-fix/2026-09-17-retired-preset-default-recovery.md); add a current-path test if it can.

The [Windows queue-actions replay](../apps/web/tests/queue-actions.e2e.ts) remains red: while a queued submission is sending, the running Turn-process control is disabled and collapsed, but the committed golden expects it disabled and expanded with the partial reasoning visible. The subsequent replay-consumption and response-wait errors follow the failed assertion. The [owner-local live-Turn test](../packages/client/ui-chat/tests/chat-view.client.spec.tsx) passes and requires a disabled, expanded control, so the browser discrepancy is not an approved display-policy change. The assembled state update still needs diagnosis; neither product behavior nor the golden has been weakened.

## Finish the baseline

Before the next upstream integration, inspect all local-only changes against a newly fetched upstream revision. Add entries for every source-level defect fix not already represented here, and classify personal UI design, portability changes, test-only changes, and source launch changes separately. A named regression guard is not sufficient until it has been run on the integrated branch; missing guards are work items, not assumed passes. Record the upstream issue or PR when verified, and remove retired entries only after their removal test passes. Keep the list about currently owned behavior rather than accumulating a release history.
