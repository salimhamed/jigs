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

Pi is a harness whose driver is added separately.

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

OpenAI-compatible endpoints are model sources whose API driver is added separately.

## OpenAI Codex

The OpenAI Codex subscription source is used inside the Pi harness and cannot
be passed to `askModel`.
