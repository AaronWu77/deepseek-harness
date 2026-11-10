/** Public requests and results for provisioning, entering, and restoring retained Git worktrees. */

/** A new checkout from a locally available Git commit, branch, or tag. */
export interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
}

/** Checkout allocation that leaves the calling Session's working directory unchanged. */
export interface ProvisionWorktreeRequest extends CreateWorktreeRequest {
  /** Use a detached HEAD without creating a branch; omission or false creates a new branch. */
  detached?: boolean
}

/** Retained checkout and pinned local baseline, without a Session directory change. */
export interface ProvisionedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name, or null for a detached checkout. */
  branch: string | null
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/** Committed Git baseline and the calling Session's resulting working directory. */
export interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/**
 * Stage reported before it begins: `prepare` validates and allocates the checkout,
 * creating a branch unless detached or restoring an existing branch; `checkout`
 * writes files and, only for `create`, enters the checkout.
 */
export type CreateWorktreePhase = 'prepare' | 'checkout'

/** A removed checkout to check out again at its recorded directory. */
export interface RestoreWorktreeRequest {
  /** Canonical checkout directory the worktree had. */
  path: string
  /** Branch the worktree had checked out. */
  branch: string
  /** Commit the branch started from; a branch that no longer exists is created again here. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/** Outcome of one restoration. */
export interface RestoredWorktree {
  /** Checkout directory, present again. */
  path: string
  /** Whether the branch no longer existed and was created again at the base commit, without the commits it had gained. */
  branchRecreated: boolean
}
