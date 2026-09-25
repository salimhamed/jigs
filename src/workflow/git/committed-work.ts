import { JigsError } from "../errors.ts";
import type { Worktree } from "../workspaces/worktree.ts";

/** What the factory's `readBranchState` step reports about a worktree's branch. */
export interface BranchState {
  /** The number of commits reachable from HEAD but not the base commit. */
  commits: number;
  /** The current HEAD commit SHA. */
  headSha: string;
  /** Whether the worktree has uncommitted changes or its status could not be read. */
  dirty: boolean;
}

/** The factory's `readBranchState` step: the branch state, counting commits since `baseSha`. */
export type ReadBranchState = (worktree: Worktree, baseSha?: string) => Promise<BranchState>;

/** Where `committedWork` counts commits from. */
export interface CommittedWorkOptions {
  /** A commit SHA to count new commits from. Defaults to the worktree's base commit. */
  since?: string | undefined;
}

/**
 * Durable steps the Git routines run.
 *
 * @group Factory plumbing
 */
export interface GitSteps {
  readBranchState: ReadBranchState;
}

/**
 * Read a worktree's branch state, failing unless its changes are all committed and at least one
 * commit is new since the base, or since `options.since`.
 */
export async function committedWork(
  worktree: Worktree,
  steps: GitSteps,
  options: CommittedWorkOptions = {},
): Promise<BranchState> {
  const state = await steps.readBranchState(worktree, options.since ?? worktree.baseSha);
  if (state.dirty) {
    throw new JigsError(
      `the agent left uncommitted changes in ${worktree.path}`,
      `inspect the worktree, then commit or discard them: git -C ${worktree.path} status`,
    );
  }
  if (state.commits === 0) {
    throw new JigsError(
      options.since === undefined
        ? `the agent committed nothing on ${worktree.branch}`
        : `the agent added no commit on ${worktree.branch} since ${options.since.slice(0, 7)}`,
      "check the agent's output for why it stopped, and whether its prompt asks it to commit",
    );
  }
  return state;
}

/**
 * Connect the Git routines to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindGitSteps(steps: GitSteps) {
  return {
    committedWork: (worktree: Worktree, options?: CommittedWorkOptions) =>
      committedWork(worktree, steps, options),
  };
}
