# Build a workflow

This page builds one workflow from start to finish: `triage` takes a bug report,
has an agent investigate it in a repository, and asks a model to turn the
findings into a structured verdict. It assumes a running factory from
[Install and run a workflow](/guide/getting-started).

## 1. Connect a repository

The agent needs a repository to work in. Binding one needs GitHub credentials,
so set them first: see [GitHub identity](/guide/configuration#github-identity).
Then bind the repository and bring the factory up so the service clones it:

```sh
pnpm exec jigs bind git@github.com:owner/app.git
pnpm exec jigs up
```

The binding's name comes from the repository name, here `app`. A workflow that
needs no repository can skip this and use `createRunDirectory()` from
`#jigs/steps` for a scratch directory instead, as `hello` does.

## 2. Define the workflow

Create `workflows/triage/triage.ts`:

```ts
// workflows/triage/triage.ts
import { defineWorkflow, harnesses, JigsError, models, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { askModel, runAgent } from "#jigs/routines";
import { provisionWorktree } from "#jigs/steps";

const inputs = z.object({
  binding: z.string().default("app"),
  report: z.string().min(1),
});

const agents = { investigator: harnesses.claude({ model: "sonnet" }) };
const summarizer = models.openrouter("google/gemini-2.5-flash-lite");

const verdict = z.object({
  reproducible: z.boolean(),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string(),
});

export async function triage(input: WorkflowInputs<typeof inputs>) {
  "use workflow";

  const worktree = await provisionWorktree({
    binding: input.binding,
    branch: `triage/${input.triggerId}`,
  });

  const investigation = await runAgent({
    harness: agents.investigator,
    cwd: worktree.path,
    prompt: `Investigate this bug report. Try to reproduce it and find the cause. Do not change files.\n\n${input.report}`,
  });

  const result = await askModel({
    model: summarizer,
    prompt: `Turn these findings into a triage verdict:\n\n${investigation.text}`,
    output: verdict,
  });

  if (!result.output.reproducible) {
    throw new JigsError(
      "the agent could not reproduce the report",
      "add steps to reproduce to the report and run triage again",
    );
  }
  return result.output;
}

export default defineWorkflow({
  inputs,
  requires: { agents, bindings: ["app"], models: [summarizer] },
  workflow: triage,
});
```

### Inputs

The Zod schema validates CLI inputs before a run starts. jigs adds `triggerId`,
a unique run identifier used here to name the branch. `defineWorkflow` connects
the schema, function and requirements, and checks their types together.

### Agents and models

The investigator is a named, harness-backed agent that works in the repository
worktree. The summarizer makes a direct model call with no tools. Its `output`
schema checks the answer's shape, not whether it is right. Before running,
log in to Claude Code and set `OPENROUTER_API_KEY` in the factory's `.env`; see
[Models and harnesses](/guide/models-and-harnesses). To give an agent
reference material, such as how to query your warehouse, declare
[skills](/guide/models-and-harnesses#skills) on its harness.

### Workflow orchestration

`"use workflow"` marks durable orchestration in the Vercel Workflow SDK. The
workflow decides what happens, while the routines and steps it calls perform
the work. `provisionWorktree` prepares a working copy for this run on a branch of
its own: the `branch` you pass plus a short suffix from the run ID, cut fresh from
the default branch. Push and open pull requests from `worktree.branch`. Its
recorded result gives a resumed workflow the same directory information.

### Requirements and preflight

`requires` declares what must be available for the run. jigs checks those
dependencies before starting, so missing tools, credentials or repositories
produce a useful repair before expensive work begins.

### Secrets {#secrets}

A credential the workflow's steps use, such as a warehouse token, goes in the
factory's `.env` and is named in `requires.secrets`:

```ts
// workflows/sync/sync.ts
import { defineWorkflow, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";

const inputs = z.object({});

async function countOrders(): Promise<number> {
  "use step";
  const res = await fetch("https://warehouse.example.com/orders/count", {
    headers: { Authorization: `Bearer ${process.env.SNOWFLAKE_TOKEN}` },
  });
  return ((await res.json()) as { count: number }).count;
}

export async function sync(_input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  return countOrders();
}

export default defineWorkflow({
  inputs,
  requires: { secrets: ["SNOWFLAKE_TOKEN"] },
  workflow: sync,
});
```

List names only, never values. Add each name to `.env.example` with an empty
value (`SNOWFLAKE_TOKEN=`), then set it in `.env`. Preflight fails a run whose
secret is unset or empty, and `jigs doctor` names every workflow that needs it.
The variables an agent's MCP servers name are checked the same way without
being listed. A value exported in the shell that started the service but
missing from `.env` still works, and doctor notes that it is not set in `.env`
so you can move it there before another machine runs without it.
Listing a secret does not pass it to agents; use
[`agents.env`](/guide/configuration#agents-env) for that.

### Errors

Throw `JigsError` when the run should stop with an actionable explanation for
the person inspecting it.

## 3. Register the workflow

Inside the existing `defineFactory({ ... })` object in `jigs.config.ts`, add
`triage` to the `workflows` map. A factory with only the starter `hello` workflow
will look like this; keep any other workflows you have registered:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
workflows: {
  hello: () => import("./workflows/hello/hello.ts"),
  triage: () => import("./workflows/triage/triage.ts"),
},
```

The map key, `triage`, is the name passed to `jigs run`. The deferred import
lets configuration commands run without loading workflow code.

## 4. Run it

```sh
pnpm exec jigs up
pnpm exec jigs run triage --input report="Saving a draft twice loses the title."
pnpm exec jigs watch
```

`jigs up` rebuilds and restarts the service when needed. `run` starts the workflow
and returns immediately with its run identity. The service runs it independently
of the CLI process. `watch` follows progress, and `jigs status <run>` shows the
result later. On success the worktree is released automatically; configure
[`release`](/guide/configuration#release) to keep it instead.

## Build a pull request workflow

Four routines from `#jigs/routines` take a change from an agent's first commit
to a merged pull request. Your workflow calls them in order and decides
everything in between:

- `buildAndReview(delivery, { rounds })` has the builder implement and commit,
  then the reviewer review the commit, until the reviewer raises no blocking
  finding. It returns the reviewed commit, or `{ stopped }` with the reason
  (`rounds-exhausted`, `uncommitted` or `no-commits`), the open findings and
  the round it stopped in. A builder that leaves uncommitted changes is sent
  back once to commit or delete them before the round stops as `uncommitted`.
  After each review the worktree is reset to the reviewed commit and its
  untracked files removed, so files the reviewer's checks leave behind never
  reach the pull request; ignored files are kept. A stop pushes nothing: push
  the branch with the `pushBranch` step if whoever takes over should find the
  work on the remote.
- `describePullRequest(delivery, { commit, check })` has the writer write the
  pull request's title and body from the diff, then resets the worktree to
  `commit` the same way. The optional `check` returns the problems with an
  answer, such as a title that breaks your convention; the writer is sent back
  once with them, and a second answer with problems throws. Nothing is pushed.
- `publishPullRequest(delivery, { commit, title, body, draft })` pushes exactly
  `commit` and opens the pull request with the title and body you pass. No
  agent runs, and it needs no review: any clean commit at the worktree's HEAD
  can be published. Describe first, so a failed description pushes nothing.
- `followPullRequestToOutcome(delivery, pr, options)` wakes the builder for
  what it has to act on until the pull request merges or closes, and merges it
  when you consent. It returns `"merged"` or `"closed"`.

The routines write nothing a person reads. A stop is a return value. A pull
request that needs a person, including one GitHub blocks from merging, reaches
your workflow through `onNeedsHuman`, never with the same facts twice in a row.
You word the note and choose where it goes.

`followPullRequestToOutcome` takes these options, all required:

| Option | What it decides |
| --- | --- |
| `attemptsPerUpdate` | Builder turns for each change to the pull request, recovery included. |
| `wake` | Which facts in a snapshot wake the builder. Pass `builderWakeFacts` for the default: new reviews with a body or requesting changes, new comments, a newly failing check and a conflict with the base. Wrap it to ignore something, such as a bot's comments. |
| `mergeWhen` | Whether you consent to merging the current snapshot. Return `false` to leave every merge to a person, or check the snapshot, such as for a label. jigs still merges only an approved, green, clean pull request, so this can only make merging stricter. |
| `approvalCovers` | Which commits a person's approving review covers. |
| `onNeedsHuman` | Called with the facts when a person must act. For a blocked merge, `headSha` names the head; mark a note about it with that head and `defaultPullRequestScope(key)` so it does not wake the builder. |

While following, the builder's local work counts as published when the worktree
is clean and its HEAD is a commit the pull request has had; a worktree behind
the pull request, because a person pushed, is fine. Unpublished work sends the
builder a recovery prompt at once, without waiting for GitHub, and holds back
any merge. After a turn whose push GitHub does not show yet, the pull request is
read twice more, two seconds apart, without spending an attempt. A transient
merge refusal is retried up to ten times, 30 seconds apart.

### The prompts

A delivery sends the prompts you write, typed by `DeliveryPrompts<W>`. `W` is
your own description of the work; only your prompts read it. jigs adds one line
to each prompt, asking for the answer in the shape it reads back, and nothing
else, so upgrading jigs never changes what your agents are told.

| Prompt | Sent when | Its facts |
| --- | --- | --- |
| `build` | Each round, to the builder | `fresh`: work, worktree, open findings, diff. `resume`: the findings. |
| `review` | Each round, to the reviewer | `fresh`: work, worktree, head commit, diff, earlier rounds. `resume`: head commit, diff, the builder's answers. |
| `describe` | By `describePullRequest`, to the writer | Work, worktree, diff. |
| `maintain` | Each pull request change that needs the builder | `fresh`: work, worktree, diff, plus the `resume` facts. `resume`: the pull request, its GitHub snapshot, `news` (the wake facts the builder has not been shown, empty when it only recovers), and any unpublished local work to recover. |

`resume` goes to an agent session that holds the earlier turns, so it says only
what is new; `fresh` goes to one starting from nothing, so it says everything.

```ts
// workflows/bump/prompts.ts
import type { DeliveryPrompts, ReviewFinding } from "@jigs-ai/jigs";

export interface Bump {
  dependency: string;
  version: string;
}

const task = ({ dependency, version }: Bump) =>
  `Upgrade ${dependency} to ${version} and fix whatever breaks.`;
const list = (findings: ReviewFinding[]) =>
  findings.map((finding) => `- ${finding.summary}`).join("\n");

export const prompts: DeliveryPrompts<Bump> = {
  build: {
    fresh: ({ work, findings, diff }) =>
      `${task(work)}\n\nCurrent diff:\n${diff}\n\nOpen findings:\n${list(findings)}\n\nCommit when the tests pass.`,
    resume: ({ findings }) => `Address these findings, then commit:\n${list(findings)}`,
  },
  review: {
    fresh: ({ work, headSha, diff }) =>
      `${task(work)}\n\nReview commit ${headSha}. A finding is blocking only when it breaks something.\n\n${diff}`,
    resume: ({ headSha, diff }) => `Review commit ${headSha} again.\n\n${diff}`,
  },
  describe: ({ work, diff }) => `Describe this upgrade of ${work.dependency} for a reviewer.\n\n${diff}`,
  maintain: {
    fresh: ({ work, diff, ...facts }) =>
      `${task(work)}\n\nCurrent diff:\n${diff}\n\n${prompts.maintain.resume(facts)}`,
    resume: ({ pr, snapshot, news, recovery }) =>
      [
        `Pull request ${pr.owner}/${pr.repo}#${pr.number} changed:\n${JSON.stringify(snapshot)}`,
        news.length === 0 ? "" : `New since your last turn:\n${news.join("\n")}`,
        recovery === undefined ? "" : `Publish your local work first: ${JSON.stringify(recovery)}`,
        "Answer feedback, fix failing checks, commit and push. Do not merge or approve.",
      ].join("\n\n"),
  },
};
```

### The workflow

A delivery is a plain object you pass to every routine: the work, a `key`, the
worktree, the prompts, and the agent sessions. Create separate session objects
for each delivery: a session holds its agent's conversation, and its name only
labels log lines. Give each pull request its own `key`: it scopes the hidden
markers on the notes posted on that pull request. A `writer` session describes
the pull request; without one, the builder does. Each routine reads only the
fields it needs, so one delivery object serves all four.

This workflow upgrades a dependency in every repository it is given, one
delivery per repository, each merged before the next starts:

```ts
// workflows/bump/bump.ts
import {
  builderWakeFacts,
  defineWorkflow,
  harnesses,
  JigsError,
  type WorkflowInputs,
} from "@jigs-ai/jigs";
import { z } from "zod";
import {
  agentSession,
  buildAndReview,
  describePullRequest,
  followPullRequestToOutcome,
  publishPullRequest,
} from "#jigs/routines";
import { postSlackMessage, provisionWorktree } from "#jigs/steps";
import { prompts } from "./prompts.ts";

