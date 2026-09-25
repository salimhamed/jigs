# Models and harnesses

A **harness** is an agent program jigs starts, such as Claude Code. It runs its
own agent loop and can use tools, a working directory and a session you resume
later. A **model source** is an API that answers one request directly, such as
OpenRouter. Both are described by plain descriptors you build in workflow code:

```ts
import { harnesses, models } from "@jigs-ai/jigs";

harnesses.claude({ model: "sonnet", effort: "high" });
harnesses.pi(models.openaiCodex("gpt-5.5"), { thinking: "high" });
models.openrouter("google/gemini-2.5-flash-lite");
```

The kinds are fixed: a factory cannot add a harness or model kind,
`models.openaiCompatible` reaches any endpoint that speaks the OpenAI API, and a
native Anthropic or Gemini API becomes a built-in kind when a factory needs one.

## Install and log in

Install only the harness CLIs your workflows use. Keep each on the `PATH` of
the shell that starts the service, and log in before starting agent work:

| Harness | Command | Log in |
| --- | --- | --- |
| Claude Code | `claude` | `claude auth login` |
| Codex | `codex` | `codex login` |
| Pi | `pi` | Run `pi`, then `/login` |

Model API credentials belong in your factory's `.env`; see the source-specific
sections below for the variables to set. A workflow such as `hello` that calls
no agent or model needs none of this setup.

## The four verbs

Import them from `#jigs/routines`.

| Verb | Takes | Use it to |
| --- | --- | --- |
| `runAgent` | a harness and a `cwd` | Do work with tools in a directory: read code, run checks, make a change. |
| `askAgent` | Claude Code or Pi, without tools | Get one answer from a harness with no tools and no directory. |
| `askModel` | an OpenRouter or OpenAI-compatible source | Call a model API directly, for summaries and classification. |
| `askJev` | an OpenRouter jev model | Get calibrated probabilities for named yes/no, choice or score questions. |

Each verb takes an optional zod `output` schema (`askJev` returns its own typed
answers). An optional field also accepts `undefined`, so you can pass a value
that may be missing without a conditional spread.

Name each agent a workflow runs in its `requires.agents`, and add each model
source it calls to `requires.models`:

```ts
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
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

## Agent sessions

A workflow often talks to the same agent several times: a builder that writes
code, hears the review, and fixes it. `agentSession` is that agent across
turns. Each `run` resumes the harness session it holds, so the agent remembers
the turns before it.

```ts
interface AgentSession {
  readonly harness: Harness;
  run<T>(turn: { resume: Prompt; fresh: Prompt; output: z.ZodType<T> }): Promise<T>;
  run(turn: { resume: Prompt; fresh: Prompt }): Promise<void>;
}
type Prompt = string | (() => Promise<string>);

function agentSession(options: { name: string; harness: Harness; cwd: string }): AgentSession;
```

A turn states the job twice. `resume` goes to an agent that already holds the
earlier turns, so it carries only what is new. `fresh` goes to an agent starting
from nothing, so it carries everything. Pass a function for either one when
building it costs a step, such as reading a diff: only the prompt that is sent
gets built.

```ts
import { agentSession } from "#jigs/routines";
import { readWorktreeDiff } from "#jigs/steps";

const builderSession = agentSession({
  name: "builder",
  harness: agents.builder,
  cwd: worktree.path,
});

for (let round = 1; round <= 3; round++) {
  const report = await builderSession.run({
    output: implementationReport,
    resume: `The reviewer found:\n${findings}`,
    fresh: async () =>
      `${task}\n\nThe work so far:\n${await readWorktreeDiff(worktree)}\n\n${findings}`,
  });
  // ...
}
```

A harness session can be lost: a restart, a thread the harness no longer has,
a harness you changed between deploys. When that happens `run` sends
`fresh` to a new session and the workflow carries on, instead of failing in
round four. Give an independent reviewer an agent session of its own.

The data that makes a resume possible is a session reference,
`AgentSessionRef`. `runAgent` returns it as `session` and takes it back as
`resume`. You need it only when you call `runAgent` directly; an agent session
keeps its own. It is plain data, which is why an agent session survives
replay: the workflow rebuilds the object on every replay, and the reference
comes back from the recorded steps.

A session reference records the harness it was made on: its kind, and the
whole descriptor. An agent session resumes a reference only on the same
descriptor, compared by value. So a deploy that changes an agent's model or
settings starts that agent fresh on its next turn, rather than resuming a
session another configuration made.

## Harness settings

A Claude Code or Codex descriptor is the provider's own settings, plus the
model. jigs invents no setting names: whatever the provider accepts, and can be
written down as data, you can set.

```ts
type ClaudeHarness = JsonOnly<Omit<ClaudeCodeSettings, ClaudePolicyKey>> & {
  kind: "claude";
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};
type CodexHarness = JsonOnly<Omit<CodexAppServerSettings, CodexPolicyKey>> & {
  kind: "codex";
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
};
```

Each constructor takes one object: the model and any settings. Before this
release the model was a separate first argument:

```ts
// before
harnesses.claude("opus", { effort: "high" });
harnesses.codex("gpt-5.6-sol");

