# Synchronizing the personal fork

English | [中文](syncing-the-fork.zh.md)

This guide keeps local behavior intact while integrating upstream changes. The [active deviation registry](../fork-deviations.md) records source changes that still need local ownership; existing repository tests, snapshots, and package documentation remain their behavior owners.

## Before changing the fork

1. Confirm the current branch, working-tree changes, and both remote URLs. Protect unfinished work without moving or overwriting it; the daily branch is not a staging area for upstream integration.
2. Classify each local change: profile patch or out-of-tree plugin for personal choices; a focused source fix for defects that cannot use an extension point; a separate UI customization for local product identity. Preserve upstream authorship and licensing. Do not assume an upstream release includes local behavior.
3. For each lasting source fix, add or update its registry entry in the same change. Record its observable failure, behavioral regression test, upstream issue or PR when known, and retirement condition. The test should fail without the fix where that comparison is safe and practical; passing only with both implementations installed does not establish that upstream has fixed the bug.
4. Identify output surfaces before development: Web and Desktop share product code, but Desktop packages its own exact matching runtime and needs separate qualification. Consult [Desktop ownership and release requirements](../../apps/desktop/README.md) rather than treating a Web smoke as a Desktop release test.

## Integrate an upstream revision

1. Fetch the official upstream into its tracking ref and record the before and after revisions. Create a dedicated integration branch and worktree from the tested daily branch. Never merge over uncommitted daily-branch work or push to the upstream remote.
2. Merge the selected upstream revision into the integration branch, preserving a checkpoint before replacing an in-progress integration with a newer upstream base. Resolve source, generated-file, and bilingual-pair conflicts against actual behavior, not only Git's textual result. Consult the [pairing merge recovery path](../development.md) when a confirmation record conflicts.
3. Review every active deviation in the [registry](../fork-deviations.md), including entries whose files did not conflict. Compare affected execution paths and configuration after the merge; a clean merge is not evidence that a fix still runs. Recheck profile rows whose complete configuration is overridden by a patch.
4. Run each relevant regression on the integrated tree, then the smallest additional checks for newly changed upstream surfaces under [repository testing policy](../testing.md). For model- or user-visible behavior include the owned snapshots and real compositions where required. Record the checks actually run; an unrun check is not a pass.
5. If upstream appears to fix a registered bug, remove the local implementation on the integration branch and rerun its behavioral test. Retire the registry entry only after the test and relevant integration checks pass without the patch; retain the test or identify upstream's equivalent guard. If evidence is missing or behavior regresses, do not promote the integration.
6. Promote the verified integration to the daily branch only after every active entry has an outcome. Keep the merge checkpoint so the next sync can compare revisions; avoid rebasing published daily-branch history merely to hide upstream merges.

## Desktop qualification

Web and Desktop use shared application behavior, but Desktop owns a separate profile, matching packaged runtime, platform dependencies, signing, and update checks. A Web-only fix requires a Desktop impact assessment; changes to runtime, Electron, packaging, native modules, installation, or updates require the focused Desktop checks described in [Desktop development and packaging](../../apps/desktop/README.md). Do not advertise a fork build as an official signed Desktop release or assume local packaging covers all platforms.

## Verify readiness

An integration is ready when the registry inventory is complete for the local source delta, each active behavioral guard passes on the merged tree, retired guards pass without the local fix, relevant product checks pass, and the proposed branch does not contain unrelated unfinished work. The current registry is explicitly incomplete; finish its baseline inventory before claiming a verified upstream sync.