const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol", github: true }),
  reviewer: harnesses.claude({ model: "opus" }),
};

const inputs = z.object({
  dependency: z.string().min(1),
  version: z.string().min(1),
  bindings: z.array(z.string()).min(1),
});

export async function bump(input: WorkflowInputs<typeof inputs>) {
  "use workflow";

  const merged: string[] = [];
  for (const binding of input.bindings) {
    const worktree = await provisionWorktree({ binding, branch: `bump/${input.dependency}` });
    const cwd = worktree.path;
    const delivery = {
      work: { dependency: input.dependency, version: input.version },
      key: `${binding}-${input.dependency}`,
      worktree,
      prompts,
      builder: agentSession({ name: `${binding} builder`, harness: agents.builder, cwd }),
      reviewer: agentSession({ name: `${binding} reviewer`, harness: agents.reviewer, cwd }),
    };

    const built = await buildAndReview(delivery, { rounds: 2 });
    if ("stopped" in built) {
      throw new JigsError(
        `${binding}: the upgrade stopped (${built.stopped.reason})`,
        built.stopped.findings.join("\n"),
      );
    }
    const { title, body } = await describePullRequest(delivery, {
      commit: built.reviewedCommit,
      check: (described) =>
        described.title.startsWith("chore(deps): ")
          ? []
          : ['Start the title with "chore(deps): ".'],
    });
    const pr = await publishPullRequest(delivery, { commit: built.reviewedCommit, title, body });
    const outcome = await followPullRequestToOutcome(delivery, pr, {
      attemptsPerUpdate: 2,
      wake: builderWakeFacts,
      mergeWhen: () => true,
      approvalCovers: "latest-commit",
      onNeedsHuman: async ({ reason, detail }) => {
        await postSlackMessage({
          channel: "#upgrades",
          text: `${pr.url} needs a person (${reason}): ${detail}`,
        });
      },
    });
    if (outcome === "closed") throw new JigsError(`${pr.url} was closed without merging`);
    merged.push(pr.url);
  }
  return { merged };
}

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["github", "slack"] },
  workflow: bump,
});
```

To deliver to every repository at once instead, map the bindings to the same
steps and `await Promise.all(...)`; each repository already gets its own key and
sessions. A delivery's next step can also depend on an earlier one's result,
such as opening a pull request in a client only after the library merged. Each
agent step acts in one GitHub owner, so give each repository its own delivery.

The `linear-ticket-to-pr` [recipe](/guide/recipes) is a complete example: it
claims a Linear ticket, moves its status between the phases, and writes its own
ticket notes for stops and for a pull request that needs a person.

### Upgrading with runs parked

A run parked in `followPullRequestToOutcome` replays the routines' steps when
it wakes. A jigs release that changes those steps is a breaking release, and
its notes say so: let parked runs finish, or cancel them, before upgrading.
`jigs up` lists parked and active runs before it restarts the service.
