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

## Workflows coordinate, steps do the work

When a run wakes up, the runtime calls the workflow function again from its
first line. Steps that already finished return their recorded result instead of
running again. This is called **replay**.

So a workflow, and every block it calls, must be safe to run again: no file
access, network calls, Git commands or `process.env` reads. That work belongs in
steps. jigs provides steps for the common operations, and you can write your own
under `steps/`. Pass only plain data into a step; keep prompts written as
functions, and other callbacks, on the workflow side.

## Why the factory holds generated code

The Workflow SDK gives each workflow and step a durable ID made from its file
path and function name. A waiting run is tied to those IDs. If the `"use step"`
functions lived inside the jigs package, every upgrade would move them and
strand the runs that were waiting.

So the directives live in your factory. `jigs.ts` is a generated file of small
`"use step"` wrappers around jigs' operations, plus ready-to-call blocks.
Workflows import from it as `#jigs`:

```ts
import { createRunDirectory, runAgent } from "#jigs";
```

Commit `jigs.ts` and keep your own code out of it. `jigs generate` refreshes it
from the installed jigs version, a build fails with that repair if it is out of
date, and `jigs upgrade` regenerates it for you.

## Renaming a workflow or step

Because IDs come from paths and names, moving or renaming a workflow file, a
workflow function or a step changes its address. Finish or cancel the runs that
use it before you deploy the rename. Upgrading jigs alone does not change your
IDs.

## Factory layout

`jigs init` writes these files:

| File | What it is for |
| --- | --- |
| `jigs.config.ts` | Service ports, bindings, registered workflows, schedules and policy. See [Configuration](/guide/configuration). |
| `jigs.config.test.ts` | Checks the registered workflows and the durable IDs the build emits. |
| `jigs.ts` | The generated integration described above. |
| `workflows/hello.ts` | The first workflow. Add your own next to it. |
| `.env.example` | The environment file template. Copy it to `.env` for secrets. |
| `package.json` | Pins jigs and defines the `#jigs`, `#blocks/*` and `#steps/*` imports. |
| `nitro.config.ts`, `docker-compose.yml`, `tsconfig.json`, `vitest.config.ts`, `pnpm-workspace.yaml`, `.gitignore`, `README.md` | Build, database and tooling settings. |

Two folders appear when you need them. The `#blocks/*` and `#steps/*` imports
already point at them:

- `blocks/` for your own reusable workflow-side code, such as prompts and
  decisions. A recipe copies its blocks here too.
- `steps/` for your own `"use step"` functions that touch files, services or
  other outside state.

Factory code imports from the root, as `#jigs`, `#blocks/<path>` and
`#steps/<path>`, never with `../`. The workflow loaders in `jigs.config.ts` stay
relative.
