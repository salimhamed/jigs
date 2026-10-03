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
