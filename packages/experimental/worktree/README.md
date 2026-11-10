---
description: "Create retained branch or detached Git worktrees under the calling Session file policy, with optional entry."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

English | [中文](README.zh.md)

## Summary

Create an isolated checkout from a local commit without changing the source checkout. Choose a new task branch or a detached checkout pinned for review, and leave the calling Session in place or explicitly enter a new branch. The existing sandbox governs all writes. Checkouts and any created branches are retained.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service alongside `workingDirectory`, `fs`, `subprocess`, `sandbox`, and `sandboxPolicy` providers. Add the tool package when models need the operation.

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from? }, signal?, onPhase?)` creates a new branch and checkout, then enters the canonical checkout directory through `ctx.workingDirectory.set`. `from` resolves to a local commit before creation and defaults to `HEAD`; staged, unstaged, untracked, and ignored source files are not copied. `baseCommit` reports the resolved commit object name; repository-local replacement refs still apply to the checked-out content. Checkout disables configured Git clean, smudge, and process filters without changing repository configuration. An existing branch or checkout path is an error. The returned record contains `path`, `branch`, `baseCommit`, and `repositoryRoot`. An optional fourth argument, `onPhase`, receives `prepare` before validation, directory allocation, and branch creation, and `checkout` before the files are written and the checkout is entered; it must not throw.

`ctx.worktrees.provision(agent, { name?, from?, detached? }, signal?, onPhase?)` creates a checkout without changing the calling Session directory, including when its current directory is missing or setup fails. It uses the same local revision resolution, configuration, process limits, filters, and existing permissions as `create`. Omitted or false `detached` creates a new branch; true creates a detached HEAD and returns `branch: null`, without creating or selecting an existing branch. Names follow the same branch-compatible grammar and claim an unused checkout path; only branch mode requires an unused branch. The result is a `ProvisionedWorktree` with canonical `path`, `branch`, `baseCommit`, and `repositoryRoot`; `CreatedWorktree` keeps its string branch for existing `create` consumers. `onPhase` reports `prepare` and `checkout` without entering the checkout.

`ctx.worktrees.restore(agent, { path, branch, baseCommit, repositoryRoot }, signal?, onPhase?)` checks a removed worktree out again at its recorded directory. It validates the recorded repository root, full commit object name, branch, and canonical target inside the configured pool before mutation. It removes only the missing target's unlocked registration with `git worktree remove`; other worktrees and locked registrations remain unchanged. It then checks out the branch when it still exists, or creates the branch again at `baseCommit` when it does not, and reports which happened as `branchRecreated`. An existing directory is an error. The calling Session's working directory does not change, and changes that were never committed are not recovered. Checkout disables filters as creation does. `onPhase` receives `prepare` before validation, target-registration cleanup, and branch creation, and `checkout` before the files are written; it must not throw.

The default checkout directory is `<current checkout root>/.agents/worktrees/<name>`. Canonical pool and destination paths must remain inside the source checkout and pool, respectively; symlinks or junctions escaping either are rejected before directory allocation, while links that stay inside are permitted. The returned `repositoryRoot` is the top-level directory of the caller’s current checkout; when it is a linked checkout, the pool is nested inside it. Omitted names join the `dsh-` prefix, the first eight hexadecimal digits of the UUID in the Session id, a hyphen, and four random hexadecimal digits, such as `dsh-6b1f02c4-9a3e`; a Session id without a UUID gets eight random hexadecimal digits after the prefix. `generatedWorktreeName` exports the same rule for callers that name a worktree before creating it. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the pool; existing files and ignore rules are preserved. Relative `directory`, generated `namePrefix`, executable choices, and process limits are configurable in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-worktree).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Git and directory allocation run through the mounted subprocess and sandbox providers with the calling Session's existing file policy. Creation does not widen write access to the destination or shared Git administration directory. Directory creation claims the destination exclusively; cancellation and failed setup can leave retained artifacts, whose path appears in the error. Service disposal aborts pending operations and waits for their settlement. Each spawned command requests termination and awaits an unbounded managed-range observation, including when termination throws. A termination error, failed observation, or false observation result rejects with the exported `WorktreeProcessUnknownError` (`code: WORKTREE_PROCESS_UNKNOWN`, `cwd`, and the provider failure in `cause`), even after command success, failure, or cancellation. Checkout errors preserve this error through their `cause` chain. Callers must stop dependent work, retain artifacts, and inspect them before continuing; this error does not confirm cancellation or rollback.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Resolve the source revision, create the checkout, and publish the new working directory |
| [`src/process.ts`](src/process.ts) | Confine literal argv, cap output, and await process termination |
| [`src/directory.ts`](src/directory.ts) | Claim the destination and initialize a newly created pool's ignore file |

No runtime invariant companion is published: Git owns checkout registration and the working-directory service owns the Session directory; this package retains no independent projection of either.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Worktree subsystem](../../../docs/subsystems/worktrees.md) — request, result, and service reference.
- [Working directory](../../session/working-directory/README.md) — recorded Session directory and directory changes.
- [Worktree tool](../tool-worktree/README.md) — model-facing creation.
- [Subprocess](../../subprocess/subprocess/README.md) — process ownership and execution worlds.
- [Creation decision](../../../.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md) — retained checkouts and existing write grants.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the worktree tool's creation result and the working-directory service's recorded Session context.

#### KV Cache effect

This package contributes no prompt text. Its consumers own the appended tool result and recorded directory context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Retained artifacts** — leaving a worktree keeps its branch and files. Setup failures can also retain partial artifacts; checkout removal and branch deletion belong to the user or another consumer.
- **Local revisions only** — creation does not fetch commits or missing partial-clone objects, initialize submodules, install dependencies, or copy uncommitted files. On Git that meets the execution requirements, missing local objects cause creation to fail.
- **Filtered representations** — checkout skips configured filters to avoid executing repository-configured programs or triggering implicit downloads. Git LFS pointers and encrypted blobs stay in their stored representation; hydration or decryption is a separate user-controlled operation.
- **Execution requirements** — the subprocess provider must offer Git and Node in the same execution world as the filesystem provider. Git must honor `GIT_NO_LAZY_FETCH`, which Git 2.45 and the 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, and 2.44.1 maintenance releases do; older releases ignore it and proceed instead of failing, so creation can fetch missing partial-clone objects from a promisor remote. The `git --no-lazy-fetch` option would reject these releases, but it exists only in Git 2.45 and later and also rejects the patched maintenance releases. The existing sandbox must permit all checkout and shared Git metadata writes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The sandboxed Node child supplies exclusive directory creation, which the [filesystem service](../../fs/fs/src/index.ts) does not expose, and identifies whether this service created the pool. The filesystem contract permits bare providers such as [fs-local](../../fs/fs-local/src/index.ts) to ignore `sandboxPolicy` on writes; `createIfAbsent` protects a file but neither enforces permissions nor identifies who created its directory. Keeping directory allocation and ignore-file creation under the same process sandbox as Git preserves refusal of existing checkout paths and the condition for creating `.gitignore`.

</details>
