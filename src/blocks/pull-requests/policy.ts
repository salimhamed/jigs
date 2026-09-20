import { z } from "zod";

/** Selects how the operator authorizes an automatic merge. */
export const approvalSignalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    /** Require an approving review of the current commit. */
    kind: z.literal("review"),
  }),
  z.strictObject({
    /** Require a named label, which remains valid after later pushes. */
    kind: z.literal("label"),
    /** The label that authorizes merging whenever the pull request is ready. */
    name: z.string().min(1),
  }),
]);

/**
 * Configures who merges a pull request, how it is merged and how approval is recorded.
 *
 * @remarks
 * `by` chooses an automatic jigs merge or a human merge. `method` selects squash, merge-commit or
 * rebase behavior. `approval` requires either a review of the current commit or a named label that
 * remains valid after later pushes.
 */
export const mergePolicySchema = z.strictObject({
  /** Whether jigs merges an eligible pull request or waits for a person to merge it. */
  by: (
    z.enum(["jigs", "human"]) as z.ZodEnum<{
      /** Let jigs merge the pull request when every gate is satisfied. */
      jigs: "jigs";
      /** Leave the merge action to a person. */
      human: "human";
    }>
  ).default("human"),
  /** The GitHub merge method to use when jigs performs the merge. */
  method: (
    z.enum(["squash", "merge", "rebase"]) as z.ZodEnum<{
      /** Combine the branch into one commit. */
      squash: "squash";
      /** Create a merge commit that preserves the branch history. */
      merge: "merge";
      /** Replay the branch commits onto the base branch. */
      rebase: "rebase";
    }>
  ).default("squash"),
  /** The signal that authorizes an automatic merge. */
  approval: approvalSignalSchema.default({ kind: "review" }),
});

/** The review or label signal that authorizes an automatic merge. */
export type ApprovalSignal = z.output<typeof approvalSignalSchema>;
/** The effective pull request merge behavior for a binding. */
export type MergePolicy = z.output<typeof mergePolicySchema>;
