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

/**
 * Which commits an approving review covers, chosen in workflow code.
 *
 * @remarks
 * `latest-commit`, the default, counts an approval only on the commit it names, so a push
 * withdraws it. `any-commit` keeps a person's approval counting through later pushes until a
 * later review requests changes or the approval is dismissed; approvals by a bot, such as an
 * agent acting as the factory's GitHub App, never count. It changes nothing for label approval.
 */
export type ApprovalCoverage = "latest-commit" | "any-commit";
