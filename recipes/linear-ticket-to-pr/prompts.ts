// The prompts this recipe sends. Plain functions: to change what an agent is
// told, edit the function. Each turn has two forms. `resume` is for an agent
// that already holds the earlier turns and is told only what is new. `fresh`
// is for an agent starting from nothing and is told everything. jigs appends
// one line to each, asking for the answer in the shape it reads.

import type {
  DeliveryPrompts,
  FindingResponse,
  PullRequestRef,
  ReviewFinding,
  ReviewRound,
  UnpublishedWork,
  Worktree,
} from "@jigs-ai/jigs";

/** The ticket as the agents see it. Add a field here and fill it in the workflow. */
export interface Ticket {
  key: string;
  title: string;
  url: string;
  instructions: string;
}

const join = (parts: string[]) => parts.filter(Boolean).join("\n\n");

const brief = (ticket: Ticket, worktree: Worktree) =>
  join([
    `Task ${ticket.key}: ${ticket.title}`,
    ticket.url,
    ticket.instructions,
    `Base commit: ${worktree.baseSha}`,
  ]);

const renderFindings = (findings: ReviewFinding[]) =>
  findings
    .map((finding) => `- ${finding.summary}${finding.blocking ? "" : " (non-blocking)"}`)
    .join("\n");

const renderResponses = (responses: FindingResponse[]) =>
  responses
    .map((r) => `- ${r.finding}\n  ${r.changed ? "changed" : "not changed"}: ${r.detail}`)
    .join("\n");

const renderLedger = (rounds: ReviewRound[]) =>
  rounds
    .map((round) =>
      [
        `Round ${round.round}: ${round.verdict}`,
        round.responses.length === 0
          ? ""
          : `Builder responses:\n${renderResponses(round.responses)}`,
        round.findings.length === 0 ? "No findings." : renderFindings(round.findings),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

const prUrl = (pr: PullRequestRef) => `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;

const recoveryFacts = (recovery: UnpublishedWork) =>
  [
    `The worktree is ${recovery.dirty ? "dirty (uncommitted changes remain)" : "clean"}.`,
    `Local HEAD: ${recovery.localHead}. Published PR head: ${recovery.pullRequestHead}.`,
    "Inspect these facts and safely finish, commit, push, or synchronize the work as needed. Do not discard work or force-push.",
  ].join(" ");

const build =
  "Implement the requirements and address the findings. Follow the repository instructions, run relevant checks, and commit before you finish: only committed work is reviewed. Do not push or open a pull request. A finding you decline stays open until the reviewer accepts your reason, so give one it can judge.";

const review =
  "Review the changes against the requirements and repository instructions. Inspect the diff between the base and head commits and check for correctness and regressions. Do not edit files. No pull request exists yet and CI has not run: review only the diff and worktree you are given, do not look up pull requests, branches or CI status on GitHub, and leave acceptance criteria about CI or the pull request to the pull-request phase that follows. A finding is blocking when it is a stated requirement left unmet, a defect a user could hit, or an untested risk that matters; preferences about naming, structure, comments, extra tests and wording are not. Only a blocking finding sends the change back to the builder; non-blocking findings are kept for a human to read on the pull request.";

const maintain = join([
  "Continue maintaining the pull request you implemented.",
  "Read the discussion, code, and checks and decide what needs attention; a new message may need no action, including your own replies.",
  "You act on GitHub as the factory's App bot (appBot in the GitHub facts): `gh` is signed in as it and your pushes go as it. Use `gh` to investigate and respond directly when useful. Reply with comments; never submit a review. Comments by the bot without a hidden jigs marker are your own earlier replies.",
  "Safely synchronize the worktree with the PR branch before editing; never discard other people's work or force-push.",
  "Fix issues, run relevant checks, commit and push any changes. Uncommitted or unpublished work needs recovery now, not waiting for GitHub activity.",
  "Do not merge or approve the PR yourself: the workflow decides who merges.",
  "A check that failed for a reason you cannot see, while you wait for someone to re-run it, needs no person: say in your summary that you are waiting for the re-run.",
  "Ask for a person only when one must act before you can continue, and say what they need to do. A person is told, and the pull request stays watched.",
  "You are woken again on the next change to the pull request that needs you: new discussion, a newly failed check, or a conflict with the base branch. Checks that queue, run or pass do not wake you, and the workflow merges an approved, green pull request without you.",
  'ci "none" means no check has reported on the head: CI may not have started yet, or the repository has none. Do not wait for it.',
  "Do not repeat a reply or change already made. When everything is settled, post nothing.",
  "Ask for a person if `gh` or pushing to GitHub does not work; do not claim completion.",
]);

const describe = join([
  "Write a concise pull request title and body explaining the change and its validation. Include the task link when available. Follow the repository's pull request conventions. Do not modify files.",
  "The title must be a conventional commit subject, because it becomes the squashed commit that release tooling reads: `<type>: <subject>` or `<type>(<scope>): <subject>`, with type one of feat, fix, chore, docs, style, refactor, perf, test, build, ci or revert, and `!` after the type or scope for a breaking change. Pick the type from what the change does: a new capability is `feat`, a repaired defect is `fix`. The subject is lowercase and imperative, with no trailing period.",
]);

export const prompts: DeliveryPrompts<Ticket> = {
  build: {
    fresh: ({ work, worktree, findings, diff }) =>
      join([
        brief(work, worktree),
        diff === "" ? "" : `Current diff:\n${diff}`,
        findings.length === 0 ? "" : `Open findings:\n${renderFindings(findings)}`,
        build,
      ]),
    resume: ({ findings }) =>
      join([
        findings.length === 0 ? "" : `The reviewer found:\n${renderFindings(findings)}`,
        build,
      ]),
  },

  review: {
    fresh: ({ work, worktree, headSha, diff, ledger }) =>
      join([
        brief(work, worktree),
        `Head commit under review: ${headSha}`,
        ledger.length === 0 ? "" : `Earlier rounds:\n${renderLedger(ledger)}`,
        `Current diff:\n${diff}`,
        review,
      ]),
    resume: ({ headSha, diff, responses }) =>
      join([
        `Head commit under review: ${headSha}`,
        responses.length === 0
          ? ""
          : `The builder answered your findings:\n${renderResponses(responses)}`,
        `Current diff:\n${diff}`,
        review,
        "Do not re-open a finding you cleared unless the code under it changed. Where the builder gave a reason for not changing something, accept it and drop the finding, or re-raise it as blocking with one sentence saying why the reason does not hold.",
      ]),
  },

  describe: ({ work, worktree, diff }) =>
    join([brief(work, worktree), `Current diff:\n${diff}`, describe]),

  maintain: {
    fresh: ({ work, worktree, diff, ...facts }) =>
      join([brief(work, worktree), `Current diff:\n${diff}`, prompts.maintain.resume(facts)]),
    resume: ({ pr, snapshot, news, recovery }) =>
      join([
        `Pull request: ${prUrl(pr)}`,
        news.length === 0
          ? ""
          : `New since your last turn:\n${news.map((fact) => `- ${fact}`).join("\n")}`,
        `Current GitHub facts:\n${JSON.stringify(snapshot)}`,
        recovery === undefined ? "" : `Recovery required:\n${recoveryFacts(recovery)}`,
        maintain,
      ]),
  },
};
