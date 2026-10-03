import {
  type ApprovalCoverage,
  type BuildStopped,
  defineWorkflow,
  harnesses,
  JigsError,
  type NeedsHuman,
  renderTicketSnapshot,
  type TicketHandoff,
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
  followPullRequestToOutcome,
  noteOnTicket,
  postPullRequestNote,
  publishPullRequest,
  reviewTicket,
} from "#jigs/routines";
import { provisionWorktree, setTicketStatus } from "#jigs/steps";
import { prompts, type Ticket } from "./prompts.ts";

// The agents this workflow can run, by the part they play. A run picks one per
// part by name; edit a line here to change a default model or harness. The
// builder acts on GitHub as the factory's App (`github: true`), so it needs a
// GitHub App identity.
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol", github: true }),
  reviewer: harnesses.claude({ model: "opus" }),
};
const agentName = z.enum(["builder", "reviewer"]);

// Who merges a pull request once it is approved and CI is green:
// "jigs" merges it, "human" leaves the merge to you.
const mergedBy: "jigs" | "human" = "human";

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
  if ("stopped" in built) return stop(stoppedNote(key, worktree, reviewRounds, built.stopped));

  const pr = await publishPullRequest(delivery, {
    commit: built.reviewedCommit,
    pullRequest: ({ title, body }) => ({ title, body: withReviewerNotes(body, built.notes) }),
  });
  await setTicketStatus(snapshot.id, "In Review");

  const outcome = await followPullRequestToOutcome(delivery, pr, {
    attemptsPerUpdate,
    mergedBy,
    approvalCovers,
    // Only a note: the ticket stays In Review while the run keeps watching.
    onNeedsHuman: (facts) =>
      noteOnTicket(claim, needsHumanNote(key, worktree, pr.url, attemptsPerUpdate, facts)),
    // Called once per head; the marker also keeps a later run from posting it again.
    onMergeBlocked: ({ headSha, scope, detail }) =>
      postPullRequestNote({ pr, scope, headSha, reason: "merge-retry", body: detail }),
  });
  if (outcome === "closed") return stop(closedNote(key, worktree, pr.url));

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

// Notes name the branch, never the local worktree path: they are posted where
// anyone on the ticket can read them, and `jigs status` shows the path.
const workLocation = (worktree: Worktree) =>
  `The work is on branch \`${worktree.branch}\`, in the run's local worktree, which \`jigs status\` lists.`;

function stoppedNote(
  key: string,
  worktree: Worktree,
  rounds: number,
  stopped: BuildStopped,
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
        ? `jigs stopped work on ${key} after ${rounds} review round(s) without an approved change.`
        : `jigs stopped work on ${key} before review.`,
    notes: [
      ...why,
      ...(stopped.pushed ? [] : ["Could not push the branch; the service log has the push error."]),
      workLocation(worktree),
    ],
    closing:
      "Nothing is waiting on a reply here. Another run starts over on a new branch; to keep this work, take the branch over by hand.",
  };
}

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

function needsHumanNote(
  key: string,
  worktree: Worktree,
  url: string,
  attempts: number,
  facts: NeedsHuman,
): TicketNote {
  const held = facts.unpublished === undefined ? [] : [localState(facts.unpublished)];
  const why = {
    "builder-asked": [`The builder needs a person: ${facts.detail}`, ...held],
    "attempts-exhausted": [
      `Exhausted ${attempts} attempts for this pull request update.`,
      ...held,
      `The builder last said: ${facts.detail}`,
    ],
    "merge-refused": [
      (facts.tries ?? 1) > 1
        ? `Could not merge the pull request after ${facts.tries} tries: ${facts.detail}`
        : `Could not merge the pull request: ${facts.detail}`,
    ],
  }[facts.reason];
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
