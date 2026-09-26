# Models and harnesses

A **harness** runs an agent loop, such as Claude Code, Codex or Pi. It can use
tools, work in a directory and, in some cases, resume a session.

A **model source** makes a direct model request without an agent loop. Use it
for classification, extraction, summarization or structured decisions.

A workflow can mix them freely. For example, Claude Code can implement a change,
Codex can review it, and a local or hosted model can classify the result.

## Choose how AI runs

Import these routines from `#jigs/routines`:

| API | Uses | Best for |
| --- | --- | --- |
| `runAgent` | Harness, working directory and tools | Coding, debugging, commands and edits |
| `askAgent` | Harness without tools or a directory | A single answer using a harness-backed model |
| `askModel` | Direct model source | Classification, extraction, summarization and structured output |
| `askJev` | OpenRouter decision model | Probabilistic yes/no, choice or score decisions |

Codex supports `runAgent` only. `askAgent` supports Claude Code and Pi.
`runAgent`, `askAgent` and `askModel` accept a Zod `output` schema to validate
the answer; `askJev` returns typed decision answers. See the
[routine reference](/api/factory/routines) for exact options and results.

## Requirements and preflight

A workflow declares the agents and model sources it requires. jigs uses those
declarations for preflight checks, catching missing CLIs, credentials and model
endpoints before the run begins:

```ts
import { defineWorkflow, harnesses, models } from "@jigs-ai/jigs";

const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
};
const summarizer = models.openrouter("google/gemini-2.5-flash-lite");

// inputs and ship are the workflow's schema and function.
export default defineWorkflow({
  inputs,
  requires: { agents, models: [summarizer] },
  workflow: ship,
});
```

Install only the harnesses your workflows use, on the service's `PATH`. A
workflow that calls no agent or model needs none of them. jigs does not track
spend; use each provider's dashboard.

## Agent sessions

An agent session lets a workflow talk to the same agent across multiple turns.
Each turn provides two prompts: `resume` is the new information for an existing
session, and `fresh` supplies enough context to reconstruct the task if that
session is gone. jigs falls back to `fresh` when it cannot resume the session.

```ts
import { agentSession } from "#jigs/routines";
import { readWorktreeDiff } from "#jigs/steps";

// task and review are text prepared earlier in the workflow.
const builder = agentSession({
  name: "builder",
  harness: agents.builder,
  cwd: worktree.path,
});

await builder.run({ resume: task, fresh: task });
// After an independent reviewer has checked the work:
await builder.run({
  resume: `Address this review: ${review}`,
  fresh: async () =>
    `${task}\nCurrent changes: ${await readWorktreeDiff(worktree)}\nReview: ${review}`,
});
```

A prompt can be a function, so only the prompt actually sent needs to read the
diff. These functions stay in workflow code; they are not passed as step data.

The durable state is an `AgentSessionRef`, plain data returned by a recorded
step. On [replay](/guide/concepts#how-durable-execution-works), the session helper
is rebuilt and the recorded reference comes back from the database. Changing
the harness descriptor also starts a fresh session. Give each independent agent
its own session.

## Harness settings

Claude Code and Codex descriptors use the provider's own JSON-serializable
settings, except for execution policy and lifecycle settings owned by jigs:

```ts
harnesses.claude({ model: "opus", effort: "high" });
harnesses.codex({ model: "gpt-5.6-sol", personality: "pragmatic" });
```

Descriptors cross the durable workflow/step boundary, so they must be data.
jigs owns the working directory, environment, permissions and session lifecycle
to keep execution consistent. Use TypeScript autocomplete and the
[harness types](/api/jigs#harnesses-and-models) for the exact settings. Provider
callbacks or live objects belong inside a [custom agent step](/guide/custom-agent-step).

## Claude Code

`harnesses.claude({ model, ...settings })` is a harness for `runAgent` and
`askAgent`. Install Claude Code, keep `claude` on the service's `PATH` (or set
`JIGS_CLAUDE_EXECUTABLE`), and run `claude auth login`. Calls use that account.
jigs runs it unattended with permission prompts bypassed. `askAgent` uses the
model without tools, MCP servers or filesystem settings.

## Codex

`harnesses.codex({ model, ...settings })` is a harness for `runAgent`. Install
the Codex CLI, keep `codex` on the service's `PATH`, and run `codex login`.
jigs checks that the installed CLI is compatible. Codex has no tool-free
`askAgent` mode. Its agent steps run unattended with jigs-owned approval and
sandbox policy.

## Pi

`harnesses.pi(source, options)` supports `runAgent` and `askAgent`. It can use
`models.openaiCodex(...)`, OpenRouter or an OpenAI-compatible model source.
Install `@earendil-works/pi-coding-agent` globally and keep `pi` on the service's
`PATH`. For an OpenAI Codex subscription, run `pi` and choose `/login`; other
sources use their configured credentials.

Each call gets a private home so concurrent calls do not share settings or
sessions. Configure tools and MCP servers on the descriptor; Pi does not read
global or project MCP configuration.

## OpenRouter

`models.openrouter(model)` is a model source for `askModel`, `askJev` or Pi.
Set `OPENROUTER_API_KEY` in the factory's [`.env`](/guide/configuration#env).
Direct structured requests require a model with structured-output support.
`askJev` specifically needs a compatible decision model.

## OpenAI-compatible

Use `models.openaiCompatible(...)` for a server that exposes an OpenAI-compatible
API, including local model servers:

```ts
const local = models.openaiCompatible({
  name: "local",
  baseUrl: "http://localhost:1234/v1",
  model: "your-served-model-id",
});
```

Use it with `askModel` or Pi. Use the server's API base URL (often ending in `/v1`); the model must appear
in the server's `/models` response. jigs checks that endpoint and model before
the run. If the server requires a key, set `apiKeyEnv` to its `.env` variable name.

## Jev decisions

`askJev` is for explicit probabilistic decisions rather than free-form prose.
It asks named questions about one state and returns probabilities; your workflow
decides what confidence is enough to act:

```ts
import { models, yesNo } from "@jigs-ai/jigs";
import { askJev } from "#jigs/routines";

const result = await askJev({
  model: models.openrouter("typesafe/jev-1.13"),
  state: { report: "Saving a draft twice loses its title." },
  questions: { dataLoss: yesNo("Does this report describe lost user data?") },
});
```

See [decision types](/api/jigs#decision-models) for choice and score questions.

### One decision with a cutoff

`decide` asks a single question with `jevModel` and tells you whether the answer
is confident enough to act on. Below the cutoff, do what the workflow would do
without Jev:

```ts
import { choice } from "@jigs-ai/jigs";
import { decide } from "#jigs/routines";

const wake = await decide({
  site: "pull-request-wake",
  state: { ci: "pending", newComments: [] },
  question: choice("What does this pull request need now?", {
    idle: "Nothing to act on yet",
    builder: "The builder should act",
  }),
  cutoff: 0.9,
});
if (wake.confident && wake.answer.choice === "idle") return;
```

A choice or score is as confident as the model says. A yes-or-no answer is as
confident as its more likely side, and `yes` says which side that is. Every
answered `askJev` or `decide` call appends a line, tagged with its `site`, to
`decisions.jsonl` in the run's working directory.

## Agent environment

Agents do not automatically inherit the service environment. Add additional
variable names through [`agents.env`](/guide/configuration#agents-env). This
controls environment variables only: agent processes run as your user and can
access the files your user can access.
