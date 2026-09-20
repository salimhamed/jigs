# Core concepts

You only need a few terms to find your way around a factory.

| Term | Meaning |
| --- | --- |
| Factory | Your repository of workflows, configuration, and custom code. |
| Workflow | A TypeScript function describing a complete process. |
| Run | One execution of a workflow, including time spent waiting. |
| Step | An operation whose attempts and result the runtime records. |
| Block | Reusable workflow code that coordinates steps and decisions. |
| Binding | A name for a target repository and its provisioning settings. |
| Worktree | A Git working directory provisioned for an agent’s work. |
| Recipe | A complete workflow you copy into your factory and then own. |

## Find the file you need

| File or directory | What you use it for |
| --- | --- |
| `jigs.config.ts` | Register workflows, configure ports, and declare bindings and policy. |
| `workflows/` | Describe your processes and their inputs. |
| `blocks/` | Keep reusable decisions, prompts, and coordination. |
| `steps/` | Add custom operations that touch files, services, or other external state. |
| `jigs.ts` | Generated integration connecting jigs operations to durable steps in your factory. |

Import ready-to-call jigs operations from `#jigs`. Commit `jigs.ts`, but put your
custom code elsewhere: `jigs generate` and upgrades refresh this file.

## Workflows coordinate; steps do the work

A workflow has a `"use workflow"` directive. When a run wakes, the runtime can
execute its body again from the beginning, returning recorded results for
completed step calls. This is called **replay**.

Keep the workflow body and its blocks safe to repeat. File access, network calls,
Git commands, and reading environment variables belong in durable steps with
`"use step"`, or in existing jigs operations that already provide them. Pass
serializable data into steps; keep prompts that are functions and other callbacks
on the workflow side.

## Waiting is part of a run

A **suspension** means a run is waiting for something external, such as a human
reply. A **wake** asks it to check whether that condition is now satisfied. A wake
does not create another run or guarantee that the run can continue yet.

While a run is suspended, retain the directories it needs. Do not put resource
release in a `finally` block: suspension can unwind workflow code too.

## Changing a running workflow

Moving or renaming workflow functions and durable step wrappers changes their
runtime addresses. Finish affected runs, or deliberately cancel them, before
deploying incompatible changes. Changing workflow logic can also affect replay.
Ordinary jigs package version bumps do not themselves rename your step addresses.

The [API reference](/api/) gives exact signatures. The repository’s
[domain vocabulary](https://github.com/salimhamed/jigs/blob/main/CONTEXT.md) defines
the less common terms you may encounter there.
