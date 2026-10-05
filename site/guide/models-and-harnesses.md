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
the answer; `askJev` returns typed decision answers. An answer that fails the
schema is asked for once more with the reasons, in the same harness session when
there is one; a second invalid answer throws the `ZodError`. See the
[routine reference](/api/factory/routines) for exact options and results.

## Requirements and preflight

A workflow declares the agents and model sources it requires. jigs uses those
declarations for preflight checks, catching missing CLIs, credentials and model
endpoints before the run begins:

This complete workflow asks Claude Code to suggest a plan, then asks a direct
model to summarize it. Save it as `workflows/plan/plan.ts` and
[register it in the factory](/guide/build-a-workflow#_3-register-the-workflow).
Authenticate Claude Code and set `OPENROUTER_API_KEY`, then run
`pnpm exec jigs up` and `pnpm exec jigs run plan --input task="Add draft autosave"`.

```ts
// workflows/plan/plan.ts
import { defineWorkflow, harnesses, models, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { askAgent, askModel } from "#jigs/routines";

const inputs = z.object({ task: z.string().min(1) });
const agents = { planner: harnesses.claude({ model: "opus" }) };
const summarizer = models.openrouter("google/gemini-2.5-flash-lite");

export async function plan(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const proposal = await askAgent({
    harness: agents.planner,
    prompt: `Suggest an implementation plan for: ${input.task}`,
  });
  const summary = await askModel({
    model: summarizer,
    prompt: `Summarize this plan in three bullet points:\n${proposal.text}`,
  });
  return summary.text;
}

export default defineWorkflow({
  inputs,
  requires: { agents, models: [summarizer] },
  workflow: plan,
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

This workflow provisions a worktree, implements the input task, gets a review
from a second agent, then resumes the builder with that review. It assumes an
`app` [repository binding](/guide/build-a-workflow#_1-connect-a-repository), plus
Codex and Claude Code authentication. Register it as `build` in the factory,
then run `pnpm exec jigs up` and
`pnpm exec jigs run build --input task="Add a regression test for saving a draft twice"`.
The example commits locally and returns the worktree path, review and final
diff. It leaves publishing to you. Its `release` policy keeps the worktree after
the run so you can inspect the result; see
[`release`](/guide/configuration#release) for cleanup options.

```ts
// workflows/build/build.ts
import { defineWorkflow, harnesses, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { agentSession, runAgent } from "#jigs/routines";
import { provisionWorktree, readWorktreeDiff } from "#jigs/steps";

const inputs = z.object({ task: z.string().min(1) });
const agents = {
  builder: harnesses.codex({ model: "gpt-5.6-sol" }),
  reviewer: harnesses.claude({ model: "opus" }),
};

export async function build(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const worktree = await provisionWorktree({
    binding: "app",
    branch: `build/${input.triggerId}`,
  });
  const task = `Implement this task, run checks, and commit the changes locally: ${input.task}`;
  const builder = agentSession({
    name: "builder",
    harness: agents.builder,
    cwd: worktree.path,
  });

  await builder.run({ resume: task, fresh: task });
  const review = await runAgent({
    harness: agents.reviewer,
    cwd: worktree.path,
    prompt: `Review commits since ${worktree.baseSha} for this task. Do not edit files.\n${input.task}`,
  });
  await builder.run({
    resume: `Address this review, run checks, and commit any changes locally: ${review.text}`,
    fresh: async () =>
      `${task}\nCurrent changes: ${await readWorktreeDiff(worktree)}\nReview: ${review.text}`,
  });
  return { path: worktree.path, review: review.text, diff: await readWorktreeDiff(worktree) };
}

export default defineWorkflow({
  inputs,
  requires: { agents, bindings: ["app"] },
  release: { onSuccess: "keep", onFailure: "keep" },
  workflow: build,
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
import { harnesses } from "@jigs-ai/jigs";

harnesses.claude({ model: "opus", effort: "high" });
harnesses.codex({ model: "gpt-5.6-sol", personality: "pragmatic" });
```

Descriptors cross the durable workflow/step boundary, so they must be data.
jigs owns the working directory, environment, permissions and session lifecycle
to keep execution consistent. Use TypeScript autocomplete and the
[harness types](/api/jigs#harnesses-and-models) for the exact settings. Provider
callbacks or live objects belong inside a [custom agent step](/guide/custom-agent-step).

## MCP servers

Give a `runAgent` harness MCP servers with `mcpServers`. The servers you list
are all the agent sees: jigs ignores user, project and plugin MCP configuration
for every harness. Each server names a `probe` tool, which the step calls
before the agent starts to prove the server works. `jigs doctor` also calls
the probe of every server an agent in `requires.agents` declares, so a bad
token shows up at `jigs up` rather than mid-run. Doctor starts a stdio server
from the factory root, since there is no worktree yet.

Credentials never go in workflow code. An `env` entry, a header and
`bearerTokenEnv` each name a variable in the factory's
[`.env`](/guide/configuration#env), and the step reads its value when it starts
the agent:

```ts
import { harnesses } from "@jigs-ai/jigs";

harnesses.claude({
  model: "opus",
  mcpServers: {
    docs: {
      url: "https://mcp.example.com/mcp",
      bearerTokenEnv: "DOCS_MCP_TOKEN", // sent as Authorization: Bearer <value>
      headers: { "X-Org": "DOCS_MCP_ORG" },
      probe: { tool: "search" },
    },
  },
});
```

Names use uppercase letters, digits and underscores. The agent gets the
variables its servers name, so they need no
[`agents.env`](/guide/configuration#agents-env) entry. If one is not set, the
step fails before the agent starts and names the variable. For a server
declared in `requires.agents`, `jigs doctor` reports it first; a server built
in the workflow body is checked only when its agent starts. A Pi server also
lists the `tools` the model may call.

The named variables are in the agent's own environment, so an agent with shell
access can read them. Give agents least-privilege tokens, such as a read-only
PagerDuty key for a triage agent.

## Skills

Give an agent skills with `skills`: a list of skill folders, each holding a
`SKILL.md` and any reference files it points to. Every harness takes it. Paths
are relative to the factory root; an absolute path also works.

```ts
import { harnesses, models } from "@jigs-ai/jigs";

harnesses.claude({ model: "opus", skills: ["skills/snowflake"] });
harnesses.codex({ model: "gpt-5.6-sol", skills: ["skills/snowflake"] });
harnesses.pi(models.openaiCodex("gpt-5.5"), { skills: ["skills/snowflake"] });
```

jigs copies the folders into a private place for each agent call, whether
through `runAgent` or a [custom agent step](/guide/custom-agent-step), so the
skills reach the agent whatever its working directory, a run directory or a
worktree, and nothing the agent writes there reaches the factory. Each folder
is copied under its own name, so two declared folders cannot share one; keep it
the same as the `name` in its `SKILL.md`. `askAgent` loads no skills.

On Claude Code the skills load as a plugin and appear under the `jigs-skills:`
prefix, such as `jigs-skills:snowflake`. They add to the repository's own
`.claude/skills` rather than replacing them. A Claude `tools` list must include
`Skill` for the agent to use them. The plugin is removed when the agent call
ends; one left behind by a service that stopped mid-call is the run's
`claude-plugins` resource, which release or `jigs resources prune` removes.
Pi offers skills only to an agent that has its `read` or `bash` tool, so a Pi
`tools` list needs one of them.

A folder that is missing or has no `SKILL.md` fails preflight before the run
starts, and `jigs doctor` reports it for every agent in `requires.agents`. A
harness built in the workflow body is checked when its agent starts.

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
import { models } from "@jigs-ai/jigs";

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

The following helper belongs in a workflow module. Call
`await classifyReport(input.report)` inside a `"use workflow"` function whose
input schema has a `report` string, and include the exported `decisionModel`
in that workflow's `requires.models`. Set `OPENROUTER_API_KEY` in `.env`.

```ts
import { models, yesNo } from "@jigs-ai/jigs";
import { askJev } from "#jigs/routines";

export const decisionModel = models.openrouter("typesafe/jev-1.13");

export async function classifyReport(report: string) {
  return askJev({
    model: decisionModel,
    state: { report },
    questions: { dataLoss: yesNo("Does this report describe lost user data?") },
  });
}
```

See [decision types](/api/jigs#decision-models) for choice and score questions.

## Agent environment

Agents do not automatically inherit the service environment. Add additional
variable names through [`agents.env`](/guide/configuration#agents-env). This
controls environment variables only: agent processes run as your user and can
access the files your user can access.

## GitHub access for agents {#github-access}

With its [GitHub App](/guide/configuration#github-identity), jigs acts
on GitHub as one bot, `<app-slug>[bot]`. An agent can act as the same bot: set
`github: true` on its harness.

```ts
import { harnesses } from "@jigs-ai/jigs";

harnesses.codex({ model: "gpt-5.6-sol", github: true });
```

jigs uses the bot to open, label and merge pull requests and to post its notes.
An agent that opts in uses it to read the discussion, reply and push its fixes.
When such an agent starts, jigs gives it:

- **`GH_TOKEN`**, a new token for the App's installation on the account that
  owns the agent's worktree. `gh` picks it up, so `gh` works as the bot with no
  login of its own.
- **HTTPS for that account's repositories.** Git settings in the agent's
  environment send its fetches and pushes for that account's repositories over
  HTTPS with the token, even where the remote is an SSH URL. Repositories of
  other accounts, such as a dependency fetched over SSH, keep their own
  transport and never see the token. Nothing is written to the repository's
  configuration.
- **The bot as commit author.** You stay the committer, and your own git
  configuration still signs, so signed commits still show as Verified.

The token lasts an hour and is not renewed during a turn: a turn longer than
that loses GitHub access, and the next turn gets a new token. For an agent with
no worktree, name the account: `github: { owner: "acme" }`. An agent step acts
on one account.

The token carries all of the App's permissions on that installation, so it
could merge a pull request. Prompts can tell an agent not to merge, but what
stops it is [branch protection](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
on the branches you merge into. Under `approvalCovers: "any-commit"`, jigs
ignores approvals from bots, so an agent cannot approve its own work.

The agent still runs as your user on your machine. It can read any file you
can, your SSH keys and other credentials included: the token limits what the
agent does as itself, not what it could find on disk.

Install the [GitHub CLI](https://cli.github.com); `jigs doctor` checks for it.

### GitHub's MCP server

`githubMcp()` adds GitHub's own MCP server, acting as the same bot. It is
optional, and only a harness that sets `github` can use it:

```ts
import { githubMcp, harnesses } from "@jigs-ai/jigs";

harnesses.claude({ model: "opus", github: true, mcpServers: { github: githubMcp() } });
```

It runs the local
[`github-mcp-server`](https://github.com/github/github-mcp-server), which you
install yourself; `jigs doctor` checks for it. Tools that need a user, such as
`get_me`, are left out, since an App cannot answer them. For Pi, pass the tools
the model may call: `githubMcp({ tools: ["pull_request_read", "add_issue_comment"] })`.

## Linear and PagerDuty access for agents {#provider-access}

An agent can also act as the factory on Linear and PagerDuty: set `linear: true`
or `pagerduty: true` on its harness. When it starts, jigs puts the factory's own
token in its environment:

- **`JIGS_LINEAR_TOKEN`** holds a token of the factory's
  [Linear app](/guide/configuration#linear-identity), from the hub, so the agent
  acts as that app.
- **`JIGS_PAGERDUTY_TOKEN`** holds a token for the factory's
  [PagerDuty](/guide/configuration#pagerduty) OAuth app, with the scopes jigs
  itself uses: the agent can read and update incidents and read users.

A run whose workflow declares such an agent checks that identity in preflight,
as it would for a workflow that requires the provider.

`linearMcp()` and `pagerdutyMcp()` add each service's own hosted MCP server
with that token. Only a harness that opts in can use them:

```ts
import { harnesses, linearMcp, pagerdutyMcp } from "@jigs-ai/jigs";

harnesses.claude({
  model: "opus",
  linear: true,
  pagerduty: true,
  mcpServers: { linear: linearMcp(), pagerduty: pagerdutyMcp() },
});
```

For Pi, pass the tools the model may call, as with `githubMcp`. Each result is
plain data, so spread it to change a field. A PagerDuty account in the EU
service region uses PagerDuty's EU server:

```ts
import { harnesses, pagerdutyMcp } from "@jigs-ai/jigs";

harnesses.codex({
  model: "gpt-5.6-sol",
  pagerduty: true,
  mcpServers: { pagerduty: { ...pagerdutyMcp(), url: "https://mcp.eu.pagerduty.com/mcp" } },
});
```

Linear's `https://mcp.linear.app/mcp/readonly` offers read tools only.

A server's `disabledTools` lists tools the model may not call; Pi uses its
`tools` list instead. `pagerdutyMcp()` disables `get_user_data`, which needs a
user, while the factory's token belongs to an app. For the same reason
`list_incidents` cannot filter by the `assigned` or `teams` request scope, and
tools outside jigs' scopes, such as schedules and services, fail when called.
`jigs doctor` does not check these servers, since it has no agent token; the
agent's step probes each one with the token before the agent starts.