// after
harnesses.claude({ model: "opus", effort: "high" });
harnesses.codex({ model: "gpt-5.6-sol" });
```

The constructors reject a key the descriptor does not have, even when the
object comes from a variable, so pass only descriptor keys.

```ts
harnesses.claude({
  model: "opus",
  effort: "high",
  maxTurns: 40,
  allowedTools: ["Read", "Edit", "Bash"],
  maxBudgetUsd: 5,
  fallbackModel: "sonnet",
});

harnesses.codex({
  model: "gpt-5.6-sol",
  personality: "pragmatic",
  developerInstructions: "Prefer small commits.",
});
```

The provider's type is the list of knobs, so a new provider setting needs no
jigs release. The cost is that a provider renaming a setting becomes a compile
error when you upgrade, the same as any other contract jigs changes.

Two kinds of setting are left out. A setting whose value is a function, such as
a hook, a tool-approval callback or a logger, cannot be written down, and a
descriptor has to be, because a workflow hands it to a step through the
database. And a setting jigs sets itself or holds as policy is a compile error
at the constructor. The drivers also drop those keys at run time and apply
their policy last, so policy always wins. To hand the provider a function,
[write your own agent step](/guide/custom-agent-step).

`mcpServers` keeps jigs' shape on both harnesses: each server names a probe
tool, which jigs calls before the agent starts.

Some kept keys reach outside the worktree. `additionalDirectories` gives Claude
Code more directories to work in. `debugFile` writes the SDK's debug log to a
path of your choosing. Both are allowed because an agent step already runs with
permissions bypassed and can reach the whole filesystem: the isolation boundary
is the environment allowlist, not the filesystem.

## Claude Code

`harnesses.claude({ model, ...settings })` works with `runAgent` and
`askAgent`. It runs the `claude` CLI on the service's `PATH`, or the path in
`JIGS_CLAUDE_EXECUTABLE`, logged in with `claude auth login`. It bills that
account. `askAgent` sends only the model: it always runs without tools, MCP
servers or filesystem settings.

A Claude Code descriptor cannot name these keys (`ClaudePolicyKey`).

`cwd` and `env`. Each step sets the worktree the agent works in and builds its
environment from the allowlist, so a descriptor cannot point it elsewhere or
hand it variables the allowlist would not.

`pathToClaudeCodeExecutable`, `executable` and `executableArgs`. jigs runs the
CLI the service checked at startup, with the launch hook that replaces the
provider's environment. A descriptor that named another program would skip both.

`permissionMode` and `allowDangerouslySkipPermissions`. An agent step runs
unattended in its own worktree, so it always bypasses permission prompts. There
is no one to answer a prompt.

`strictMcpConfig`, `mcpServers` in the provider's shape, and `settingSources`.
The agent sees exactly the MCP servers its descriptor lists, each with a probe
jigs runs first, and loads only the project's settings. Global and user
configuration never leak into a run.

`agents`, `settings` and `plugins`. An inline subagent can declare MCP servers
that strict mode allows and jigs never probes. An extra settings layer, inline
or from a file path, can set environment variables, an API key helper,
permissions and hooks behind the allowlist, and a path hides its contents from
the session reference. A plugin loads hooks and agent definitions from any path
on the host. Subagents, plugins and extra settings come from the repository
through project settings, where the worktree owns them, not from the descriptor.

`resume`, `continue`, `sessionId`, `forkSession`, `persistSession`,
`resumeSessionAt` and `resumeDropsTurn`. The session belongs to the session
reference jigs records and resumes. A descriptor that started, forked or
dropped sessions on its own would make that reference lie.

`extraArgs` and `sdkOptions`. Raw CLI arguments and SDK options can set any of
the above, so allowing them would undo the whole list.

## Codex

`harnesses.codex({ model, ...settings })` works with `runAgent` only. Codex has
no mode without tools, so `askAgent` refuses it. It runs the `codex` CLI on the
service's `PATH`, logged in with `codex login`. The service refuses to start
when that CLI is older than the minimum version it names.

A Codex descriptor cannot name these keys (`CodexPolicyKey`).

`cwd`, `env` and `codexPath`. Each step sets the worktree, builds the
environment from the allowlist, and launches the checked CLI through a launcher
that passes only the allowed variables, from a private home. A descriptor that
named another program or environment would skip all three.

`approvalPolicy`, `sandboxPolicy` and `autoApprove`. An agent step runs
unattended with full access to its worktree. It never waits for an approval
nobody will give, and a narrower sandbox would make tool calls fail quietly.

`threadMode`, `resume` and `persistExtendedHistory`. The thread belongs to the
session reference jigs records and resumes, so a descriptor cannot change how
threads are kept or which one runs.

`mcpServers` in the provider's shape, and `configOverrides`. The agent sees
exactly the MCP servers its descriptor lists, each probed first. Config
overrides can rewrite the sandbox and MCP tables, so allowing them would undo
both.

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
import { models, score, yesNo } from "@jigs-ai/jigs";
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
