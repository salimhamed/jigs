# linear-ticket-to-pr

This workflow takes a Linear ticket to a merged pull request. It claims the
ticket, asks on it when the requirements are unclear, has one agent build the
change and another review it, opens the pull request, and follows its review
comments and CI with the same builder session until it merges.

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
- **Claude Code and Codex**, installed and logged in. Both are declared in
  `requires.agents` and checked when the service starts.
- **Builder access to GitHub tools**, such as authenticated `gh` or a configured
  GitHub MCP server, with permission to read the PR, comment, and push its branch.
  Service GitHub credentials are not automatically agent credentials. If your
  tool uses an environment token, configure its name in `agents.env`; otherwise
  authenticate the tool separately. Missing access makes maintenance stop for help.
- **A binding** for the repository to change: `pnpm exec jigs bind <remote>`, then
  `pnpm exec jigs up`. See [bindings](https://salimhamed.github.io/jigs/guide/configuration#bindings).
- **Who merges.** `mergedBy` near the top of `linear-ticket-to-pr.ts` is
  `"human"`, so the run waits for you to merge. Set it to `"jigs"` to have jigs
  merge once the pull request is approved and CI is green. jigs never merges in
  a repository with no CI. How you approve, and the merge method, are set in
  [jigs.config.ts](https://salimhamed.github.io/jigs/guide/configuration#merging).

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
| `attemptsPerUpdate` | Builder attempts to handle each changed PR snapshot, including immediate recovery | 3 |

```sh
pnpm exec jigs run linear-ticket-to-pr --input ticket=AGE-123 --input binding=app --input 'budget={"reviewRounds":5}'
```

Budget settings belong to this recipe and are fixed when the run starts.
`attemptsPerUpdate` is positive and resets for every changed PR snapshot; it is
not a lifetime limit on PR activity. The initial builder turn counts as one attempt.

After each turn the recipe reads the local worktree and current published PR
head. A dirty worktree or mismatched head sends the builder a recovery prompt
immediately, without waiting for another GitHub notification. A clean head mismatch
first gets two short durable waits and fresh reads to allow GitHub to reflect a
successful push; these reads spend no builder attempts. The builder must safely
commit, publish, or synchronize the work, or explain why it needs human help.

Exhausted recovery attempts, a request for human help, refused or failed merge,
or unmerged closure stop maintenance. The workflow retains local work without
an automatic push, posts a ticket note explaining what remains, sets `Todo`, and
fails the run. To keep the work, take over the retained worktree, its branch and any
pull request by hand. Another run starts over on a new branch and opens a new pull
request. A stop during initial implementation still attempts to preserve
committed work by pushing; a failed preservation push is included in the note.

## The agents

The agents are a plain object, and the names a run may pick are a hand-written
enum beside it. TypeScript checks the two against each other where the workflow
reads `agents[input.builder]`.

```ts
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
judges the discussion and checks, then responds and pushes through its own
GitHub tools. No hidden comment markers are required. If its saved session is
unavailable, a fresh prompt supplies the ticket, current diff, and PR facts.

## The three phases

The workflow calls three phases from `delivery/delivery.ts` in order and sets
the ticket status between them:

```ts
const builder = agentSession({
  name: "builder",
  harness: delivery.builder,
  cwd: delivery.worktree.path,
});

try {
  const approved = await implementAndReview(delivery, builder);
  const pr = await publish(delivery, approved);
  await setTicketStatus(snapshot.id, "In Review");
  await followPullRequest(delivery, pr, builder);
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
- **`followPullRequest`** uses `watchPullRequest` to read the initial GitHub
  snapshot and changed facts. Each open snapshot gets its own attempt allowance. Its
  own comments can cause another turn; the agent should post nothing when no
  action is needed. Duplicate notifications with unchanged facts spend nothing.
  A snapshot already assessed during recovery is skipped if the watcher later
  delivers it; new facts still reach the builder.
  The builder returns `finished`, `pending`, or `needs-human` with a summary.
  `pending` waits only for an external change; unfinished local or unpublished
  work is recovered immediately instead. `needs-human` stops with the explanation.
  With `mergedBy: "human"` the recipe waits for you to merge. With `"jigs"` it
  requires `finished`, a clean matching local commit, unchanged GitHub facts,
  and the configured GitHub approval and green CI before calling the merge step.
  The watcher never merges, and the agent is instructed not to merge or approve.
  Those instructions are not a restriction on the agent's GitHub credentials.

A phase that stops short throws `DeliveryStopped`. Initial implementation attempts
to push committed work first; PR maintenance preserves local work without an
automatic push. Its `note()` says what is still open and where the work is, and
the workflow decides where to post it. To add your own check between phases,
add a line to the workflow.

## Edit the prompts

Every prompt is a plain function in `delivery/prompts.ts`. To change what an
agent is told, edit the function.

Each turn has two forms, because an agent session resumes the harness session
it holds when it can and starts fresh when it cannot. `resume` is sent to an
agent that already holds the earlier turns, so it says only what is new.
`fresh` is sent to an agent starting from nothing, so it says everything:

```ts
export const maintenance = {
  resume: (pr: PullRequestRef, snapshot: PullRequestSnapshot) =>
    `Attend ${pr.owner}/${pr.repo}#${pr.number}. Read these facts and decide whether anything needs attention:\n${JSON.stringify(snapshot)}`,
  fresh: (task: WorkItem, pr: PullRequestRef, snapshot: PullRequestSnapshot) =>
    `${task.instructions}\n\n${maintenance.resume(pr, snapshot)}`,
};
```

`WorkItem` in `delivery/delivery.ts` is the statement of the work every prompt
reads. Add a field to it, fill it in `workItem` at the bottom of the workflow
file, and use it in a prompt.
