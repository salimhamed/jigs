# The linear-ticket-to-pr recipe

`linear-ticket-to-pr` takes a Linear ticket to a merged pull request. It claims the ticket,
asks on it when the requirements are unclear, has one agent implement the
change and another review it, opens the pull request, and follows its review
comments and CI until it merges. These files are now your factory's code: edit
them freely. Upgrading jigs never overwrites them.

- `workflows/linear-ticket-to-pr.ts` is the workflow: its inputs, harness defaults and the
  ticket status it sets at each stage.
- `workflows/linear-ticket-to-pr/tickets/linear.ts` resolves and claims the ticket.
- `workflows/linear-ticket-to-pr/delivery/` holds the phases (`delivery.ts`), prompts, types and tests.
- `doc-examples.types.test.ts` compiles every example on this page. Change one
  and change the other.

## What it needs

- **Linear and GitHub credentials.** See
  [GitHub identity](https://salimhamed.github.io/jigs/guide/configuration#github-identity)
  and [Linear identity](https://salimhamed.github.io/jigs/guide/configuration#linear-identity).
- **Linear states named `Todo`, `In Progress`, `In Review` and `Done`** on the
  ticket's team. The workflow moves the ticket through them and fails on a
  missing one.
- **Claude Code and Codex**, installed and logged in. The workflow names
  both in `requires.agents`.
- **A binding** for the repository to change: `pnpm exec jigs bind <remote>`, then
  `pnpm exec jigs up`. See [bindings](https://salimhamed.github.io/jigs/guide/configuration#bindings).
- **A merge policy** you have decided on. See
  [merge](https://salimhamed.github.io/jigs/guide/configuration#merge). jigs never
  merges in a repository with no CI.

[Webhooks](https://salimhamed.github.io/jigs/guide/configuration#webhooks) are
optional.

## Launch a run

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input binding=app
pnpm exec jigs watch
```

By default Codex implements and Claude Code reviews. Choose per run with
`implementationHarness` and `reviewHarness` (`claude` or `codex`), and
`implementationModel` and `reviewModel`. A model left unset takes that
harness's default from `inputHarnesses` in `workflows/linear-ticket-to-pr.ts`. Pi needs a model
source rather than a model name, so build a Pi role in `workflows/linear-ticket-to-pr.ts` with
`harnesses.pi(...)` and add it to `agents`, which the workflow passes as `requires.agents`.

## Budgets

| Budget | One unit buys | Input default |
| --- | --- | --- |
| `implementationReviewRounds` | One implementation attempt plus one review of it | 3 |
| `ciFixAttempts` | One repair attempt against a failing CI run | 3 |
| `pullRequestRevisionRounds` | One batch of review feedback answered | 3 |

Each budget is spent only by its own phase and counts for the whole delivery.
Duplicate notifications spend nothing. When a budget runs out, or the pull
request closes unmerged, the delivery pushes the branch, posts a note through
`postNote` and fails the run. A delivery returns only after a merge.

## Merge

`merge` comes from `resolveMergePolicy(binding)`: the factory's policy with the
binding's overrides. With `by: "human"` the run keeps answering feedback until
you merge. With `by: "jigs"` it merges once the approval signal is present,
GitHub reports the pull request mergeable and CI has passed.

## Choose agents and budgets

`deliverChange` runs the whole process:

```ts
import { harnesses } from "@jigs-ai/jigs";
import { deliverChange } from "./linear-ticket-to-pr/delivery/delivery.ts";
import { noteOnTicket } from "#jigs/routines";
import { resolveMergePolicy } from "#jigs/steps";

const result = await deliverChange({
  task,
  worktree,
  binding: "application",
  implementation: { harness: harnesses.codex("gpt-5.6-sol") },
  review: { harness: harnesses.claude("opus") },
  limits: {
    implementationReviewRounds: 5,
    ciFixAttempts: 3,
    pullRequestRevisionRounds: 4,
  },
  merge: await resolveMergePolicy("application"),
  postNote: (note) => noteOnTicket(claim, note),
});
```

Posting notes through `noteOnTicket` records them on the claim, so a later
`haltForHuman` never mistakes them for a human reply.

`ciRepair`, `pullRequestRevision` and `pullRequestDescription` use the
implementation harness unless you set them. Each role keeps its own session;
changing a role's harness or model starts it fresh.

```ts
import { harnesses, models } from "@jigs-ai/jigs";
import { deliverChange } from "./linear-ticket-to-pr/delivery/delivery.ts";
import { noteOnTicket } from "#jigs/routines";
import { resolveMergePolicy } from "#jigs/steps";

const result = await deliverChange({
  task,
  worktree,
  binding: "application",
  implementation: { harness: harnesses.codex("gpt-5.6-sol") },
  review: { harness: harnesses.claude("opus") },
  ciRepair: { harness: harnesses.pi(models.openaiCodex("gpt-5.5"), { thinking: "high" }) },
  pullRequestRevision: { harness: harnesses.claude("sonnet") },
  pullRequestDescription: {
    harness: harnesses.claude("haiku"),
    transform: (description) => ({ ...description, title: `[factory] ${description.title}` }),
  },
  limits: {
    implementationReviewRounds: 5,
    ciFixAttempts: 3,
    pullRequestRevisionRounds: 4,
  },
  merge: await resolveMergePolicy("application"),
  postNote: (note) => noteOnTicket(claim, note),
});
```

## Ask a person when a budget runs out

`onLimit` is called when a phase has spent its budget. Return
`{ action: "continue", instructions, additionalAttempts }` to add attempts to
that phase, or `{ action: "stop" }` to end it. It runs inside the workflow, so it
can wait for a person, for example by asking on the ticket:

```ts
import type { LimitReached } from "./linear-ticket-to-pr/delivery/types.ts";
import type { TicketClaim } from "@jigs-ai/jigs";
import { haltForHuman } from "#jigs/routines";

declare const claim: TicketClaim;

const onLimit = async (limit: LimitReached) => {
  const reply = await haltForHuman(claim, {
    headline: `Delivery for ${limit.task.key} has spent its ${limit.phase} budget.`,
    where: "delivery",
    about: limit.task.title,
    notes: [`${limit.attempts} attempt(s) so far.`, ...limit.findings],
    questions: [
      {
        question: "Keep going, or stop here?",
        options: [{ label: "Keep going", recommended: true }, { label: "Stop" }],
      },
    ],
    onReply: "continue",
  });
  if (/^\s*stop\b/i.test(reply.body)) return { action: "stop" as const };
  return { action: "continue" as const, instructions: reply.body, additionalAttempts: 2 };
};
```

## Change the prompts

Each role takes a `prompt` function that receives a context for that role.
`context.renderDefaultPrompt()` renders what the recipe would send, so you can
extend it:

```ts
import { harnesses } from "@jigs-ai/jigs";
import type { ReviewPromptContext } from "./linear-ticket-to-pr/delivery/types.ts";

const review = {
  harness: harnesses.claude("opus"),
  prompt: async (context: ReviewPromptContext) =>
    `${await context.renderDefaultPrompt()}

Also check authorization and migration compatibility.`,
};
```

Or replace it outright:

```ts
import { harnesses } from "@jigs-ai/jigs";
import type { ImplementationPromptContext } from "./linear-ticket-to-pr/delivery/types.ts";

const implementation = {
  harness: harnesses.codex("gpt-5.6-sol"),
  prompt: (context: ImplementationPromptContext) => `
Round ${context.attempt} on ${context.task.key}: ${context.task.title}

${context.task.instructions}

${context.findings.length > 0 ? `Fix these findings:\n${context.findings.map((f) => f.summary).join("\n")}` : "This is the first round."}
${context.instructions}

Work in ${context.worktree.path}, branched from ${context.worktree.baseSha}.
Run the repository's checks and commit before you finish: only committed work is
reviewed. Do not push and do not open a pull request.
`,
};
```

The contexts are `ImplementationPromptContext`, `ReviewPromptContext`,
`CiRepairPromptContext`, `PullRequestRevisionPromptContext` and
`DescriptionPromptContext` in `types.ts`. The default renderers are exported from
`prompts.ts`.

## Deliver your own work items

A task needs only `id`, `key`, `title`, `instructions` and an optional `url`.
Extra fields reach every prompt, `onLimit` and the result, with no cast. Keep
task values plain data.

```ts
import { harnesses } from "@jigs-ai/jigs";
import type { WorkItem } from "./linear-ticket-to-pr/delivery/types.ts";
import { deliverChange } from "./linear-ticket-to-pr/delivery/delivery.ts";
import { resolveMergePolicy } from "#jigs/steps";

interface Incident extends WorkItem {
  service: string;
  acceptance: string[];
}

declare const incident: Incident;

const result = await deliverChange({
  task: incident,
  worktree,
  binding: "application",
  implementation: {
    harness: harnesses.codex("gpt-5.6-sol"),
    prompt: async (context) =>
      [
        await context.renderDefaultPrompt(),
        `Affected service: ${context.task.service}`,
        `Acceptance criteria:\n${context.task.acceptance.join("\n")}`,
      ].join("\n\n"),
  },
  review: { harness: harnesses.claude("opus") },
  limits: {
    implementationReviewRounds: 5,
    ciFixAttempts: 3,
    pullRequestRevisionRounds: 4,
  },
  merge: await resolveMergePolicy("application"),
  postNote: (note) => postIncidentNote(incident, note),
  onLimit: async (limit) => ({
    action: "continue",
    instructions: `The on-call owner of ${limit.task.service} asked for one more pass.`,
    additionalAttempts: 1,
  }),
});

await notifyOncall(result.change.task.service, result.pr);
```

## Compose the phases

Call the phases yourself to put your own checks between them. Publication
accepts only an `ApprovedChange`, so unreviewed work cannot reach it:

```ts
import { followPullRequest, implementAndReview, publishApprovedChange } from "./linear-ticket-to-pr/delivery/delivery.ts";

const built = await implementAndReview({
  task,
  worktree,
  implementation,
  review,
  limits: { implementationReviewRounds: 5 },
  postNote,
});
await checkSecurity(built.change);

const pr = await publishApprovedChange({
  change: built.change,
  binding: "application",
  implementation,
});

return followPullRequest({
  change: built.change,
  pr,
  implementation,
  limits: { ciFixAttempts: 3, pullRequestRevisionRounds: 4 },
  merge: await resolveMergePolicy("application"),
  postNote,
});
```

For anything else, edit `delivery.ts` directly.
