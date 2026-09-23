# Build a workflow

This page builds one workflow from start to finish: `triage` takes a bug report,
has an agent investigate it in a repository, and asks a model to turn the
findings into a structured verdict. It assumes a running factory from
[Install and run a first workflow](/guide/getting-started).

## 1. Connect a repository

The agent needs a repository to work in. Bind one, then bring the factory up so
the service clones it:

```sh
pnpm exec jigs bind git@github.com:owner/app.git
pnpm exec jigs up
```

The binding's name comes from the repository name, here `app`. A workflow that
needs no repository can skip this and use `createRunDirectory()` for a scratch
directory instead, as `hello` does.

## 2. Write the workflow

Create `workflows/triage.ts`:

```ts
import { JigsError, type WorkflowEntry, type WorkflowInputs } from "@jigs-ai/jigs";
import { harnesses, models } from "@jigs-ai/jigs/blocks/agents";
import { z } from "zod";
import { askModel, provisionWorktree, runAgent } from "#jigs";

export const triageInputs = z.object({
  binding: z.string().default("app"),
  report: z.string().min(1),
});

const summarizer = models.openrouter("google/gemini-2.5-flash-lite");

const verdict = z.object({
  reproducible: z.boolean(),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string(),
});

export async function triageWorkflow(inputs: WorkflowInputs<typeof triageInputs>) {
  "use workflow";

  const worktree = await provisionWorktree({
    binding: inputs.binding,
    branch: `triage/${inputs.triggerId}`,
  });

  const investigation = await runAgent({
    harness: harnesses.claude("sonnet"),
    cwd: worktree.path,
    prompt: `Investigate this bug report. Try to reproduce it and find the cause. Do not change files.\n\n${inputs.report}`,
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

export default {
  workflow: triageWorkflow,
  inputs: triageInputs,
  requires: { bindings: ["app"], harnesses: ["claude"], models: [summarizer] },
} satisfies WorkflowEntry<typeof triageInputs>;
```

What each part does:

- **`triageInputs`** is a zod schema. `jigs run` checks `--input` values against
  it before a run is created. `triggerId` is added to every run's inputs.
- **`"use workflow"`** marks the function as a durable workflow. Its body must
  be safe to replay, so all real work happens in the steps it calls.
- **`provisionWorktree`** cuts a worktree for this run from the binding's clone,
  on the branch you name. A resumed run gets the same worktree back.
- **`runAgent`** runs a harness, here Claude Code, in that directory with its
  tools. `result.text` is its final answer. Pass `output` a zod schema to get a
  parsed `result.output` instead.
- **`askModel`** calls a model API directly, with no tools and no directory. It
  suits summarizing and classifying text you already have. The `output` schema
  checks the answer's shape, not whether it is right.
- **`JigsError`** ends the run as failed, with a hint for whoever reads it.
  Returning a value always means success.
- **`requires`** lists what the workflow needs: the binding, the harness CLI and
  the model source. Preflight checks each one before every run and refuses to
  start with a repair when one is missing. `jigs doctor` runs the same checks.

This model source reads `OPENROUTER_API_KEY` from the factory's `.env`. See
[Models and harnesses](/guide/models-and-harnesses) for the other harnesses and
sources and what each one needs.

## 3. Register it

Add the workflow to the `workflows` map in `jigs.config.ts`:

```ts
workflows: {
  hello: () => import("./workflows/hello.ts"),
  triage: () => import("./workflows/triage.ts"),
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
import { claimTicket } from "@jigs-ai/jigs/blocks/linear";
import { haltForHuman, resolveLinearIssue } from "#jigs";

const issue = await resolveLinearIssue(inputs.ticket);
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

Add `integrations: ["linear"]` to the workflow's `requires`.
`jigs status <run-id>` shows the question and the link to answer it. The service re-reads the
ticket every 300 seconds by default, or sooner with
[webhooks](/guide/configuration#webhooks); `jigs poke <run-id>` checks now.
Answer the existing run rather than starting another one.

## Record what the workflow created

`jigs status <run-id>` lists a run's resources, such as its worktree. Record
anything else a person may need to find with `registerResource`:

```ts
import { registerResource } from "#jigs";

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

- [Agents and models API](/api/blocks/agents): every option of `runAgent`,
  `askAgent`, `askModel` and `askJev`.
- [Linear API](/api/blocks/linear): claims, questions, ticket notes and snapshots.
- [Runtime API](/api/blocks/runtime): run directories, resources and release.
- [Workspaces API](/api/blocks/workspaces): worktrees.
- [Git API](/api/blocks/git): reading a change and its patch.
- [Pull requests API](/api/blocks/pull-requests): gates, merge policy and review answers.
- [Models and harnesses](/guide/models-and-harnesses): what each harness and model source needs.
