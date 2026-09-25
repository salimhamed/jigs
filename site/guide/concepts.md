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

This small example uses a fixed issue record and a durable wait:

```ts
import { sleep } from "workflow";

async function loadIssue(issueId: string) {
  "use step";

  // The completed call's input and result are saved in the database.
  return { id: issueId, title: "Fix authentication bug", priority: "high" };
}

export async function inspectIssue(issueId: string) {
  "use workflow";

  // Execution begins here again whenever the workflow resumes.
  const issue = await loadIssue(issueId);
  // On replay, this receives the saved result without rerunning loadIssue.

  await sleep("1 minute");
  // The run waits. After waking, it replays from the top, then continues here.
  return issue.title;
}
```

Each time a workflow starts or resumes, its code executes from the beginning.
The SDK keeps track of completed step calls in its database. When replay
reaches one, the SDK returns its recorded result instead of executing the
step again. Execution continues until it reaches new work or another wait.

A **conceptual representation** of persisted step data looks like this:

```json
{
  "step": "loadIssue",
  "input": ["ENG-123"],
  "result": {
    "id": "ENG-123",
    "title": "Fix authentication bug",
    "priority": "high"
  }
}
```

The JSON above illustrates the information the SDK saves for a step. You do
not write this record yourself; the SDK handles saving and loading it. jigs
uses Postgres, so the saved inputs and result survive a service restart.

**Workflow code replays; completed step calls return results from the database.**
That is the durable boundary. A step that fails before completion may be
retried, so external writes should be safe to repeat.

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
For example, `runAgent` coordinates agent execution, while `pullRequestGate`
waits for a pull request to meet the workflow's requirements. A routine packages
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
