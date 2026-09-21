# Models and harnesses

A **model source** is an API endpoint that answers a direct model request. A
**harness** is an agent program jigs spawns; it owns the agent loop and can use
tools, a worktree and a resumable session. Plain serializable descriptors cross
the workflow boundary. Step-side **drivers** own credentials, checks and live
provider objects.

Results include an optional `usage.costUsd` estimate from the driver that ran
the call. It is the driver's estimate, not a bill: Claude Code reports real USD
billing, Pi computes a notional amount from its model catalog for a subscription,
and a local server has no cost.

The execution API has four verbs:

- `runAgent` runs a harness in a working directory.
- `askAgent` asks a harness without tools or a working directory.
- `askModel` calls a model source API directly.
- `askJev` judges, evaluates or verifies an artifact through a model source.

## Claude Code

Use `harnesses.claude(model, options)` with `runAgent` or `askAgent`.

## Codex

Use `harnesses.codex(model, options)` with `runAgent` or `askAgent`.

## Pi

Use `harnesses.pi(model, options)` with `runAgent` or `askAgent`. The first
argument is a model source such as
`models.openaiCodex("gpt-5.5")`, `models.openrouter("...")`, or
`models.openaiCompatible({ ... })`. `options.thinking` selects Pi's thinking
level. For `runAgent`, omit `options.tools` to use Pi's default tools or provide
an allowlist such as `{ tools: ["read", "bash"] }`. Ask mode always disables
tools. MCP servers are not accepted.

Each call gets a curated Pi home; ask mode also gets a scratch working directory.
Jigs disables
Pi's settings, package, prompt, theme, session, and extension discovery, then
loads only its `submit_result` extension for structured output. Existing files
outside that managed home are not discovered. OpenAI Codex subscription calls
use a symlink to Pi's normal login at `~/.pi/agent/auth.json`; run `pi`, choose
`/login`, then select OpenAI Codex before using that source. OpenRouter and
credentialed OpenAI-compatible sources use the environment variable named by
their model descriptor.

`runAgent` runs Pi in the supplied worktree and stores its session in the
run-scoped managed home. The returned session pointer can be passed back as
`resume`; jigs verifies that its real session file still exists before spawning
Pi. A missing session takes the normal `resumeOrRebuild` fresh-context path.
The managed home and its sessions are removed when the run's worktrees are
released, so they are not long-term conversation storage.

Structured output first asks Pi to call `submit_result` with constrained JSON
Schema sampling. If a compatible server completes without that tool call, Jigs
parses the returned JSON and applies the workflow's normal zod validation.
Pi's reported usage and catalog cost are retained in the result.

Pi 0.85.1 or newer must be available on the service's `PATH`. Install it with
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

When OpenRouter returns usage accounting, jigs records its reported cost in
`result.usage.costUsd`. This is an estimate from OpenRouter, not a bill, and may
be absent when the selected endpoint does not return cost metadata.

## OpenAI-compatible

Use `models.openaiCompatible({ name, baseUrl, model, apiKeyEnv?, compat? })` with
`askModel`. `baseUrl` must be the server's full OpenAI-compatible API base,
including `/v1`, and `model` must be the id returned by its `/models` endpoint.
`name` labels the provider in AI SDK messages and jigs diagnostics; it does not
select a model.

Most local servers need no credential. If the server requires a bearer token,
set it in the factory repo's `.env` and name its variable with `apiKeyEnv`; the
descriptor stores only the variable name. `compat.supportsDeveloperRole` and
`compat.supportsReasoningEffort` describe capabilities the server cannot report.
Both default to `false`.

Structured output uses the same strict `response_format` and zod parse as other
direct model calls. If a server ignores `response_format`, the zod parse fails;
that is the correct failure rather than accepting an unvalidated answer. A local
server has no cost, so its result has no `usage.costUsd`.

`jigs doctor` skips OpenAI-compatible sources because they are configured at the
call site and doctor has no workflow request from which to learn their URL.
When a workflow runs, the source check probes `<baseUrl>/models` and confirms the
configured model is served.

The live test reads `JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL` and
`JIGS_TEST_OPENAI_COMPATIBLE_MODEL`. It skips when either is unset or the endpoint
is unreachable.

## OpenAI Codex

The OpenAI Codex subscription source is used inside the Pi harness and cannot
be passed to `askModel`.
