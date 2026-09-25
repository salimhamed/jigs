# Core concepts

| Concept | Meaning |
| --- | --- |
| **Factory** | A repository you own that contains your workflows and jigs configuration. |
| **Workflow** | A Vercel Workflow SDK function that defines the order of work and can resume after a wait or restart. |
| **Step** | A Vercel Workflow SDK function that does work. The SDK saves its result so the same call can reuse it when the workflow resumes. |
| **Routine** | A reusable composition of common steps and waits provided by jigs. |
| **Run** | One execution of a workflow. |
| **Harness** | A program such as Claude Code or Codex that runs an agent. |
| **Agent** | Settings for a coding assistant, given a name such as `builder` or `reviewer`. They choose the harness and model to use. |
| **Binding** | A GitHub repository given a name in your factory so workflows can work with it. |

## Built on the Vercel Workflow SDK

jigs builds on the [Vercel Workflow SDK](https://useworkflow.dev).
`"use workflow"` and `"use step"` are build directives: the SDK's build
transformation gives these functions their execution behavior. Put each
directive first in its function body. The distinction creates a durable
boundary between workflow orchestration and step execution.

## How durable execution works

A workflow can pause while waiting and continue later, even after the service
restarts. The Workflow SDK saves its progress in your factory's Postgres
database.

This version of `workflows/hello/hello.ts` creates a working directory, waits
one minute, then returns the directory's path:

```ts
import { defineWorkflow } from "@jigs-ai/jigs";
import { sleep } from "workflow";
import { z } from "zod";
import { createRunDirectory } from "#jigs/steps";

const inputs = z.object({});

export async function hello() {
  "use workflow";

  // Create a working directory for this run.
  const directory = await createRunDirectory();

  // Wait without keeping this function running.
  await sleep("1 minute");

  return { directory };
}

export default defineWorkflow({ inputs, workflow: hello });
```

`createRunDirectory` is a jigs-provided step. Its generated function already
contains `"use step"`. `sleep` comes from the Workflow SDK's `workflow` package,
which is installed in your factory.

Here is what happens:

1. `createRunDirectory()` creates a directory and returns its path. The SDK
   saves the completed step's result in Postgres.
2. `sleep("1 minute")` records when the workflow should continue, then pauses
   it.
3. When the workflow resumes, its function runs again from the beginning. At
   `createRunDirectory()`, the SDK returns the saved path without running the
   step again.
4. The SDK also remembers the wait. Once its deadline has passed, execution
   continues to `return`. Replaying does not start another one-minute wait.

The saved progress survives a service restart. **Workflow code runs again;
completed step calls reuse their saved results.** A step whose completion has
not been recorded may be retried, so external writes should be safe to repeat.

## Serializable inputs and results

Step inputs and outputs cross the durable boundary and are persisted, so they
must be serializable. Plain JSON data is the simplest starting point: strings,
numbers, booleans, `null`, arrays and plain objects containing those values.

For example, a step can return:

```ts
return {
  id: "ENG-123",
  files: ["auth.ts", "session.ts"],
  approved: true,
};
```

The SDK also supports types such as `Date`, `Map` and `Set`; it is not limited
to JSON. Keep live database connections, running processes and arbitrary
functions inside steps. Return the data another operation needs, such as a
record ID or file path, rather than the live object that produced it.

## Workflows decide, steps do the work

**Workflows decide what should happen. Steps make things happen.**

Use workflows for sequencing, branching, loops, decisions and composing durable
operations. Put file access, API calls, Git commands, agent invocations and
other side effects in steps, because workflow code can replay.

Workflow code and its imports must be safe to replay: they cannot use Node
built-ins, read `process.env` or reach the network. Steps can do that work and
return its results.

## Routines compose common operations

**jigs provides routines that compose common steps into higher-level operations.**
For example, `runAgent` coordinates agent execution, while `watchPullRequest`
reports changes to a pull request so the workflow can decide what happens next. A routine packages
orchestration that every workflow would otherwise have to rebuild.

Steps are the durable units recorded by the SDK. A routine is ordinary workflow
code that composes steps and waits, with no directive or recorded result of its
own. Routines let workflows express intent while keeping the underlying steps
visible.

## Agents are named harness configurations

A **harness** is the program that runs an agent, such as Claude Code or Codex.
An **agent** is a set of settings for a coding assistant, given a name such as
`builder` or `reviewer`. These settings choose the harness and model to use:

```ts
import { harnesses } from "@jigs-ai/jigs";

const agents = {
  builder: harnesses.claude({ model: "opus" }),
  reviewer: harnesses.codex({ model: "gpt-5.6-sol" }),
};
```

Workflows operate above this layer, so different parts of one workflow can use
different harnesses, direct model calls or ordinary code.

## Factories and repositories

Your workflows live in a **factory**, separate from the repositories they
automate. A **binding** gives a GitHub repository a name that workflows can
reference. jigs currently supports GitHub repositories. One workflow can operate across several repositories, or use no Git
repository at all.

## Why jigs generates code in your factory

The SDK needs stable identities for durable steps to match completed work with
persisted results. A step's identity comes from its file path and function
name. Moving or renaming it matters while existing runs still depend on it.

jigs generates step wrappers in your factory's `jigs/steps.ts`. Those paths and
names stay stable as the library implementation changes. `jigs/routines.ts`
binds routines to these wrappers; routines have no durable identities of their
own.

**Commit the generated `jigs/` directory, but do not edit it by hand.** These
files are part of the factory's durable contract. Committing them keeps their
identities consistent across machines and code changes. `jigs generate`
refreshes them; `jigs upgrade` does that for you. Finish or cancel affected runs
before moving or renaming a workflow or step.

Import jigs-provided steps and routines from the generated modules. Use
`@jigs-ai/jigs` for types, configuration helpers, harnesses, models and other
library APIs:

```ts
import { defineWorkflow, harnesses } from "@jigs-ai/jigs";
import { runAgent } from "#jigs/routines";
import { createRunDirectory } from "#jigs/steps";
```

## Factory layout

```text
my-factory/
├── jigs.config.ts
├── workflows/
│   └── hello/
│       └── hello.ts
├── jigs/
│   ├── steps.ts
│   └── routines.ts
└── .env
```

- `jigs.config.ts`: factory configuration and workflow registration.
- `workflows/`: workflows you write.
- `jigs/`: generated step wrappers and routines; commit it, do not edit it.
- `.env`: local configuration and credentials.
