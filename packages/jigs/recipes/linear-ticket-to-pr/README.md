# linear-ticket-to-pr

This workflow takes a Linear ticket to a merged pull request. It claims the
ticket, asks in the ticket's Linear agent session when the requirements are
unclear, has one agent build the change and another review it, opens the pull
request, and follows its review comments and CI with the same builder session
until it merges.

The run opens one Linear agent session on the ticket when it starts, and says
everything there: its questions, its notes, and its last word, "Merged" with
the pull request, or why it stopped. Answer a question by replying in the
session. A message sent while the run is working waits for its next question;
press Stop to end the run. Every note mentions the operator (or the ticket's
creator) and the assignee, so they get a Linear notification.

These files are your factory's code now. Edit them freely: upgrading jigs never
overwrites them. The delivery itself, building, reviewing, publishing and
following the pull request, runs in four jigs routines the workflow calls.

| File | What it holds |
| --- | --- |
| `linear-ticket-to-pr.ts` | The workflow: its agents, inputs, the ticket status it sets between phases, and every note it posts. |
| `prompts.ts` | Every prompt the agents are sent. |
| `review-ticket.ts` | The ticket review before any code: the reviewer restates the ticket as a brief, or asks in the ticket's session until it can. |

## What it needs

- **A Linear app assigned to the factory, and the factory's GitHub App installed on the repository's owner**,
  each installation named on the hub. See
  [The factory's App](https://salimhamed.github.io/jigs/guide/configuration#github-app)
  and [The factory's Linear app](https://salimhamed.github.io/jigs/guide/configuration#linear-app).
- **Linear states named `Todo`, `In Progress`, `In Review` and `Done`** on the
  ticket's team. The workflow moves the ticket through them and fails on a
  missing one.
- **Claude Code and Codex**, installed and logged in. Both are declared in
  `requires.agents` and checked when the service starts.
- **The GitHub CLI, `gh`.** Once the worktree exists, the workflow gives the
  builder `github: { installationName: worktree.installationName }`, so it acts
  on GitHub as the factory's App through the binding's installation, the same
  bot jigs posts as: `gh` and its pushes
  use a token jigs gives it, and its commits are authored by the bot. See
  [GitHub access for agents](https://salimhamed.github.io/jigs/guide/models-and-harnesses#github-access).
  Missing access makes maintenance ask for help.
- **A binding** for the repository to change, naming the GitHub installation
  that reaches it: `pnpm exec jigs bind <remote> --installation <installation>`,
  then `pnpm exec jigs up`. See [bindings](https://salimhamed.github.io/jigs/guide/configuration#bindings).
- **Who merges.** `mergedBy` near the top of `linear-ticket-to-pr.ts` is
  `"jigs"`, so jigs merges once the pull request is approved and CI is green.
  Set it to `"human"` to have the run wait for you to merge. jigs never merges
  in a repository with no CI: add CI, or set `"human"` and merge yourself. The workflow passes it to jigs as
  `mergeWhen: () => mergedBy === "jigs"`; for a rule of your own, such as
  merging only with a label, check the snapshot `mergeWhen` receives instead.
  `approvalCovers`, next to it, is `"latest-commit"`,
  so a push needs a new approving review; `"any-commit"` lets a person's
  approval cover later pushes too. How you approve is set in
  [jigs.config.ts](https://salimhamed.github.io/jigs/guide/configuration#merging).
  The merge method is the first one the repository allows on GitHub: squash,
  then merge commit, then rebase.

GitHub and Linear events reach the run through the factory's
[hub](https://salimhamed.github.io/jigs/guide/configuration#hub).

## Pull request titles

Every pull request title is a
[conventional commit](https://www.conventionalcommits.org) subject, such as
`feat: add a flag` or `fix(api): retry a timeout`. Pull requests usually merge
as one squashed commit named after the title, and release tooling and
title-lint checks read that commit. The writer is told the rule in `prompts.ts`;
a title that breaks it is sent back once with the problem, and a second bad
title stops the run before anything is pushed, with a note in the ticket's session.

To allow any title, delete the `check` passed to `describePullRequest` in
`linear-ticket-to-pr.ts`, along with `titleProblems` and the title rule in the
`describe` prompt.

## Launch a run

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input linearInstallation=linear-acme --input binding=app
pnpm exec jigs watch
```

`linearInstallation` is the installation name of the Linear workspace the
ticket is in.

A run picks its builder and reviewer by name. By default the `builder` agent
builds and the `reviewer` agent reviews both the ticket's requirements and the
change. To have Claude Code build too:

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input linearInstallation=linear-acme --input binding=app --input builder=reviewer
```

A run cannot type a model name. To change a model, edit its line in `agents`.

## Budgets

| Budget | One unit buys | Default |
| --- | --- | --- |
| `reviewRounds` | One build plus one review of what it committed | 3 |
| `attemptsPerUpdate` | Builder attempts to handle each changed PR snapshot, including immediate recovery | 3 |

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input linearInstallation=linear-acme --input binding=app --input 'budget={"reviewRounds":5}'
```

Budget settings belong to this recipe and are fixed when the run starts.
`attemptsPerUpdate` is positive and resets for every PR change that wakes the
builder; it is not a lifetime limit on PR activity.

A stop before the pull request opens, or the pull request closing unmerged,
ends the ticket's session with a note saying what remains, sets `Todo`, and
fails the run. A merge sets `Done` and ends the session with "Merged" and the
pull request's link. Any other error ends the session with "The run failed" and
the error, leaves the ticket's status alone, and fails the run. To keep
the work, take over the branch, the retained worktree and any pull request by
hand; another run starts over on a new branch. Notes name the branch but never
the local worktree path; `jigs status` shows the path.

A pull request that needs a person, because the builder asked, its attempts ran
out, or the merge was refused, does not stop the run. The workflow posts a
note in the ticket's session saying what a person needs to do, leaves the ticket In Review, and
keeps watching: the next change to the pull request picks the work back up.

## The agents

The agents are a plain object, and the names a run may pick are a hand-written
enum beside it. TypeScript checks the two against each other where the workflow
reads `agents[input.builder]`. In `linear-ticket-to-pr.ts`, replace the
`agents` and `agentName` declarations with these; the imports are shown for
context and already exist in that file.

```ts
import { harnesses } from "@jigs-ai/jigs";
import { z } from "zod";

const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
  careful: harnesses.claude({ model: "opus", effort: "high" }),
};
const agentName = z.enum(["builder", "reviewer", "careful"]);
```

Adding `careful` as above lets a run pass `--input builder=careful`. Every agent
in the object is checked before a run starts, whether or not a run picks it.

The builder session continues from implementation into PR maintenance. It
judges the discussion and checks, then responds and pushes as the App's bot.
Its replies need no hidden comment markers: an unmarked comment by the bot is
its own. If its saved session is unavailable, a fresh prompt supplies the
ticket, current diff, and PR facts.

## The phases

The workflow calls four routines from `#jigs/routines` in order and sets the
ticket status between them. Before these calls,
[`linear-ticket-to-pr.ts`](./linear-ticket-to-pr.ts) acquires the ticket with
`acquireTicket`, provisions a worktree, and reviews the requirements. It then
builds `delivery`: the ticket as `work`, the ticket key as `key`, the worktree,
the prompts, and one agent session each for the builder and the reviewer.
Every routine takes it.

The following helper isolates the phase sequence from that setup. The shipped
workflow keeps these calls inline, with its own wording for each note, so you
can insert your own checks between phases.

```ts
import {
  builderWakeFacts,
  type Delivery,
  JigsError,
  type TicketClaim,
  type TicketSnapshot,
} from "@jigs-ai/jigs";
import {
  buildAndReview,
  describePullRequest,
  followPullRequestToOutcome,
  noteOnTicket,
  publishPullRequest,
} from "#jigs/routines";
import { setTicketStatus } from "#jigs/steps";
import type { Ticket } from "./prompts.ts";

export async function deliverTicket(
  delivery: Delivery<Ticket>,
  claim: TicketClaim,
  snapshot: TicketSnapshot,
) {
  const { installationName } = claim;
  const built = await buildAndReview(delivery, { rounds: 3 });
  if (built.outcome === "stopped") {
    await noteOnTicket(claim, {
      headline: `jigs stopped work on ${delivery.key} (${built.reason}).`,
      notes: built.findings,
      closing: "Take the branch over by hand to keep this work.",
      endsRun: "failure",
    });
    await setTicketStatus({ installationName, issueId: snapshot.id, stateName: "Todo" });
    throw new JigsError(`delivery stopped: ${built.reason}`);
  }
  const { title, body } = await describePullRequest(delivery);
  const pr = await publishPullRequest(delivery, { commit: built.reviewedCommit, title, body });
  await setTicketStatus({ installationName, issueId: snapshot.id, stateName: "In Review" });
  const followed = await followPullRequestToOutcome(delivery, pr, {
    attemptsPerUpdate: 3,
    wake: builderWakeFacts,
    mergeWhen: () => false,
    approvalCovers: "latest-commit",
    onNeedsHuman: (facts) =>
      noteOnTicket(claim, {
        headline: `${pr.url} needs a person (${facts.reason}).`,
        notes: [facts.detail],
        closing: "jigs keeps watching the pull request.",
      }),
  });
  if (followed.outcome === "closed") throw new JigsError(`${pr.url} was closed unmerged`);
  await setTicketStatus({ installationName, issueId: snapshot.id, stateName: "Done" });
  await noteOnTicket(claim, {
    headline: `Merged ${pr.url}.`,
    notes: [],
    closing: "",
    endsRun: "success",
  });
  return { pr: pr.url };
}
```

- **`buildAndReview`** runs the builder, then the reviewer on what it
  committed, until the reviewer raises no blocking finding. It ends `approved`
  with the approved commit and the approving round's non-blocking findings,
  which the workflow appends to the pull request body. When the rounds run out,
  or the builder leaves uncommitted work or commits nothing, it ends `stopped`
  with the reason, the open findings and the round it stopped in. It pushes
  nothing; the workflow pushes the branch with the `pushBranch` step before it
  writes its ticket note, and says so when the push fails.
- **`describePullRequest`** has the builder write the title and body. A title
  that is not one plain line, or a body with a "Title:" or "Description:" label
  line, is sent back once with the reasons; a second bad answer fails the run.
  `check` adds your own rules the same way; the workflow passes one that requires
  a conventional commit title.
- **`publishPullRequest`** pushes exactly the given commit and opens the pull
  request with the title and body it is given, so a failed description pushes
  nothing. No agent runs, and it needs no review: any clean HEAD commit can be
  published.
- **`followPullRequestToOutcome`** watches the pull request. The workflow
  passes `builderWakeFacts` as `wake`, so the builder wakes only for a fact it
  has not seen: a new or edited review or comment, a newly failed check on the
  current head, or a conflict with the base. Checks that queue, run or pass, a
  bare approval, and edits of a bot's comment wake nothing. Neither do the
  builder's own replies: comments by the App's bot (`appBot` on the snapshot)
  with no jigs marker. A person's comment wakes it, even one posted while the
  builder was working, and so do reviews and other jigs workflows' notes. To
  ignore more, such as another bot's comments, wrap `builderWakeFacts` in your
  own function. The maintenance prompt lists the facts that are new since the
  builder's last turn. Each wake gets its own attempt allowance. The builder
  reports whether it needs a person, with a summary; unfinished local or
  unpublished work is recovered immediately. Needing a person calls
  `onNeedsHuman` with facts, never the same facts twice in a row, and keeps
  watching. To move the ticket back to `Todo` as well, do it inside
  `onNeedsHuman`.
  With `mergedBy: "jigs"`, the default, the recipe checks merge readiness after
  every watcher yield and every builder turn, whatever the builder last
  reported: the configured GitHub approval (read with `approvalCovers`), green
  CI, a clean merge state, no unseen wake facts, and published local work. A
  transient merge refusal is retried after a durable wait, up to ten tries. When
  GitHub reports an approved, green pull request as `blocked`, `onNeedsHuman`
  receives `merge-blocked` with the head; the recipe posts a note on the pull
  request, marked with the delivery's scope so it does not wake the builder and
  a later run does not post it again. With `"human"` it waits for you to merge.
  The watcher never merges, and the agent is instructed not to merge or approve;
  see [GitHub access for agents](https://salimhamed.github.io/jigs/guide/models-and-harnesses#github-access)
  for what actually holds a merge back.
  It ends `merged` once the pull request merges, or `closed` when it is
  closed without merging; local work is never pushed on the way out.

The routines word nothing a person reads. Stops are return values, and
needs-human, a blocked merge included, is a callback with facts; the workflow writes
every note and decides where it goes. Facts never contain the local worktree
path.

## Edit the prompts

Every prompt is a plain function in `prompts.ts`. To change what an agent is
told, edit the function. jigs adds one line to each prompt, asking for the
answer in the shape it reads back, such as whether the builder needs a person.

Each turn has two forms, because an agent session resumes the harness session
it holds when it can and starts fresh when it cannot. `resume` is sent to an
agent that already holds the earlier turns, so it says only what is new.
`fresh` is sent to an agent starting from nothing, so it says everything.
For example, replace the `maintain` entry in `prompts.ts` with this shorter
prompt. Its facts come from `followPullRequestToOutcome`: the ticket and
worktree, the current diff, the pull request, the GitHub snapshot, the wake
facts that are new since the builder's last turn, and any unpublished local
work to recover first.

```ts
import type { DeliveryPrompts } from "@jigs-ai/jigs";
import type { Ticket } from "./prompts.ts";

export const maintain: DeliveryPrompts<Ticket>["maintain"] = {
  resume: ({ pr, snapshot, news, recovery }) =>
    [
      `Attend ${pr.owner}/${pr.repo}#${pr.number}. Read these facts:\n${JSON.stringify(snapshot)}`,
      news.length === 0 ? "" : `New since your last turn: ${news.join(", ")}`,
      recovery === undefined ? "" : `Publish your local work first: ${JSON.stringify(recovery)}`,
      "Address needed changes, run checks, commit and push. Do not merge or approve.",
    ].join("\n\n"),
  fresh: ({ work, diff, ...facts }) =>
    [work.instructions, `Current diff:\n${diff}`, maintain.resume(facts)].join("\n\n"),
};
```

`Ticket` in `prompts.ts` is the statement of the work every prompt reads. Add a
field to it, fill it in `ticket` at the bottom of the workflow file, and use it
in a prompt.
