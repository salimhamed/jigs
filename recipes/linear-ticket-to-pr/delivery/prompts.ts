// The prompts this recipe sends. Plain functions: to change what an agent is
// told, edit the function. Each turn has two forms. `resume` is for an agent
// that already holds the earlier turns and is told only what is new. `fresh`
// is for an agent starting from nothing and is told everything.

import type { PullRequestRef, PullRequestSnapshot, Worktree } from "@jigs-ai/jigs";
import type { WorkItem } from "./delivery.ts";
import {
  type FindingResponse,
  type ReviewFinding,
  type ReviewRound,
  renderFindings,
  renderLedger,
  renderResponses,
} from "./review.ts";

const join = (parts: string[]) => parts.filter(Boolean).join("\n\n");

const taskBrief = (task: WorkItem, worktree: Worktree) =>
  join([
    `Task ${task.key}: ${task.title}`,
    task.url ?? "",
    task.instructions,
    `Base commit: ${worktree.baseSha}`,
  ]);

const answerFindings =
  "Answer every finding you were given, one response each, quoting the finding as it was stated. Set changed to true with what you changed, or to false with the reason you did not: a finding you decline stays open until the reviewer accepts your reason, so give one it can judge. Return no responses when you were given no findings.";

export const implementation = {
  job: "Implement the requirements and address the findings. Follow the repository instructions, run relevant checks, and commit before you finish: only committed work is reviewed. Do not push or open a pull request.",

  /** A builder that already holds the task: only the new findings. */
  resume: (findings: ReviewFinding[]) =>
    join([
      findings.length === 0 ? "" : `The reviewer found:\n${renderFindings(findings)}`,
      implementation.job,
      answerFindings,
    ]),

  /** A builder starting from nothing: the task, the current diff, and the findings. */
  fresh: (task: WorkItem, worktree: Worktree, findings: ReviewFinding[], diff: string) =>
    join([
      taskBrief(task, worktree),
      diff === "" ? "" : `Current diff:\n${diff}`,
      findings.length === 0 ? "" : `Open findings:\n${renderFindings(findings)}`,
      implementation.job,
      answerFindings,
    ]),
};

export const review = {
  job: "Review the changes against the requirements and repository instructions. Inspect the diff between the base and head commits and check for correctness and regressions. Do not edit files. A finding is blocking when it is a stated requirement left unmet, a defect a user could hit, or an untested risk that matters; preferences about naming, structure, comments, extra tests and wording are not. Mark each finding blocking or not. Return changes-requested only when a blocking finding remains; otherwise return approved and keep the non-blocking observations, which a human reads on the pull request.",

  /** A reviewer that judged earlier rounds: the new head and the builder's answers. */
  resume: (headSha: string, diff: string, responses: FindingResponse[]) =>
    join([
      `Head commit under review: ${headSha}`,
      responses.length === 0
        ? ""
        : `The builder answered your findings:\n${renderResponses(responses)}`,
      `Current diff:\n${diff}`,
      review.job,
      "Do not re-open a finding you cleared unless the code under it changed. Where the builder gave a reason for not changing something, accept it and drop the finding, or re-raise it as blocking with one sentence saying why the reason does not hold.",
    ]),

  /** A reviewer starting from nothing: the task plus every earlier round. */
  fresh: (
    task: WorkItem,
    worktree: Worktree,
    headSha: string,
    diff: string,
    ledger: ReviewRound[],
  ) =>
    join([
      taskBrief(task, worktree),
      `Head commit under review: ${headSha}`,
      ledger.length === 0 ? "" : `Earlier rounds:\n${renderLedger(ledger)}`,
      `Current diff:\n${diff}`,
      review.job,
    ]),
};

export const maintenance = {
  job: "Continue maintaining the pull request you implemented. Read the discussion, code, and checks and decide what needs attention; a new message may need no action, including your own replies. Use GitHub tools to investigate and respond directly when useful. Safely synchronize the worktree with the PR branch before editing; never discard other people's work or force-push. Fix issues, run relevant checks, commit and push any changes. Do not merge or approve the PR yourself: the workflow applies the factory's merge policy. Return finished only when no work remains for you on the current code and discussion; pending when waiting for checks or another external change; needs-human when you cannot proceed without help. Explain the result in summary. Do not repeat a reply or change already made. When everything is settled, post nothing. Return needs-human if GitHub tools or credentials are unavailable; do not claim completion.",
  resume: (pr: PullRequestRef, snapshot: PullRequestSnapshot) =>
    join([
      `Pull request: https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
      `Current GitHub facts:\n${JSON.stringify(snapshot)}`,
      maintenance.job,
    ]),
  fresh: (
    task: WorkItem,
    worktree: Worktree,
    diff: string,
    pr: PullRequestRef,
    snapshot: PullRequestSnapshot,
  ) =>
    join([taskBrief(task, worktree), `Current diff:\n${diff}`, maintenance.resume(pr, snapshot)]),
};

export const description = (task: WorkItem, worktree: Worktree, diff: string) =>
  join([
    taskBrief(task, worktree),
    `Current diff:\n${diff}`,
    "Write a concise pull request title and body explaining the change and its validation. Include the task link when available. Follow the repository's pull request conventions. Do not modify files.",
  ]);
