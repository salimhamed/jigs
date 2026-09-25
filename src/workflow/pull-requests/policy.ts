import { z } from "zod";

/** The label that approves a pull request for merging when a factory approves by label. */
export const APPROVED_LABEL = "jigs:approved";

/**
 * How the operator approves a pull request for merging.
 *
 * @remarks
 * `review` is an approving review of the current commit, so a later push withdraws it. `label` is
 * the `jigs:approved` label on the pull request, which stays valid after later pushes.
 */
export const mergeApprovalSchema = z.enum(["review", "label"]) as z.ZodEnum<{
  /** An approving review of the current commit. */
  review: "review";
  /** The `jigs:approved` label on the pull request. */
  label: "label";
}>;

/** The GitHub merge method jigs uses when it merges a pull request. */
export const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]) as z.ZodEnum<{
  /** Combine the branch into one commit. */
  squash: "squash";
  /** Create a merge commit that preserves the branch history. */
  merge: "merge";
  /** Replay the branch commits onto the base branch. */
  rebase: "rebase";
}>;

/** How the operator approves a pull request for merging: a review, or the `jigs:approved` label. */
export type MergeApproval = z.output<typeof mergeApprovalSchema>;
/** The GitHub merge method: squash, merge commit or rebase. */
export type MergeMethod = z.output<typeof mergeMethodSchema>;

/** How a binding's pull requests are approved and merged. */
export interface MergeSettings {
  /** The binding's merge method. */
  method: MergeMethod;
  /** The factory's approval signal. */
  approval: MergeApproval;
}
