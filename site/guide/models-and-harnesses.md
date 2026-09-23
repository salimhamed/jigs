# Models and harnesses

A **model source** is an API endpoint that answers a direct model request. A
**harness** is an agent program jigs spawns; it owns the agent loop and can use
tools, a worktree and a resumable session. Plain serializable descriptors cross
the workflow boundary. Step-side **drivers** own credentials, checks and live
provider objects.

The execution API has four verbs:

- `runAgent` runs a harness in a working directory.
- `askAgent` asks Claude Code or Pi for one answer without tools or a working
  directory.
- `askModel` calls a model source API directly.
- `askJev` judges, evaluates or verifies an artifact through a model source.

The verbs check their descriptors in TypeScript and again when the call runs,
before any model, credential or MCP check. `askAgent` accepts only a harness that
names no tools: a Claude Code or Pi descriptor without `mcpServers`, and a Pi
descriptor without `tools`.

## Harness environment

A harness does not inherit the service environment. jigs builds each harness
process's environment from empty, out of three parts:

- A base set every harness gets when the service has it: `PATH`, `HOME`,
  `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`,
  `TMPDIR`, the XDG base directories (`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`), the proxy variables
  (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase forms) and
  `SSL_CERT_FILE`, `SSL_CERT_DIR` and `NODE_EXTRA_CA_CERTS`.
- The variables the harness's driver needs, such as `CLAUDE_CONFIG_DIR` for
  Claude Code and the variables a Pi model source or MCP server names.
- The names your factory declares in `jigs.config.ts`.

Everything else is left out, whatever it is called. A database URL with a
password in it, a private key, or `WORKFLOW_POSTGRES_URL` never reaches an
agent unless you declare it. To give every agent a variable, list its name:

```ts
export default defineFactory({
  // ...
  agents: { env: ["SSH_AUTH_SOCK", "MISE_DATA_DIR"] },
});
```

The list holds names only; values stay in the service environment and are read
when an agent starts. Declare anything your machine needs that the base set
does not cover, such as a tool manager's variables or an SSH agent socket.

This protects the environment only. Agents run as your user and can still read
any file your user can, including `.env` files and credential files on disk.

## Claude Code

Use `harnesses.claude(model, options)` with `runAgent` or `askAgent`. An
`askAgent` call turns off Claude Code's built-in tools and loads no MCP servers
or settings files.

## Codex

Use `harnesses.codex(model, options)` with `runAgent`. `askAgent` rejects Codex
because Codex has no mode without tools: even its read-only sandbox can still run
commands and read files. Use Claude Code or Pi for a tool-free ask.

## Pi

Use `harnesses.pi(model, options)` with `runAgent` or `askAgent`. The first
argument is a model source such as
`models.openaiCodex("gpt-5.5")`, `models.openrouter("...")`, or
`models.openaiCompatible({ ... })`. `options.thinking` selects Pi's thinking
level. For `runAgent`, omit `options.tools` to use Pi's default tools or provide
an allowlist such as `{ tools: ["read", "bash"] }`. `askAgent` runs Pi with no
tools, so it rejects a descriptor with `tools` or `mcpServers`.

For an OpenAI-compatible source, `options.compat.supportsDeveloperRole` and
`options.compat.supportsReasoningEffort` describe server capabilities that Pi
cannot discover. Both default to `false`. These hints are written only to Pi's
managed `models.json`; direct `askModel` descriptors do not accept them.

Each call gets its own temporary Pi home, so parallel calls never share
settings, schemas or MCP servers; ask mode also gets a scratch working
directory. jigs disables Pi's settings, package, prompt, theme, session and
extension discovery, then loads only the extensions it writes for that call:
`submit_result` for structured output and, for a run with `mcpServers`, the MCP
adapter. Existing files outside that invocation home are not discovered. OpenAI
Codex subscription calls use a symlink to Pi's normal login at
`~/.pi/agent/auth.json`; run `pi`, choose `/login`, then select OpenAI Codex
before using that source.

