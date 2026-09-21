# Models and harnesses

A **model source** is an API endpoint that answers a direct model request. A
**harness** is an agent program jigs spawns; it owns the agent loop and can use
tools, a worktree and a resumable session. Plain serializable descriptors cross
the workflow boundary. Step-side **drivers** own credentials, checks and live
provider objects.

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

OpenRouter is a model source whose API driver is added separately.

## OpenAI-compatible

OpenAI-compatible endpoints are model sources whose API driver is added separately.

## OpenAI Codex

The OpenAI Codex subscription source is used inside the Pi harness and cannot
be passed to `askModel`.
