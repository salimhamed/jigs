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

/** How the operator approves a pull request for merging: a review, or the `jigs:approved` label. */
export type MergeApproval = z.output<typeof mergeApprovalSchema>;
