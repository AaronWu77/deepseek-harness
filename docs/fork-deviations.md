# Active fork deviations

English | [中文](fork-deviations.zh.md)

This is the working inventory of source behavior this fork may need to retain across upstream integrations. It is not a list of all commits: local product styling and profile preferences have different owners. The source inventory is still being audited. Upstream was fetched for a source comparison, but no merged-tree or removal tests have been run; do not use this page alone to approve a sync. The [synchronization procedure](cookbook/syncing-the-fork.md) defines admission and retirement.

## Recorded source fixes

### F-001: Preserve execution under an effective sandbox mode

- **Behavior:** A permission request that does not widen the effective sandbox mode must not discard the permitted operation; unsupported modes still fail closed.
- **Local implementation:** Sandbox escalation handling; find the original change by the Git subject "fix(sandbox): run under the effective mode when a request cannot widen it".
- **Regression guard:** [sandbox escalation behavior](../packages/sandbox/sandbox/tests/escalation.spec.ts) and [PowerShell execution behavior](../packages/shell/tool-pwsh/tests/tools.spec.ts). Verify the relevant assertions fail when the local correction is removed on a suitable integration branch.
- **Upstream status:** Source compared with the fetched upstream branch; merged-tree behavior and patch removal remain unverified.
- **Retire when:** The same behavioral guards and relevant composed tool checks pass with the local implementation removed.

### F-002: Ignore a non-widening run_code request

- **Behavior:** Under an already broader effective mode, a run_code request for a narrower permission must execute without asking for impossible escalation; malformed or unsupported permission requests still fail.
- **Local implementation:** PTC tool dispatch; find the original change by the Git subject "fix(tools): drop a non-widening sandbox request instead of failing run_code".
- **Regression guard:** [PTC tool dispatch tests](../packages/core/tools/tests/ptc.spec.ts). Verify both allowed execution and invalid-request rejection without the local correction.
- **Upstream status:** Source compared with the fetched upstream branch; merged-tree behavior and patch removal remain unverified.
- **Retire when:** The guards pass on the integrated branch without the local implementation, including a product-path check if the observable tool result changes.

### F-003: Keep a stable tool scheduler identity

- **Behavior:** Tool dispatch through different entry points must use the same scheduler identity when they share scheduling policy.
- **Local implementation:** Tool runtime and Client API catalog; find the original change by the Git subject "fix(tools): stabilize scheduler identity across entry points".
- **Regression guard:** [tool registry test](../packages/core/tools/tests/tools.spec.ts); the existing [scheduler decision record](../.agents/notes/implemented/bug-fix/2026-09-19-stable-tool-scheduler-identity.md) carries the rationale. Confirm the guard fails without the local correction and covers the relevant composed route.
- **Upstream status:** Source compared with the fetched upstream branch; merged-tree behavior and patch removal remain unverified.
- **Retire when:** A shared identity and composed behavior survive removal of the fork-only code; retain or identify equivalent upstream coverage.

### F-004: Acknowledge Session model selection before profile persistence

- **Behavior:** An accepted model or reasoning-effort selection returns after the Session changes even if writing the deployment default is slow; default writes remain ordered and failures do not roll back the Session.
- **Local implementation:** Session Controller model-selection command serializes best-effort profile writes outside the Remote response.
- **Regression guard:** [Session selection and slow default writes](../packages/api/session-controller/tests/session-models.host.spec.ts) checks that selection responses settle before a blocked profile write and that later writes keep their order.
- **Upstream status:** Upstream PR #5173 also saves the default in the background, but the local implementation additionally orders overlapping saves. It is a candidate for retirement, not a verified duplicate.
- **Retire when:** The same regression passes without fork-only code after integration, including overlapping saves and error handling.

### F-005: Explain PTC syntax failures without retrying a sandbox

- **Behavior:** A run_code parser error caused by pasting file contents as program source suggests quoting or JSON-serializing that content, without disguising the failure as a sandbox denial.
- **Local implementation:** PTC syntax-error diagnostic and model-facing prompt, guarded by [PTC parser-error tests](../packages/core/tools/tests/ptc.spec.ts) and [session prompt snapshots](../snapshots/session/ptc-turn/system-prompt.expected.md).
- **Upstream status:** The current upstream source does not contain the local diagnostic; integrated model-visible output has not been tested.
- **Retire when:** The correction and its visible guidance pass with local code removed, including a recorded-session check.

### F-006: Reserve escalation for explicit sandbox denials

- **Behavior:** run_code guidance asks for a strictly wider mode and a non-empty justification only after an explicit denial; ordinary and read-only calls omit both fields.
- **Local implementation:** PTC schema and sandbox refusal text, guarded by [tool-schema tests](../packages/core/tools/tests/ptc.spec.ts) and [sandbox escalation tests](../packages/sandbox/sandbox/tests/escalation.spec.ts).
- **Upstream status:** Upstream has changed tool descriptions; the post-merge instruction and denial paths need comparison, not an automatic overwrite.
- **Retire when:** Without the local guidance, the visible schema and denial behavior still enforce the same escalation rule.

### F-007: Validate string minLength in tool schemas

- **Behavior:** String length constraints reject too-short tool arguments by Unicode code points; malformed constraints and forbidden oneOf siblings are rejected.
- **Local implementation:** JSON Schema validation and tool schema projection, guarded by [schema validator tests](../packages/core/tools/tests/json-schema.spec.ts) and [schema conversion tests](../packages/core/tools/tests/schema.spec.ts).
- **Upstream status:** No equivalent source change was found in the examined upstream path; merged behavior remains untested.
- **Retire when:** The integrated validator and projection tests pass without the fork-only implementation.

