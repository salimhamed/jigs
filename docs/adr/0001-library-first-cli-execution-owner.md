# Library-first package, CLI as the single execution owner

> **Amended by [ADR 0008](./0008-adopt-workflow-sdk-runtime.md).** The CLI
> is no longer the execution owner: the Workflow SDK service owns execution
> and the CLI becomes its HTTP client. Pipelines are compiled artifacts
> rather than modules invoked by path. Library-first packaging and the
> `jigs/harnesses` pin point stand.
>
> _Note (AGE-306):_ the repo is a pnpm workspace since the runtime-service
> skeleton landed — `jigs` remains the library-first package (now at
> `packages/jigs`), and the ADR 0008 service lives beside it as the private
> workspace package `@jigs/service`. Library-first packaging stands
> unchanged.

> **Amended by [ADR 0004](./0004-cli-providers-drive-harnesses.md).** The
> `@ai-sdk/harness` choice referenced below no longer holds: the community
> CLI providers (`ai-sdk-provider-claude-code`, `ai-sdk-provider-codex-cli`)
> drive the harnesses. `jigs/harnesses` stays the single pin point, now
> wrapping those providers.

> **Amended by [ADR 0003](./0003-durable-imperative-pipelines.md).** The
> phrase "builds a DAG imperatively and default-exports it" below no longer
> describes the model: a pipeline default-exports an async body the runtime
> calls, and there is no exported graph. Everything else here stands —
> library-first, the CLI as single execution owner, definitions as config
> modules that never launch themselves, the factory repo, the zod `inputs`
> contract, and `jigs/harnesses` as the single pin point.

jigs is a library-first ESM package with a thin CLI. The composable constructs
(pipeline, jig, step, gate) are the public TypeScript API; the CLI owns the
operational verbs (`run`, `ps`, `attach`, preflight) and is the only supported
entry point in v0. A pipeline definition is a plain-TypeScript **config
module** — it builds a DAG imperatively and default-exports it — but never
launches itself: the jigs runtime alone loads and executes pipelines, because
runs must be detachable, resumable after days idle, and preflight-gated, and
none of that can be guaranteed if users execute arbitrary programs themselves.

Definitions live in a central git-tracked **factory repo** (not in target
repos, keeping repo onboarding near-zero; not in `~/.jigs`, so they're
versioned and reviewable). Pipelines declare a zod `inputs` schema that doubles
as the CLI's `--input` contract. Structure is TypeScript; agent-facing text
(prompts, rubrics) is markdown loaded with inert `{{KEY}}` interpolation.

## Considered options

- **Program model** (pipeline file executed directly, as sandcastle does with
  `npx tsx main.ts`): rejected because a run would live only as long as the
  user's process. Sandcastle's own author needed a separate supervisor daemon
  for the detached half — the layer jigs *is*.
- **Adopting sandcastle** (`~/Code/Reference/sandcastle/sandcastle`) as the
  worktree/agent layer: rejected — container-centric, merge-to-head branch
  model differs from our PR flow, and `@ai-sdk/harness` was chosen for
  per-step harness/model/MCP/skills selection. Its patterns are adopted as
  prior art; its code is not a dependency.
- **Direct `@ai-sdk/harness-*` imports in the factory repo**: rejected — the
  family is experimental with exact-version lockstep coupling, so jigs
  re-exports the factories verbatim (`jigs/harnesses`) and remains the single
  pin point.

## Consequences

- Repo binding attaches to the **step**, never the run — v0 is single-repo,
  but multi-repo feature DAGs later become pure composition, no redesign.
- The programmatic API (`launch()` etc.) exists by construction under the CLI
  but is not public contract in v0.
- Pipeline definitions must stay cheap for *agents* to author, not just
  humans — a standing constraint on the construct model.
