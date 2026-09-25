import { z } from "zod";

export const releaseSchema = z.strictObject({
  /** What to do with eligible resources after a completed run. */
  onSuccess: z.enum(["release", "keep"]),
  /** What to do with eligible resources after a failed or cancelled run. */
  onFailure: z.enum(["keep", "release"]),
});
/** Selects whether eligible run resources are released for each terminal outcome. */
export type ReleasePolicy = z.input<typeof releaseSchema>;
export const defaultReleasePolicy = (): ReleasePolicy => ({
  onSuccess: "release",
  onFailure: "keep",
});

export interface ReleasedResource {
  /** The local filesystem path of the managed resource. */
  path: string;
  /** Whether the resource was removed. */
  removed: boolean;
  /** Why the resource was removed or retained. */
  reason: string;
}

/** The result of applying a release policy to one run's managed resources. */
export interface ReleaseReport {
  /** The policy applied by this release attempt. */
  policy: ReleasePolicy;
  /**
   * Results for the run's worktrees, including paths, branches, removal flags, unmerged commit
   * counts and reasons for anything retained.
   */
  worktrees: (ReleasedResource & {
    /** The Git branch checked while releasing this worktree. */
    branch: string;
    /** Whether the local branch was deleted. */
    localBranchDeleted: boolean;
    /** Whether the remote branch was deleted. */
    remoteBranchDeleted: boolean;
    /** Commits not proven merged, or `null` when ancestry could not be verified. */
    unmergedCommits: number | null;
  })[];
  /** The scratch directory's local path, removal flag and reason for the result. */
  runDirectory: ReleasedResource;
}
