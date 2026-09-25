# Build a workflow

This page builds one workflow from start to finish: `triage` takes a bug report,
has an agent investigate it in a repository, and asks a model to turn the
findings into a structured verdict. It assumes a running factory from
[Install and run a first workflow](/guide/getting-started).

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

## 2. Write the workflow

Create `workflows/triage/triage.ts`:

```ts
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

What each part does:

- **`inputs`** is a zod schema. `jigs run` checks `--input` values against
  it before a run is created. jigs also adds `triggerId`, an ID unique to the
  run, which here gives each run its own branch.
- **`"use workflow"`** marks the function as a durable workflow. Its body must
  be safe to replay, so all real work happens in the steps it calls.
- **`agents`** names each agent the workflow runs, by the part it plays. A
  harness descriptor is plain data, so it can be passed to a step.
- **`provisionWorktree`** cuts a worktree for this run from the binding's clone,
  on the branch you name. A resumed run gets the same worktree back.
- **`runAgent`** runs an agent, here Claude Code, in that directory with its
  tools. `result.text` is its final answer. Pass `output` a zod schema to get a
  parsed `result.output` instead.
- **`askModel`** calls a model API directly, with no tools and no directory. It
  suits summarizing and classifying text you already have. The `output` schema
  checks the answer's shape, not whether it is right.
- **`JigsError`** ends the run as failed, with a hint for whoever reads it.
  Returning a value always means success.
- **`defineWorkflow`** ties the function, its inputs and its requirements
  together, and makes TypeScript check the function's parameter against the
  schema. It is the file's default export.
- **`requires`** lists what the workflow needs: its agents, the binding and the
  model source. jigs derives the harness CLIs to check from the agents.
  Preflight checks each one before every run and refuses to start with a repair
  when one is missing. `jigs doctor` runs the same checks.

This model source reads `OPENROUTER_API_KEY` from the factory's `.env`. See
[Models and harnesses](/guide/models-and-harnesses) for the other harnesses and
sources and what each one needs.

The triage agent changes no files. An agent asked to change code may still stop
with nothing committed, or leave changes uncommitted. When the next step needs a
clean, committed change, such as pushing a branch or opening a pull request,
check first with `committedWork` from `#jigs/routines`:

```ts
const { headSha } = await committedWork(worktree);
```

It returns the branch's head and commit count, or fails the run with a hint
when the worktree has uncommitted changes or no commit since its base. Pass
`{ since: sha }` to require a commit newer than `sha` instead.

## 3. Register it

Add the workflow to the `workflows` map in `jigs.config.ts`:

```ts
workflows: {
  hello: () => import("./workflows/hello/hello.ts"),
  triage: () => import("./workflows/triage/triage.ts"),
},
```

The import stays deferred, so commands that only read configuration never load
workflow code.

## 4. Run it

```sh
pnpm exec jigs up
pnpm exec jigs run triage --input report="Saving a draft twice loses the title."
pnpm exec jigs watch
```