### F-008: Reveal Windows files with one Explorer argument

- **Behavior:** Revealing a file passes Explorer /select, and the target together as one argument; separate arguments silently fail to select it.
- **Local implementation:** Native path opener, guarded by [Windows and WSL reveal tests](../packages/util/native-command/tests/path-opener.spec.ts).
- **Upstream status:** The examined upstream path still differs; platform behavior after integration is unverified.
- **Retire when:** The tests and a Windows reveal smoke pass without local code.

### F-009: Keep settings dialogs above shell columns

- **Behavior:** Sidebar settings remain clickable instead of being trapped under the conversation by a shell-column stacking context.
- **Local implementation:** Layout and sidebar styles, guarded by [column stacking tests](../packages/client/ui-layout/tests/app-frame-styles.client.spec.ts).
- **Upstream status:** Upstream has revised the shared layout; the merged paint and pointer path needs a browser check.
- **Retire when:** The dialog stays clickable after removing local styles, with the static guard and a real-browser interaction passing.

### F-010: Suppress the collapsed right-sidebar scrim

- **Behavior:** Collapsing the right sidebar must not leave its translucent overlay painting across the conversation.
- **Local implementation:** [Right-sidebar stylesheet](../packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css); the originating CSS-only fix added no focused behavioral regression.
- **Upstream status:** The sidebar stylesheet changed upstream. A browser regression and merged-tree comparison are missing; this entry is not release-ready.
- **Retire when:** A browser test proves the collapse and expansion behavior without fork-only CSS. Add that guard before approving the next integration.

### F-011: Preserve the latest model-selection outcome

- **Behavior:** The chooser retains an accepted model while durable state catches up, ignores an older failed request, and revokes late results after connection reset or disposal.
- **Local implementation:** ModelDirectory and chooser presentation, guarded by [directory race tests](../packages/client/ui-model-selection/tests/directory.client.spec.ts), [chooser tests](../packages/client/ui-model-selection/tests/model-select.client.spec.tsx), and [Host integration tests](../packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts).
- **Upstream status:** Upstream has changed the same model directory; resolve divergent behavior on the merged tree rather than preserving a matching file name.
- **Retire when:** The stated selection and lifecycle tests, plus a relevant browser path, pass without local behavior.

### F-012: Keep Windows repository checks executable

- **Behavior:** Tracked Loader configs and temporary NodeNext consumer links resolve on Windows without requiring directory symlink privilege; failed setup reports the failing phase.
- **Local implementation:** Tracked-config reader and NodeNext directory-link helper, guarded by [tracked-config tests](../scripts/read-tracked-loader-config.spec.ts) and [directory-link tests](../scripts/node-next-directory-link.spec.ts).
- **Upstream status:** The examined upstream scripts do not include these helpers; Windows hygiene must be rerun on an integrated checkout.
- **Retire when:** Equivalent upstream checks pass on Windows without local helpers and still reject malformed Loader configurations.

### F-013: Skip absent virtual manifests in notices generation

- **Behavior:** Scanning virtual-store candidates for bundled third-party notices skips directories without the requested package manifest instead of failing the entire inventory.
- **Local implementation:** Notices generator, guarded by [virtual-manifest tests](../scripts/gen-third-party-notices.spec.ts).
- **Upstream status:** Source overlap and a generated-notices check remain to be verified after integration.
- **Retire when:** The generator and its missing-manifest test pass without the local implementation.

### F-014: Keep vendor rescoping out of UI locale identifiers

- **Behavior:** Vendor-package rewrites preserve a UI dictionary id that happens to match a package name, while still rewriting genuine package references.
- **Local implementation:** Vendor rescope script, guarded by [rescope classification tests](../scripts/rescope-vendor.spec.ts).
- **Upstream status:** Upstream has not been integrated with the local release workflow; rerun the rescope check before retirement.
- **Retire when:** The same test and vendor sync check pass without the local exception.

## Other local changes and unresolved checks

The [Aurora glass design decision](../.agents/notes/implemented/feature/2026-09-17-aurora-glass-visual-language.md) owns local visual choices; do not mistake them for upstream defect fixes. The [local Web launcher](../scripts/build-and-run-web.cmd) contains a machine-specific absolute path and skips a rebuild; move this convenience outside shared source or make it portable before relying on it for Desktop development. Test-only additions and generated snapshots remain with their owning behavior, not separate active fixes.

A historical Workspace navigation fix has no source difference between this fork and its already integrated upstream base; its [navigation tests](../packages/client/ui-workspace/tests/workspaces-service.client.spec.ts) remain useful, but it is not an active fork-only implementation. An older saved-default recovery decision still claims that a retired preset id is mapped to PTC, but its former agent-presets package and regression test are absent from the current tree. The new [preset registry policy](../packages/preset/agent-preset-registry/src/index.ts) reads a selected default without that explicit mapping. Determine whether the old settings value can reach the new registry before asserting a regression or retiring the [original decision record](../.agents/notes/implemented/bug-fix/2026-09-17-retired-preset-default-recovery.md); add a current-path test if it can.

## Finish the baseline

Before the next upstream integration, inspect all local-only changes against a newly fetched upstream revision. Add entries for every source-level defect fix not already represented here, and classify personal UI design, portability changes, test-only changes, and source launch changes separately. A named regression guard is not sufficient until it has been run on the integrated branch; missing guards are work items, not assumed passes. Record the upstream issue or PR when verified, and remove retired entries only after their removal test passes. Keep the list about currently owned behavior rather than accumulating a release history.
