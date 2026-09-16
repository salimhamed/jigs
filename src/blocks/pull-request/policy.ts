import { z } from "zod";

// What counts as the operator saying "merge this". `review` is a GitHub
// APPROVED review of the current commit, which only an identity other than
// the operator's can receive. `label` is a label on the pull request, which is
// how an operator consents to their own pull request merging: it means "merge
// whenever ready" and survives later pushes.
export const approvalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("review") }),
  z.strictObject({ kind: z.literal("label"), name: z.string().min(1) }),
]);

export const mergeSchema = z.strictObject({
  by: z.enum(["jigs", "human"]).default("human"),
  method: z.enum(["squash", "merge", "rebase"]).default("squash"),
  approval: approvalSchema.default({ kind: "review" }),
});

export type ApprovalSignal = z.output<typeof approvalSchema>;
export type MergePolicy = z.output<typeof mergeSchema>;