`jigs up` rebuilds the factory and restarts the service because the workflow
changed. `watch` follows the run step by step; `jigs status <run-id>` shows the
result when it finishes. On success the worktree is released automatically.
See [`release`](/guide/configuration#release) to keep it instead.

## Ask a person and wait

`haltForHuman` posts a question on a Linear ticket and suspends the run until
someone replies there. It needs Linear credentials (see
[Linear identity](/guide/configuration#linear-identity)) and a claimed ticket.
Claiming also makes sure only one run works on a ticket at a time:

```ts
import { claimTicket, haltForHuman } from "#jigs/routines";
import { resolveLinearIssue } from "#jigs/steps";

const issue = await resolveLinearIssue(input.ticket);
const claim = await claimTicket(issue.id, issue.identifier);

const reply = await haltForHuman(claim, {
  headline: "Triage needs a decision before it continues.",
  where: "triage",
  questions: [
    {
      question: "Should the fix include archived drafts?",
      options: [{ label: "Active drafts only" }, { label: "Include archived drafts" }],
    },
  ],
  onReply: "continue",
});
// reply.body is the person's answer, as free text.
```

Add `ticket: z.string()` to `inputs` and `integrations: ["linear"]` to
`requires`.
`jigs status <run-id>` shows the question and the link to answer it. The run
notices a reply on its next [check](/guide/configuration#webhooks);
`jigs poke <run-id>` checks now.
Answer the existing run rather than starting another one.

## Wait on a pull request

`watchPullRequest` yields the current GitHub facts immediately, then yields
again when those facts change. The workflow decides what to do with them:
run an agent, apply rules, or keep waiting. The watcher makes no model calls
and does not decide whether a comment needs an answer.

This example continues a builder session created earlier in the workflow.
`pr` identifies the pull request by `owner`, `repo` and `number`:

```ts
import { watchPullRequest } from "#jigs/routines";

for await (const snapshot of watchPullRequest(pr)) {
  if (snapshot.state === "closed") return { merged: snapshot.merged };

  const situation = JSON.stringify(snapshot);
  await builder.run({
    resume: `Read this PR's discussion and checks. Address anything that needs
attention, or do nothing if it is already handled. You may respond on GitHub
and push fixes. Do not merge. Current facts: ${situation}`,
    fresh: `${task}

Continue work on PR #${pr.number} in ${pr.owner}/${pr.repo}.
Read the code and discussion, then respond or push fixes if needed. Do not merge.
Current facts: ${situation}`,
  });
}
```

The example's `task` and `builder` belong to the factory. It shows one agent
invocation per update; see the [recipe](/guide/recipes#linear-ticket-to-pr) for
checking the agent's work and retrying incomplete local changes within a
factory-owned limit. See [agent sessions](/guide/models-and-harnesses#agent-sessions)
for creating the builder and supplying recovery context in `fresh`.

`snapshot.state` and `snapshot.merged` come from GitHub. The snapshot also
includes `headSha`, draft and merge state, labels, reviews, inline review
threads and conversation comments. jigs summarizes GitHub checks and commit
statuses as `ci` (`"red"`, `"green"`, `"pending"`, or `"none"` when nothing has
reported on the head yet) and includes `failingChecks`. `approval` gives the
factory's approval signal and its `state` (`"approved"`, `"changes-requested"`,
`"stale"` or `"none"`).
These are observed facts, not an assessment that the work is finished.

To compare a fresh read with an earlier snapshot, import
`pullRequestSnapshotKey` from `@jigs-ai/jigs` and compare their keys. It uses the
same fact comparison as the watcher, ignoring collection ordering and incidental
fetch metadata.

Repeated notifications with unchanged facts produce no new snapshot. An
agent's own comments and pushes do change the facts and can produce another
turn. An agent invocation that decides nothing needs doing is normal. The
watcher has no hidden agent budget or conversation filter. The recipe bounds
recovery attempts for each update, rather than limiting the total number of
updates a PR can receive. Agents may post using their GitHub tools: no hidden
jigs marker is required, and an unmarked comment does not automatically mean
unresolved work.

The watcher yields a closed snapshot once, then ends. Leaving the loop by
`return`, `break` or a throw releases the watch. Only one run can watch a given
pull request at a time; a second owner receives a claim conflict. The service's
polling, webhooks and `jigs poke` wake the watch to reread GitHub.

The watcher never merges. Factory code decides who may merge and calls
`mergePullRequest` when appropriate; that step rechecks current GitHub facts
and the [merge approval](/guide/configuration#merging), and merges with the
binding's merge method. Each snapshot's `approval` already reads the factory's
approval setting, so `isPullRequestMergeReady(snapshot)` needs nothing else. The
[linear-ticket-to-pr recipe](/guide/recipes#linear-ticket-to-pr) demonstrates
continuing the builder session after publication and deciding who merges.

## Record what the workflow created

`jigs status <run-id>` lists a run's resources, such as its worktree. Record
anything else a person may need to find with `registerResource`:

```ts
import { registerResource } from "#jigs/steps";

await registerResource({
  kind: "s3-report",
  identity: "quarterly/2026-Q3",
  url: "https://reports.example.com/quarterly/2026-Q3",
});
```

The kind and identity together name the resource, so registering it again only
updates its URL. When the thing you created cannot safely be created twice,
create it in one step and register it in a separate call afterwards, so a retry
repeats only the registration. A record is for finding things; it never
permits jigs to delete them.

## Explore further

- [Library API](/api/jigs): harnesses, models, every option of `runAgent`,
  `askAgent`, `askModel` and `askJev`, and the data steps hand back.
- [Linear steps](/api/steps/linear): ticket notes, questions and snapshots.
- [Runtime steps](/api/steps/runtime): run directories, resources and release.
- [Workspace steps](/api/steps/workspaces): worktrees.
- [Git steps](/api/steps/git): reading a change and its patch.
- [Pull request steps](/api/steps/pull-requests): opening, reviewing and merging.
- [Models and harnesses](/guide/models-and-harnesses): what each harness and model source needs.
