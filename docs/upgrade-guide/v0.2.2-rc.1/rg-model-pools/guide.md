---
kind: upgrade-guide
description: "RG requires explicit role model pools and budgeted one-shot role calls."
---

# RG model pools and managed role attempts

English | [中文](guide.zh.md)

## Change

The optional Review-Gated bundle requires explicit main and worker model pools. Reviewer models inherit a frozen copy of the main configuration unless configured separately. New RG Sessions retain their model policy and attempt budgets across configuration edits and restarts; selecting an RG main model does not update the global default.

The preset-local `maxReviewRounds` setting and ordinary delegation arguments are replaced by the bundle’s `rg-settings` document and structured handoffs. Worker and reviewer calls are one-shot. Accepted failed, cancelled, and inconclusive attempts consume budget; completed children cannot accept follow-up work. Review is guidance, not a correctness or delivery gate.

## Migration

1. Remove custom overrides of the old `rg-coordination`, `rg-worker`, and `rg-reviewer` tool rows; use the bundle’s three role contributions. Update automation calling `rg_worker` or `rg_reviewer` to supply the structured handoff rather than `description` and `prompt`.
2. Open **Settings → RG models**, select main and worker candidates and defaults, choose reviewer inheritance or a separate pool, and save the complete configuration. Configure reasoning per candidate; omission uses the provider default.
3. Open a new RG Session. Older RG Sessions without a policy snapshot remain readable but do not acquire new model pools or budgets. Sessions containing the new result-confirmation events require a reader that recognizes them; older readers reject these required events.
4. Check the RG status strip and request records for actual role models, attempt counts, and formal reviewer outcomes. If a previously saved workspace review is marked stale, request a fresh review within the remaining budget. Start a new task explicitly for independent work; editing settings or clarifying the current task does not reset its budget.

See the [RG reference](../../../../packages/experimental/review-gated/README.md) for PTC behavior, scope checks, and limitations.
