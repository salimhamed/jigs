import {
  type ApprovalCoverage,
  type BuildStopped,
  builderWakeFacts,
  defaultPullRequestScope,
  defineWorkflow,
  harnesses,
  JigsError,
  type NeedsHuman,
  renderTicketSnapshot,
  type TicketNote,
  type UnpublishedWork,
  type WorkflowInputs,
  type Worktree,
} from "@jigs-ai/jigs";
import { z } from "zod";
import {
  acquireTicket,
  agentSession,
  buildAndReview,
  describePullRequest,
  followPullRequestToOutcome,
  noteOnTicket,
  postPullRequestNote,
  publishPullRequest,
} from "#jigs/routines";
import { provisionWorktree, pushBranch, setTicketStatus } from "#jigs/steps";
import { prompts, type Ticket } from "./prompts.ts";
import { reviewTicket, type TicketHandoff } from "./review-ticket.ts";

// The agents this workflow can run, by the part they play. A run picks one per
// part by name; edit a line here to change a default model or harness. The
// builder acts on GitHub as the factory's App (`github: true`), so it needs a
// GitHub App identity.
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol", github: true }),
  reviewer: harnesses.claude({ model: "opus" }),
};
const agentName = z.enum(["builder", "reviewer"]);

// Who merges a pull request once it is approved and CI is green: "jigs"
// merges it, "human" leaves the merge to you. jigs never merges in a repository
// with no CI. For a rule of your own, such as merging only with a label, pass a
// check on the snapshot as `mergeWhen` below.
const mergedBy: "jigs" | "human" = "jigs";

// "any-commit" lets a person's approving review also cover later pushes.
const approvalCovers: ApprovalCoverage = "latest-commit";

const inputs = z.object({
  ticket: z.string().min(1),
  binding: z.string().min(1),
  builder: agentName.default("builder"),
  reviewer: agentName.default("reviewer"),
  // Fixed for the life of the run. To spend more, start another run.
  budget: z
    .object({
      reviewRounds: z.number().int().positive().default(3),
      attemptsPerUpdate: z.number().int().positive().default(3),
    })
    .prefault({}),
});

/** Take a Linear ticket through implementation, review, and pull-request merge. */
export async function linearTicketToPr(input: WorkflowInputs<typeof inputs>) {
  "use workflow";

  const { claim, snapshot } = await acquireTicket(input.ticket);
  await setTicketStatus(snapshot.id, "In Progress");

  const worktree = await provisionWorktree({ binding: input.binding, branch: snapshot.branchName });
  const handoff = await reviewTicket({
    claim,
    snapshot,
    harness: agents[input.reviewer],
    cwd: worktree.path,
  });

  const key = snapshot.identifier;
  const cwd = worktree.path;
  const delivery = {
    work: ticket(handoff),
    key,
    worktree,
    prompts,
    builder: agentSession({ name: "builder", harness: agents[input.builder], cwd }),
    reviewer: agentSession({ name: "reviewer", harness: agents[input.reviewer], cwd }),
  };

  // A stop leaves the work where it is, tells the ticket, and fails the run.
  const stop = async (note: TicketNote): Promise<never> => {
    await noteOnTicket(claim, note);
    await setTicketStatus(snapshot.id, "Todo");
    throw new JigsError(note.headline);
  };

  const { reviewRounds, attemptsPerUpdate } = input.budget;
  const built = await buildAndReview(delivery, { rounds: reviewRounds });
  if (built.outcome === "stopped") {
    // The push keeps committed work on the remote for whoever takes it over.
    // Its error can name local paths, so it stays in the service log.
    const pushed = await pushBranch(worktree).then(
      () => true,
      () => false,
    );
    return stop(stoppedNote(key, worktree, built, pushed));
  }

  // A title the writer gets wrong twice stops the run before anything is pushed.
  const rejected: string[] = [];
  const described = await describePullRequest(delivery, {
    check: ({ title }) => {
      const problems = titleProblems(title);
      if (problems.length > 0) rejected.push(title);
      return problems;
    },
  }).catch((error: unknown) =>
    rejected.length === 2
      ? stop(unconventionalNote(key, worktree, rejected))
      : Promise.reject(error),
  );
  const pr = await publishPullRequest(delivery, {
    commit: built.reviewedCommit,
    title: described.title,
    body: withReviewerNotes(described.body, built.notes),
  });
  await setTicketStatus(snapshot.id, "In Review");

  const followed = await followPullRequestToOutcome(delivery, pr, {
    attemptsPerUpdate,
    wake: builderWakeFacts,
    mergeWhen: () => mergedBy === "jigs",
    approvalCovers,
    // A blocked merge is noted on the pull request, marked so it wakes no
    // builder and a later run does not post it again. Anything else is only a
    // ticket note: the ticket stays In Review while the run keeps watching.
    onNeedsHuman: (facts) =>
      facts.reason === "merge-blocked"
        ? postPullRequestNote({
            pr,
            scope: defaultPullRequestScope(key),
            headSha: facts.headSha,
            reason: "merge-retry",
            body: facts.detail,
          })
        : noteOnTicket(claim, needsHumanNote(key, worktree, pr.url, attemptsPerUpdate, facts)),
  });
  if (followed.outcome === "closed") return stop(closedNote(key, worktree, pr.url));

  await setTicketStatus(snapshot.id, "Done");
  return { pr: pr.url };
}

