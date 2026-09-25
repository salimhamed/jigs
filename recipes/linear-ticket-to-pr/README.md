# linear-ticket-to-pr

This workflow takes a Linear ticket to a merged pull request. It claims the
ticket, asks on it when the requirements are unclear, has one agent build the
change and another review it, opens the pull request, and follows its review
comments and CI until it merges.

These files are your factory's code now. Edit them freely: upgrading jigs never
overwrites them.

| File | What it holds |
| --- | --- |
| `linear-ticket-to-pr.ts` | The workflow: its agents, inputs, and the ticket status it sets between phases. |
| `delivery/delivery.ts` | The three phases and `DeliveryStopped`. |
| `delivery/prompts.ts` | Every prompt the agents are sent. |
| `delivery/review.ts` | What a review returns and how it is rendered. |
| `doc-examples.types.test.ts` | Compiles every example on this page. Change one and change the other. |

## What it needs

- **Linear and GitHub credentials.** See
  [GitHub identity](https://salimhamed.github.io/jigs/guide/configuration#github-identity)
  and [Linear identity](https://salimhamed.github.io/jigs/guide/configuration#linear-identity).
- **Linear states named `Todo`, `In Progress`, `In Review` and `Done`** on the
  ticket's team. The workflow moves the ticket through them and fails on a
  missing one.
- **Claude Code, Codex and Pi**, installed and logged in. The workflow names all
  three in `requires.agents`, so the service will not start and
  `jigs doctor` reports a problem until each one is on the `PATH`. Pi runs the
  fixer; to drop it, point `fixer` at a Claude Code or Codex harness.
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

A run picks its builder and reviewer by name. By default the `builder` agent
builds and the `reviewer` agent reviews. To have Claude Code build too:

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input binding=app --input builder=reviewer
```

A run cannot type a model name. To change a model, edit its line in `agents`.

## Budgets

| Budget | One unit buys | Default |
| --- | --- | --- |
| `reviewRounds` | One build plus one review of what it committed | 3 |
| `ciFixes` | One repair of a failing CI run | 3 |
| `revisionRounds` | One batch of review comments answered | 3 |

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input binding=app --input 'budget={"reviewRounds":5}'
```

Budgets are fixed when the run starts. When one runs out, a CI repair produces
no new clean commit, an agent leaves uncommitted changes, or the pull request
closes unmerged, the delivery pushes the branch, the workflow posts a note on
the ticket saying what is still open, moves the ticket back to `Todo`, and the
run fails. To spend more, start another run.

## The agents

The agents are a plain object, and the names a run may pick are a hand-written
enum beside it. TypeScript checks the two against each other where the workflow
reads `agents[input.builder]`.

```ts
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
  fixer: harnesses.pi(models.openaiCodex("gpt-5.5"), { thinking: "high" }),
  careful: harnesses.claude({ model: "opus", effort: "high" }),
};
const agentName = z.enum(["builder", "reviewer", "fixer", "careful"]);
```

Adding `careful` as above lets a run pass `--input builder=careful`. Every agent
in the object is checked before a run starts, whether or not a run picks it.

The `fixer` repairs CI and answers review comments after the pull request is
open, in one agent session, so it remembers its earlier fixes. The pull request
description is written by the builder.

## The three phases

The workflow calls three phases from `delivery/delivery.ts` in order and sets
the ticket status between them:

```ts
try {
  const approved = await implementAndReview(delivery);
  const pr = await publish(delivery, approved);
  await setTicketStatus(snapshot.id, "In Review");
  await followPullRequest(delivery, pr);
  await setTicketStatus(snapshot.id, "Done");
  return { pr: pr.url };
} catch (error) {
  if (error instanceof DeliveryStopped) {
    await noteOnTicket(claim, error.note());
    await setTicketStatus(snapshot.id, "Todo");
  }
  throw error;
}
```

- **`implementAndReview`** runs the builder, then the reviewer on what it
  committed, until the reviewer raises no blocking finding. Non-blocking
  findings go into the pull request description.
- **`publish`** pushes exactly the approved commit and opens the pull request.
- **`followPullRequest`** waits on the pull request. It spends a CI fix on a red
  build, a revision round on new review comments, and merges when the binding's
  merge policy says jigs merges. With `by: "human"` it waits for you to merge.

A phase that stops short pushes the branch and throws `DeliveryStopped`. Its
`note()` says what is still open and where the work is, and the workflow
decides where to post it. To add your own check between phases, add a line to
the workflow.

## Edit the prompts

Every prompt is a plain function in `delivery/prompts.ts`. To change what an
agent is told, edit the function.

Each turn has two forms, because an agent session resumes the harness session
it holds when it can and starts fresh when it cannot. `resume` is sent to an
agent that already holds the earlier turns, so it says only what is new.
`fresh` is sent to an agent starting from nothing, so it says everything:

```ts
export const ciRepair = {
  job: "Investigate the failing checks, fix their cause, run relevant checks, and commit the fix. Do not push.",
  resume: (failing: CheckRun[]) =>
    join([`Failing checks:\n${JSON.stringify(failing)}`, ciRepair.job]),
  fresh: (task: WorkItem, worktree: Worktree, diff: string, failing: CheckRun[]) =>
    join([taskBrief(task, worktree), `Current diff:\n${diff}`, ciRepair.resume(failing)]),
};
```

`WorkItem` in `delivery/delivery.ts` is the statement of the work every prompt
reads. Add a field to it, fill it in `workItem` at the bottom of the workflow
file, and use it in a prompt.
