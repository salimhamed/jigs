# Core concepts

A handful of terms covers most of what you will meet in a factory.

| Term | Meaning |
| --- | --- |
| Factory | Your repository of workflows and configuration. It runs its own service. |
| Workflow | A [Vercel Workflow SDK](https://useworkflow.dev) workflow: an async function whose first statement is `"use workflow"`. |
| Step | A Workflow SDK step: a function marked `"use step"`. The runtime records its result. |
| Block | Plain workflow-side code that calls steps and makes decisions. It has no directive. |
| Run | One execution of a workflow, including any time it spends waiting. |
| Suspension | A run waiting on something outside it, such as a reply on a ticket or a pull-request review. |
| Wake | A nudge that makes a suspended run check its condition again. It does not answer the wait for you. |
| Binding | A name for a target repository, mapped to its remote URL. |
| Worktree | A Git working directory jigs cuts from its clone of a binding, one per run and branch. |
| Recipe | A complete workflow you copy into your factory and then own. |
| Harness | An agent program jigs starts, such as Claude Code, Codex or Pi. It works with tools in a directory. |
| Model source | A model API that answers one request directly, such as OpenRouter. |
| Preflight | The checks jigs runs on a workflow's `requires` before it creates a run. A failure names its repair, and no run starts. |
| Jev | A decision call, `askJev`, that returns calibrated probabilities for named yes/no, choice or score questions. |

## Workflows coordinate, steps do the work

When a run wakes up, the runtime calls the workflow function again from its
first line. Steps that already finished return their recorded result instead of
running again. This is called **replay**.

So a workflow, and every block it calls, must be safe to run again: no file
access, network calls, Git commands or `process.env` reads. That work belongs in
steps. jigs provides steps for the common operations, and you can write your own
in a `steps.ts` in the workflow's directory, `workflows/<name>/steps.ts`. Pass only plain data into a step; keep prompts written as
functions, and other callbacks, on the workflow side.

## Why the factory holds generated code

The Workflow SDK gives each workflow and step a durable ID made from its file
path and function name. A waiting run is tied to those IDs. If the `"use step"`
functions lived inside the jigs package, every upgrade would move them and
strand the runs that were waiting.

So the directives live in your factory. `jigs generate` writes two files into
`jigs/`, and a workflow imports from them by name:

```ts
import { provisionWorktree, setTicketStatus } from "#jigs/steps";
import { reviewTicket, runAgent } from "#jigs/routines";
```

`jigs/steps.ts` holds every step jigs provides: small `"use step"` wrappers
around jigs' operations. It is the only generated file with a directive, so
every name in it is recorded and replayed.

`jigs/routines.ts` holds the functions a workflow calls that run those steps
for you, and may wait on something outside the run, such as a reply on a
ticket. `runAgent`, `reviewTicket` and `pullRequestGate` are routines.

Commit `jigs/` and never edit it. `jigs generate` refreshes it from the
installed jigs version, a build fails with that repair if it is out of date,
and `jigs upgrade` regenerates it for you.

## Renaming a workflow or step

Because IDs come from paths and names, moving or renaming a workflow file, a
workflow function or a step changes its address. Finish or cancel the runs that
use it before you deploy the rename. The same holds for the generated files: a
jigs release that moves `jigs/steps.ts` or renames a step in it moves those IDs,
and says so in its release notes.

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
`steps.ts` in its directory, and its prompts and helpers in files next to that.

A workflow imports from two kinds of place. The library, `@jigs-ai/jigs` and
its topic subpaths, holds types, constructors and pure functions such as
`defineWorkflow` and `harnesses`. `#jigs/steps` and `#jigs/routines` hold the
durable operations generated for your factory. Import a workflow's own files
with relative paths inside its directory. The workflow loaders in
`jigs.config.ts` stay relative too.

The split between steps and routines is there so you can see it: every name
from `#jigs/steps` is one recorded operation, and every name from
`#jigs/routines` composes those.