/** The ticket and its implementation brief, as one statement of the work. */
function ticket(handoff: TicketHandoff): Ticket {
  return {
    key: handoff.snapshot.identifier,
    title: handoff.snapshot.title,
    url: handoff.snapshot.url,
    instructions: `${renderTicketSnapshot(handoff.snapshot)}\n\n## Implementation brief\n${handoff.brief}\n\nThe ticket requirements take precedence over the brief.`,
  };
}

// The reviewer's remaining observations are added here rather than asked of
// the writer: they are the one part of the body a model must not leave out.
const withReviewerNotes = (description: string, notes: string[]) =>
  notes.length === 0
    ? description
    : `${description}\n\n## Reviewer notes\n\n${notes.map((note) => `- ${note}`).join("\n")}`;

// Pull request titles are conventional commit subjects, because release tooling
// and title lint read the squashed title. To allow any title, delete the
// `check` passed to `describePullRequest` and the title rule in `prompts.ts`.
const CONVENTIONAL_SUBJECT =
  /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([^)]+\))?!?: .+/;

const titleProblems = (title: string) =>
  CONVENTIONAL_SUBJECT.test(title)
    ? []
    : [
        `The title "${title}" is not a conventional commit subject: write \`<type>: <subject>\` or \`<type>(<scope>): <subject>\`, with type one of feat, fix, chore, docs, style, refactor, perf, test, build, ci or revert.`,
      ];

// Notes name the branch, never the local worktree path: they are posted where
// anyone on the ticket can read them, and `jigs status` shows the path.
const workLocation = (worktree: Worktree) =>
  `The work is on branch \`${worktree.branch}\`, in the run's local worktree, which \`jigs status\` lists.`;

function stoppedNote(
  key: string,
  worktree: Worktree,
  stopped: BuildStopped,
  pushed: boolean,
): TicketNote {
  const why = {
    "rounds-exhausted": stopped.findings,
    uncommitted: [
      "The builder left uncommitted changes; run `git status` in the run's worktree (`jigs status` lists it).",
    ],
    "no-commits": [`The builder committed nothing new on branch \`${worktree.branch}\`.`],
  }[stopped.reason];
  return {
    headline:
      stopped.reason === "rounds-exhausted"
        ? `jigs stopped work on ${key} after ${stopped.round} review round(s) without an approved change.`
        : stopped.round === 1
          ? `jigs stopped work on ${key} before review.`
          : `jigs stopped work on ${key} in round ${stopped.round}, before its review.`,
    notes: [
      ...why,
      ...(pushed ? [] : ["Could not push the branch; the service log has the push error."]),
      workLocation(worktree),
    ],
    closing:
      "Nothing is waiting on a reply here. Another run starts over on a new branch; to keep this work, take the branch over by hand.",
  };
}

const unconventionalNote = (key: string, worktree: Worktree, titles: string[]): TicketNote => ({
  headline: `jigs stopped before opening a pull request for ${key}: its title is not a conventional commit.`,
  notes: [`Proposed titles: ${titles.join(", then ")}`, workLocation(worktree)],
  closing:
    "Nothing has been pushed and nothing is waiting on a reply here. Push the branch and open the pull request by hand, or start another run.",
});

// Nothing is pushed on the way out: unpublished local work stays for the person taking over.
const closedNote = (key: string, worktree: Worktree, url: string): TicketNote => ({
  headline: `jigs stopped pull request maintenance for ${key}.`,
  notes: [
    "The pull request was closed unmerged.",
    `Unfinished pull request: ${url}`,
    "Local work was retained without an automatic push.",
    workLocation(worktree),
  ],
  closing:
    "Inspect the existing pull request and retained worktree, then take over the unfinished work by hand.",
});

const localState = (work: UnpublishedWork) =>
  `The worktree is ${work.dirty ? "dirty (uncommitted changes remain)" : "clean"}; local HEAD is ${work.localHead}, the pull request's head is ${work.pullRequestHead}. This local work holds back the merge until the worktree is clean and its HEAD is a commit the pull request has had.`;

const held = (work: UnpublishedWork | undefined) => (work === undefined ? [] : [localState(work)]);

function needsHumanWhy(
  attempts: number,
  facts: Exclude<NeedsHuman, { reason: "merge-blocked" }>,
): string[] {
  switch (facts.reason) {
    case "builder-asked":
      return [`The builder needs a person: ${facts.detail}`, ...held(facts.unpublished)];
    case "attempts-exhausted":
      return [
        `Exhausted ${attempts} attempts for this pull request update.`,
        ...held(facts.unpublished),
        `The builder last said: ${facts.detail}`,
      ];
    case "merge-refused":
      return [
        facts.tries > 1
          ? `Could not merge the pull request after ${facts.tries} tries: ${facts.detail}`
          : `Could not merge the pull request: ${facts.detail}`,
      ];
  }
}

function needsHumanNote(
  key: string,
  worktree: Worktree,
  url: string,
  attempts: number,
  facts: Exclude<NeedsHuman, { reason: "merge-blocked" }>,
): TicketNote {
  const why = needsHumanWhy(attempts, facts);
  return {
    headline: `jigs needs a person to move the pull request for ${key} forward.`,
    notes: [...why, `Pull request: ${url}`, workLocation(worktree)],
    closing:
      "jigs is still watching the pull request: the next change to it, such as a re-run check, a new comment or review, or an approval, picks the work back up.",
  };
}

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["linear", "github"] },
  workflow: linearTicketToPr,
});
