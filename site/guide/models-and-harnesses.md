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

Use `harnesses.pi(model, options)` with `runAgent` or `askAgent`. The first
argument is a model source such as
`models.openaiCodex("gpt-5.5")`, `models.openrouter("...")`, or
`models.openaiCompatible({ ... })`. `options.thinking` selects Pi's thinking
level. For `runAgent`, omit `options.tools` to use Pi's default tools or provide
an allowlist such as `{ tools: ["read", "bash"] }`. Ask mode always disables
tools. MCP servers are not accepted.

For an OpenAI-compatible source, `options.compat.supportsDeveloperRole` and
`options.compat.supportsReasoningEffort` describe server capabilities that Pi
cannot discover. Both default to `false`. These hints are written only to Pi's
managed `models.json`; direct `askModel` descriptors do not accept them.

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
