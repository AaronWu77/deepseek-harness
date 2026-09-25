# Active fork deviations

English | [中文](fork-deviations.zh.md)

This is the working inventory of source behavior this fork may need to retain across upstream integrations. It is not a list of all commits: local product styling and profile preferences have different owners. The initial inventory is incomplete, and no entry below has yet been checked against a freshly fetched upstream revision; do not use this page alone to approve a sync. The [synchronization procedure](cookbook/syncing-the-fork.md) defines admission and retirement.

## Recorded source fixes

### F-001: Preserve execution under an effective sandbox mode

- **Behavior:** A permission request that does not widen the effective sandbox mode must not discard the permitted operation; unsupported modes still fail closed.
- **Local implementation:** Sandbox escalation handling; find the original change by the Git subject "fix(sandbox): run under the effective mode when a request cannot widen it".
- **Regression guard:** [sandbox escalation behavior](../packages/sandbox/sandbox/tests/escalation.spec.ts) and [PowerShell execution behavior](../packages/shell/tool-pwsh/tests/tools.spec.ts). Verify the relevant assertions fail when the local correction is removed on a suitable integration branch.
- **Upstream status:** Not yet checked against the latest fetched upstream revision.
- **Retire when:** The same behavioral guards and relevant composed tool checks pass with the local implementation removed.

### F-002: Ignore a non-widening run_code request

- **Behavior:** Under an already broader effective mode, a run_code request for a narrower permission must execute without asking for impossible escalation; malformed or unsupported permission requests still fail.
- **Local implementation:** PTC tool dispatch; find the original change by the Git subject "fix(tools): drop a non-widening sandbox request instead of failing run_code".
- **Regression guard:** [PTC tool dispatch tests](../packages/core/tools/tests/ptc.spec.ts). Verify both allowed execution and invalid-request rejection without the local correction.
- **Upstream status:** Not yet checked against the latest fetched upstream revision.
- **Retire when:** The guards pass on the integrated branch without the local implementation, including a product-path check if the observable tool result changes.

### F-003: Keep a stable tool scheduler identity

- **Behavior:** Tool dispatch through different entry points must use the same scheduler identity when they share scheduling policy.
- **Local implementation:** Tool runtime and Client API catalog; find the original change by the Git subject "fix(tools): stabilize scheduler identity across entry points".
- **Regression guard:** [tool registry test](../packages/core/tools/tests/tools.spec.ts); the existing [scheduler decision record](../.agents/notes/implemented/bug-fix/2026-09-19-stable-tool-scheduler-identity.md) carries the rationale. Confirm the guard fails without the local correction and covers the relevant composed route.
- **Upstream status:** Not yet checked against the latest fetched upstream revision.
- **Retire when:** A shared identity and composed behavior survive removal of the fork-only code; retain or identify equivalent upstream coverage.

### F-004: Acknowledge Session model selection before profile persistence

- **Behavior:** An accepted model or reasoning-effort selection returns after the Session changes even if writing the deployment default is slow; default writes remain ordered and failures do not roll back the Session.
- **Local implementation:** Session Controller model-selection command serializes best-effort profile writes outside the Remote response.
- **Regression guard:** [Session selection and slow default writes](../packages/api/session-controller/tests/session-models.host.spec.ts) checks that selection responses settle before a blocked profile write and that later writes keep their order.
- **Upstream status:** Not yet checked against the latest fetched upstream revision.
- **Retire when:** The same regression passes without fork-only code after the integrated implementation acknowledges Session selection independently of profile persistence.

## Finish the baseline

Before the next upstream integration, inspect all local-only changes against a newly fetched upstream revision. Add entries for every source-level defect fix not already represented here, and classify personal UI design, portability changes, test-only changes, and source launch changes separately. A named regression guard is not sufficient until it has been run on the integrated branch; missing guards are work items, not assumed passes. Record the upstream issue or PR when verified, and remove retired entries only after their removal test passes. Keep the list about currently owned behavior rather than accumulating a release history.