Descriptors hold environment variable names, never secret values. OpenRouter
and credentialed OpenAI-compatible sources read the variable named by their
model descriptor. Pi gets that variable and the ones its MCP servers name on
top of the [harness environment](#harness-environment).

For `runAgent`, `options.mcpServers` is the complete MCP universe. Pi never
reads your global MCP file, `.mcp.json` or `.pi/mcp.json`; to use a server
defined there, copy its definition into the descriptor. Each server lists the
`tools` the model may call and a `probe` tool from that list. Stdio `env` and
HTTP `headers` map a name to the environment variable that holds its value, so
`env: { TOKEN: "TEAM_MCP_TOKEN" }` passes the value of `TEAM_MCP_TOKEN` as
`TOKEN`, and `bearerTokenEnv` names the variable that holds a bearer token. A
stdio server starts with only its declared variables plus the MCP SDK's
defaults (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`), so it never
sees Pi's model key or another server's credentials. `auth: "oauth"` uses a
login `pi-mcp-adapter` already holds; jigs never starts a login flow. Before
launching Pi, jigs calls each server's probe tool, except OAuth servers, which
are first exercised by the run itself.

Pi's own request retries stay on, and jigs adds no retry loop of its own. A call
succeeds only when Pi settles on a successful final response and exits
normally: a run that settles on an error, is aborted, crashes or emits
truncated output fails. jigs reports no token usage or cost for Pi calls.

`runAgent` runs Pi in the supplied worktree and stores its session in the
run-scoped durable session store. The returned session pointer can be passed back as
`resume`; jigs verifies that its real session file still exists before spawning
Pi. A missing session takes the normal `resumeOrRebuild` fresh-context path.
Any other failure in a resumed turn, including a model error, fails the call
and never falls back to a fresh context.
That session store is removed when the run's worktrees are
released, so they are not long-term conversation storage.

Structured output goes through one `submit_result` tool that jigs writes for the
call. A structured `askAgent` call allows only that tool; a structured `runAgent`
call adds it to your `tools` allowlist. The tool checks the model's arguments
against the requested schema, and the call fails if Pi finishes without an
accepted `submit_result`, including when the reply is JSON text. The first
accepted result stands: the tool rejects any later call. A model or
process failure after `submit_result` still fails the call. Pi uses constrained
JSON Schema sampling where the provider supports it. A call without `output` loads
no `submit_result` tool and returns plain text.

Pi 0.85.1 or newer must be available on the service's `PATH`; jigs is tested
with Pi 0.87.0. Install it with
`npm install --global @earendil-works/pi-coding-agent`. `jigs doctor` can check
the Pi executable, but model and authentication checks happen at the call site
because the nested model source is workflow configuration.

## OpenRouter

Use `models.openrouter(model)` with `askModel`. Set `OPENROUTER_API_KEY` in the
factory repo's `.env`, then restart the service. A different variable can be
named with `models.openrouter(model, { apiKeyEnv: "TEAM_OPENROUTER_KEY" })`;
the descriptor records only that variable name, never its value.

Direct model calls use strict JSON Schema structured output. OpenRouter models
that do not support `structured_outputs` fail the call; use the
[structured-output model filter](https://openrouter.ai/models?supported_parameters=structured_outputs)
before selecting one.

## Jev decisions

`askJev` asks an OpenRouter jev-class decision model named questions about one
shared state. Unlike `askModel`, it sends no prompt and returns no prose. Each
answer carries calibrated probabilities:

- `yesNo(instructions)` returns `{ probability }`.
- `choice(instructions, options)` returns the selected choice, a probability for
  every option, and confidence.
- `score(instructions, levels)` returns probabilities, confidence, a level
  legend, and a numeric score. The score is the probability-weighted expected
  value over the ordered level indexes, so it can be fractional.

Use `models.openrouter("typesafe/jev-1.13")`.

Entity alignment belongs in factory workflow code because its fields,
candidates, and action thresholds are business policy. For example, a factory
can ask one score question for a candidate pair and add field-specific checks:

```ts
import { models, score, yesNo } from "@salimhamed/jigs/blocks/agents";
import { askJev } from "#jigs";

const state = {
  crm: { name: "Acme Labs", domain: "acme.example" },
  billing: { name: "Acme Labs LLC", domain: "acme.example" },
};

const result = await askJev({
  model: models.openrouter("typesafe/jev-1.13"),
  state,
  questions: {
    candidatePair: score("How closely do these records align?", [
      "Different companies",
      "Possibly the same company",
      "The same company",
    ]),
    nameMatches: yesNo("Do the company names refer to the same entity?"),
    domainMatches: yesNo("Do the domains refer to the same entity?"),
  },
});
```

For several billing candidates, create one score question per candidate pair.
The workflow decides how much probability is enough to link records or request
human review; jigs supplies the typed answers, not that policy.

## OpenAI-compatible

Use `models.openaiCompatible({ name, baseUrl, model, apiKeyEnv? })` with
`askModel`. `baseUrl` must be the server's full OpenAI-compatible API base,
including `/v1`, and `model` must be the id returned by its `/models` endpoint.
`name` labels the provider in AI SDK messages and jigs diagnostics; it does not
select a model.

Most local servers need no credential. If the server requires a bearer token,
set it in the factory repo's `.env` and name its variable with `apiKeyEnv`; the
descriptor stores only the variable name.

Structured output uses the same strict `response_format` and zod parse as other
direct model calls. If a server ignores `response_format`, the zod parse fails;
that is the correct failure rather than accepting an unvalidated answer.

`jigs doctor` skips OpenAI-compatible sources because they are configured at the
call site and doctor has no workflow request from which to learn their URL.
Before every trigger, preflight makes a live request to `<baseUrl>/models` for
each declared OpenAI-compatible source and confirms the configured model is
served.

The live test reads `JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL` and
`JIGS_TEST_OPENAI_COMPATIBLE_MODEL`. It skips when either is unset or the endpoint
is unreachable.

## OpenAI Codex

The OpenAI Codex subscription source is used inside the Pi harness and cannot
be passed to `askModel`.
