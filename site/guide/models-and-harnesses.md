# Models and harnesses

A **harness** is an agent program jigs starts, such as Claude Code. It runs its
own agent loop and can use tools, a working directory and a session you resume
later. A **model source** is an API that answers one request directly, such as
OpenRouter. Both are described by plain descriptors you build in workflow code:

```ts
import { harnesses, models } from "@jigs-ai/jigs/blocks/agents";

harnesses.claude("sonnet");
harnesses.pi(models.openaiCodex("gpt-5.5"), { thinking: "high" });
models.openrouter("google/gemini-2.5-flash-lite");
```

## The four verbs

Import them from `#jigs/routines`.

| Verb | Takes | Use it to |
| --- | --- | --- |
| `runAgent` | a harness and a `cwd` | Do work with tools in a directory: read code, run checks, make a change. |
| `askAgent` | Claude Code or Pi, without tools | Get one answer from a harness with no tools and no directory. |
| `askModel` | an OpenRouter or OpenAI-compatible source | Call a model API directly, for summaries and classification. |
| `askJev` | an OpenRouter jev model | Get calibrated probabilities for named yes/no, choice or score questions. |

Each verb takes an optional zod `output` schema (`askJev` returns its own typed
answers). An agent result can carry a `session`; pass it as `resume` to a later
`runAgent` to continue that conversation. Give an independent reviewer its own
session, and never share one between harnesses.

Name each agent a workflow runs in its `requires.agents`, and add each model
source it calls to `requires.models`:

```ts
const agents = {
  builder: harnesses.codex("gpt-5.6-sol"),
  reviewer: harnesses.claude("opus"),
};

export default defineWorkflow({
  inputs,
  requires: { agents, models: [summarizer] },
  workflow: ship,
});
```

jigs reads the harness kinds from the agents. The service checks those harness
CLIs when it starts, and preflight checks everything listed before each run. A
factory whose workflows run no agent needs no harness installed.

jigs does not track spend. Watch it in each provider's own dashboard.

## Claude Code

`harnesses.claude(model, options)` works with `runAgent` and `askAgent`. It runs
the `claude` CLI on the service's `PATH`, or the path in `JIGS_CLAUDE_EXECUTABLE`,
logged in with `claude auth login`. It bills that account. `options.effort` sets
the effort level; `options.mcpServers` adds MCP servers for `runAgent`.

## Codex

`harnesses.codex(model, options)` works with `runAgent` only. Codex has no mode
without tools, so `askAgent` refuses it. It runs the `codex` CLI on the
service's `PATH`, logged in with `codex login`. The service refuses to start
when that CLI is older than the minimum version it names.

## Pi

`harnesses.pi(source, options)` works with `runAgent` and `askAgent`. Its first
argument is a model source, so one harness can run models from several
providers: `models.openaiCodex(...)`, `models.openrouter(...)` or
`models.openaiCompatible(...)`.

- Install Pi 0.85.1 or newer and keep it on the service's `PATH`:
  `npm install --global @earendil-works/pi-coding-agent`.
- For the OpenAI Codex subscription source, run `pi`, choose `/login`, then
  OpenAI Codex.
- `options.thinking` sets the thinking level. For `runAgent`, `options.tools`
  limits Pi to a list such as `["read", "bash"]`; leave it out for Pi's default
  tools.
- `options.mcpServers` is the complete set of MCP servers Pi sees. Pi never
  reads your global or project MCP files. Each server lists the tools the model
  may call, and names environment variables for its secrets, never the values.

Each Pi call gets its own private home directory, so parallel calls never share
settings or sessions.

## OpenRouter

`models.openrouter(model)` works with `askModel`, `askJev`, and as a Pi source.
Set `OPENROUTER_API_KEY` in the factory's `.env`, then run `jigs service
restart`. To read a different variable, pass
`models.openrouter(model, { apiKeyEnv: "TEAM_OPENROUTER_KEY" })`. Direct calls
use strict structured output, so pick a model that supports
[`structured_outputs`](https://openrouter.ai/models?supported_parameters=structured_outputs).

## OpenAI-compatible

`models.openaiCompatible({ name, baseUrl, model, apiKeyEnv? })` works with
`askModel` and as a Pi source. `baseUrl` is the server's full API base,
including `/v1`, and `model` is an ID its `/models` endpoint returns. Most local
servers need no key; for one that does, name its `.env` variable with
`apiKeyEnv`. Before each run, preflight asks `<baseUrl>/models` whether the
model is served.

## Jev decisions

`askJev` asks a jev decision model named questions about one piece of state and
returns probabilities rather than prose:

```ts
import { models, score, yesNo } from "@jigs-ai/jigs/blocks/agents";
import { askJev } from "#jigs/routines";

const result = await askJev({
  model: models.openrouter("typesafe/jev-1.13"),
  state: {
    crm: { name: "Acme Labs", domain: "acme.example" },
    billing: { name: "Acme Labs LLC", domain: "acme.example" },
  },
  questions: {
    samePair: score("How closely do these records align?", [
      "Different companies",
      "Possibly the same company",
      "The same company",
    ]),
    sameDomain: yesNo("Do the domains refer to the same entity?"),
  },
});
```

`yesNo` returns a probability, `choice` a selected option with a probability for
each, and `score` a probability per level plus a weighted score. How much
probability is enough to act on is your workflow's decision.

## Agent environment

Agents do not inherit the service's environment. Each starts with a small base
set such as `PATH` and `HOME`, plus what its harness needs. To pass anything
else, list its name under [`agents.env`](/guide/configuration#agents-env).
