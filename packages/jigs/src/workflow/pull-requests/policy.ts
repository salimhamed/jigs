/**
 * Which commits an approving review covers, chosen in workflow code.
 *
 * @remarks
 * `latest-commit`, the default, counts an approval only on the commit it names, so a push
 * withdraws it. `any-commit` keeps a person's approval counting through later pushes until a
 * later review requests changes or the approval is dismissed; approvals by a bot, such as an
 * agent acting as the factory's GitHub App, never count.
 */
export type ApprovalCoverage = "latest-commit" | "any-commit";

/**
 * Whose consent a merge needs, chosen in workflow code for each merge.
 *
 * @remarks
 * `operator`, the default, needs a person's approving review. `workflow` lets the
 * workflow's own checks stand in for it, for a workflow that judges a pull request itself, such as
 * one that tests a dependency update before merging it. Every other merge requirement still holds,
 * and a review requesting changes still stops the merge.
 */
export type MergeConsent = "operator" | "workflow";
