---
kind: explanation
description: "Track local Host source deviations and their retirement conditions."
---
# Fork deviations

English | [中文](fork-deviations.zh.md)

## Local one-shot activation

The fixed alpha2 Host includes a local extension to [Subagent](subsystems/subagent.md) for Review-Gated roles. Explicit `lifecycle: 'one-shot'` dispatches detached provider preparation while the existing manager owns real local child creation, permissions, working directory, preset composition, execution and cleanup. The child uses the existing one-shot descriptor and catalog formats and cannot accept follow-up input or cold resume. The extension does not change default dispatch, continuable activation or external provider execution.

The behavioral owner is [local-one-shot.spec.ts](../packages/subagent/subagent/tests/local-one-shot.spec.ts), with adjacent external activation, policy, preset and directory regressions. Retire this deviation when upstream provides equivalent public local-one-shot activation and the Review-Gated role and package suites pass against it without the extension. The Host package version remains alpha2; it does not identify an upstream release containing this extension.
