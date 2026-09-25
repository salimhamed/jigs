# Core concepts

A factory has two kinds of function. A workflow function decides what happens
next. A step function does the work. They run in different places, and the
line between them is the one hard rule in jigs. This page starts with the
words, then the rule, then what follows from it.

| Term | Meaning |
| --- | --- |
| Factory | Your repository of workflows and configuration. It runs its own service. |
| Workflow | A [Vercel Workflow SDK](https://useworkflow.dev) workflow: an async function whose first statement is `"use workflow"`. It decides what happens next. |
| Step | One durable, recorded operation: a function marked `"use step"`. It runs in a worker and does the work. |
| Routine | A function you call from a workflow. It runs steps and can wait for something outside the run. |
| Harness | An agent program jigs starts, such as Claude Code, Codex or Pi. It works with tools in a directory. |
| Agent | A named harness configuration playing a part in your workflow, such as a builder or a reviewer. |
| Agent session | One agent across several turns of a workflow, so each turn remembers the ones before it. |
| Session reference | The small piece of data a later step uses to resume the same harness session. |
| Run | One execution of a workflow, including any time it spends waiting. |
| Suspension | A run waiting on something outside it, such as a reply on a ticket or a pull-request review. |
| Wake | A nudge that makes a suspended run check its condition again. It does not answer the wait for you. |
| Binding | A name for a target repository, mapped to its remote URL. |
| Worktree | A Git working directory jigs cuts from its clone of a binding, one per run and branch. |
| Recipe | A complete workflow you copy into your factory and then own. |
| Model source | A model API that answers one request directly, such as OpenRouter. |
| Preflight | The checks jigs runs on a workflow's `requires` before it creates a run. A failure names its repair, and no run starts. |
| Jev | A decision call, `askJev`, that returns calibrated probabilities for named yes/no, choice or score questions. |

## The boundary

A step call is a message through the database, not a function call. When a
workflow awaits a step, five things happen:

1. The workflow writes the argument to the database as JSON, and pauses.
2. A worker reads the argument, possibly in another process, possibly after a
   restart.
3. The worker runs the step's body: files, network, agents.
4. The worker writes the result to the database as JSON.
5. The workflow replays from its first line, and this time the `await` returns
   the stored result.

So an argument or a result has to be something that can be written down:
strings, numbers, booleans, arrays and plain objects. A function has no written
form, and neither does an object that holds a running process.

A harness descriptor crosses the boundary, because it is only data. A provider
object does not: its methods are functions, and it holds a child process.

```ts
// Crosses: it is only data.
harnesses.claude({ model: "opus", effort: "high" });
// => { kind: "claude", model: "opus", effort: "high" }

// Does not: a provider from the AI SDK is made of functions.
claudeCode("opus");
// SerializationError: Failed to serialize step arguments at path "..."
```

That is why a workflow sends a description and the step builds the live thing
from it. The same rule explains why prompts are rendered to strings before a
step call, why a session reference is a small piece of data, and why your
factory holds a generated step file at all.

## Workflows decide, steps do the work

A workflow is replayed from its first line every time the run wakes. Steps
that already finished return their recorded result instead of running again.

```ts
export async function hello(_input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  return await createRunDirectory();
}
```

So a workflow, and every routine it calls, must be safe to run again. It reads
no files, calls no network, runs no Git commands and reads no `process.env`.
The workflow bundle has no Node built-ins, so an import that needs one fails
the build.

That work belongs in steps. jigs provides steps for the common operations, and
you can write your own in a `steps.ts` beside the workflow that uses it.

## Routines compose steps

A routine is a function you call from a workflow. It calls steps for you and
can wait for something outside the run, such as a reply on a ticket.

```ts
import { reviewTicket } from "#jigs/routines";

const handoff = await reviewTicket({ claim, snapshot, harness: agents.reviewer, cwd });
```

A routine has no directive and no recorded result of its own. Only the steps it
calls are recorded, so a routine can change between jigs releases without
stranding a waiting run.

## Agents are named harnesses

An agent is a harness configuration with a name: the part it plays in your
workflow. A workflow lists its agents in a plain object and declares them in
`requires`.

```ts
import { defineWorkflow, harnesses } from "@jigs-ai/jigs";

const agents = {
  builder: harnesses.claude({ model: "opus", effort: "high" }),
  reviewer: harnesses.codex({ model: "gpt-5.6-sol" }),
};

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["linear", "github"] },
  workflow: shipTicket,
});
```

The service checks each agent's harness when it starts, and preflight checks it
before every run. A run chooses among the names; to change a model, edit its
line in `agents`.

An agent session is one agent across several turns of a workflow: it resumes
the harness session it holds, and starts fresh when it cannot. A session
reference is the piece of data that makes the resume possible, small and plain
enough to pass to a later step.

## The factory holds generated code

The Workflow SDK gives each workflow and step a durable ID made from its file
path and function name. A waiting run is tied to those IDs.

`jigs generate` writes two files into `jigs/`, and a workflow imports from them
by name:

```ts
import { provisionWorktree, setTicketStatus } from "#jigs/steps";
import { reviewTicket, runAgent } from "#jigs/routines";
```

`jigs/steps.ts` holds every step jigs provides: small `"use step"` wrappers
around jigs' operations. It is the only generated file with a directive, so
every name in it is recorded and replayed.

`jigs/routines.ts` holds the routines, bound to those steps. `runAgent`,
`reviewTicket` and `pullRequestGate` are routines.

Commit `jigs/` and never edit it. `jigs generate` refreshes it from the
installed jigs version, a build fails with that repair if it is out of date,
and `jigs upgrade` regenerates it for you.

The directives live in your factory because the IDs have to stay put. If the
`"use step"` functions lived inside the jigs package, every upgrade would move
them and strand the runs that were waiting.

## Renaming moves an ID

Moving or renaming a workflow file, a workflow function or a step changes its
address. Finish or cancel the runs that use it before you deploy the rename.

The same holds for the generated files: a jigs release that moves
`jigs/steps.ts` or renames a step in it moves those IDs, and says so in its
release notes.

## Two import sources

A workflow imports from two kinds of place. The library, `@jigs-ai/jigs`, holds
types, constructors and pure functions such as `defineWorkflow`, `harnesses`
and `renderTicketSnapshot`. `#jigs/steps` and `#jigs/routines` hold the durable
operations generated for your factory.

```ts
import { defineWorkflow, harnesses } from "@jigs-ai/jigs";
import { reviewTicket } from "#jigs/routines";
import { provisionWorktree, setTicketStatus } from "#jigs/steps";
import { implementAndReview } from "./delivery/delivery.ts";
```

Import a workflow's own files with relative paths. The workflow loaders in
`jigs.config.ts` stay relative too.

The split is there so you can see it. Every name from `#jigs/steps` is one
recorded operation, and every name from `#jigs/routines` composes those.

## Factory layout

`jigs init` writes these files:

| File | What it is for |
| --- | --- |
| `jigs.config.ts` | Service ports, bindings, registered workflows, schedules and policy. See [Configuration](/guide/configuration). |
| `jigs.config.test.ts` | Checks the registered workflows and the durable IDs the build emits. |
| `jigs/steps.ts`, `jigs/routines.ts` | The generated files described above. |
| `workflows/hello/hello.ts` | The first workflow. Each workflow gets its own directory under `workflows/`. |
| `.env.example` | The environment file template. Copy it to `.env` for secrets. |
| `package.json` | Pins jigs and maps `#jigs/*` to the files in `jigs/`. |
| `nitro.config.ts`, `docker-compose.yml`, `tsconfig.json`, `vitest.config.ts`, `pnpm-workspace.yaml`, `.gitignore`, `README.md` | Build, database and tooling settings. |

A workflow keeps what it owns beside it. Its own `"use step"` functions go in a
`steps.ts` in its directory, and its prompts and other files next to that.
