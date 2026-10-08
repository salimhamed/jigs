import {
  type ApprovalCoverage,
  type BuildStopped,
  builderWakeFacts,
  defaultPullRequestScope,
  defineWorkflow,
  harnesses,
  installationNameSchema,
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
import {
  provisionWorktree,
  pushBranch,
  setLinearAgentSessionUrls,
  setTicketStatus,
} from "#jigs/steps";
import { prompts, type Ticket } from "./prompts.ts";
import { reviewTicket, type TicketHandoff } from "./review-ticket.ts";

// The agents this workflow can run, by the part they play. A run picks one per
// part by name; edit a line here to change a default model or harness. The
// builder also acts on GitHub as the factory's App, through the binding's
// installation, which the run adds once it has the worktree.
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
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
  // The Linear installation, as named on the hub, the ticket is in.
  linearInstallation: installationNameSchema,
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

  const installationName = input.linearInstallation;
  const { claim, snapshot } = await acquireTicket({ installationName, reference: input.ticket });
  // Every way out ends the ticket's session, or Linear shows the run working
  // after it has gone: a stop with its own note, anything else with the error.
  let ended = false;
  try {
    const setStatus = (stateName: string) =>
      setTicketStatus({ installationName, issueId: snapshot.id, stateName });
    await setStatus("In Progress");

    const worktree = await provisionWorktree({
      binding: input.binding,
      branch: snapshot.branchName,
    });
    const builder = {
      ...agents[input.builder],
      github: { installationName: worktree.installationName },
    };
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
      builder: agentSession({ name: "builder", harness: builder, cwd }),
      reviewer: agentSession({ name: "reviewer", harness: agents[input.reviewer], cwd }),
    };

    // An ending sets the ticket's status before its note, so the note is the
    // run's last word.
    const end = async (stateName: string, note: TicketNote) => {
      await setStatus(stateName);
      await noteOnTicket(claim, { ...note, run: "ended" });
      ended = true;
    };
    // A stop leaves the work where it is, ends the ticket's session, and fails
    // the run.
    const stop = async (note: TicketNote): Promise<never> => {
      await end("Todo", note);
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
    await setStatus("In Review");
    await setLinearAgentSessionUrls({
      installationName,
      sessionId: claim.sessionId,
      urls: [{ label: "Pull request", url: pr.url }],
    });
    // Linear marks a session stale after about 30 quiet minutes; one awaiting
    // input never does.
    await noteOnTicket(claim, openedNote(pr.url));

    const followed = await followPullRequestToOutcome(delivery, pr, {
      attemptsPerUpdate,
      wake: builderWakeFacts,
      mergeWhen: () => mergedBy === "jigs",
      approvalCovers,
      // A blocked merge is noted on the pull request, marked so it wakes no
      // builder and a later run does not post it again. Anything else is only a
      // note in the ticket's session: the ticket stays In Review while the run keeps watching.
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
    // The run completes: its work is pushed to the branch the note names, and
    // the release policy keeps a dirty worktree or unmerged local commits. A
    // push error can name local paths, so it stays in the service log.
    if (followed.outcome === "closed") {
      await pushBranch(worktree).catch(() => {});
      await end("Todo", closedNote(worktree));
      return { outcome: "closed" as const, pr: pr.url };
    }

    await end("Done", { headline: `Merged ${pr.url}.`, notes: [], closing: "" });
    return { outcome: "merged" as const, pr: pr.url };
  } catch (error) {
    if (!ended) {
      await noteOnTicket(claim, {
        // The error can name local paths, so it stays in the service log and on the run's page.
        headline: "The run failed. The run's page has the error.",
        notes: [],
        closing: "",
        run: "ended",
      }).catch(() => {});
    }
    throw error;
  }
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
        ? `Work on ${key} stopped after ${stopped.round} review round(s) without an approved change.`
        : stopped.round === 1
          ? `Work on ${key} stopped before review.`
          : `Work on ${key} stopped in round ${stopped.round}, before its review.`,
    notes: [
      ...why,
      ...(pushed ? [] : ["Could not push the branch; the service log has the push error."]),
      workLocation(worktree),
    ],
    closing:
      "Nothing is waiting on a reply here. Another run starts over on a new branch; to keep this work, take the branch over by hand.",
  };
}

const openedNote = (url: string): TicketNote => ({
  headline: `Pull request ${url} is open.`,
  notes: [],
  closing:
    mergedBy === "jigs"
      ? "The pull request will be merged once it's approved and CI passes. Comment on the pull request to change anything, or close it to stop the run."
      : "It's yours to merge once it's approved and CI passes. Comment on the pull request to change anything, or close it to stop the run.",
  run: "waiting",
});

const unconventionalNote = (key: string, worktree: Worktree, titles: string[]): TicketNote => ({
  headline: `Stopped before opening a pull request for ${key}: its title is not a conventional commit.`,
  notes: [`Proposed titles: ${titles.join(", then ")}`, workLocation(worktree)],
  closing:
    "Nothing has been pushed and nothing is waiting on a reply here. Push the branch and open the pull request by hand, or start another run.",
});

const closedNote = (worktree: Worktree): TicketNote => ({
  headline: "Stopped: the pull request was closed, so it won't be merged.",
  notes: [],
  closing: `The work is still on branch \`${worktree.branch}\` if you want it back.`,
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
    headline: `The pull request for ${key} needs a person to move it forward.`,
    notes: [...why, `Pull request: ${url}`, workLocation(worktree)],
    closing:
      "Comment on the pull request or push to it, or close it to stop the run; replies here aren't read. The pull request is still being watched: the next change to it, such as a re-run check, a new comment or review, or an approval, picks the work back up.",
    run: "waiting",
  };
}

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["linear", "github"] },
  workflow: linearTicketToPr,
});
