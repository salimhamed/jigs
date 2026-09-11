# Adopt the Vercel Workflow SDK as the execution runtime

> **Amended by [ADR 0012](./0012-per-factory-service.md).** There is no single
> global service: each factory repo builds and runs its own, against its own
> Postgres World, supervised by `jigs service` through a pidfile rather than a
> systemd user unit. The Nitro build moves with it — the factory compiles its
> own pipelines with its own install. Everything else here stands.

jigs does not build its own durable-execution runtime: pipelines run on
Vercel's Workflow SDK (`workflow`), with the self-hosted Postgres World
(`@workflow/world-postgres`) as store and queue. ADR 0003's programming model
carries over nearly verbatim — `"use workflow"` is the pipeline body,
`"use step"` the steps, `createHook()`/`resumeHook()` the suspension with the
token as its satisfier — so adoption swaps the runtime underneath a mostly
unchanged authoring surface. Decided by prototype
([AGE-304](https://linear.app/salboogie/issue/AGE-304/durable-execution-runtime-build-or-adopt-workflow-sdk),
branch `prototype/workflow-runtime`; the ticket's comments hold the full
evidence ledger).

Every acceptance criterion passed: kill-mid-suspension → restart →
`resumeHook` → completion with memoized replay (the pre-kill step result
survived verbatim); kill mid-step recovers via startup rescue by re-running
the step from zero, which is exactly the crash model jigs had planned to
build for itself, delivered instead of built; a 600-second in-process step with no timeout; the workflow/step
serialization boundary enforced with precise errors; a subscription-authed
Claude Code agent step (no API key in the environment) writing to a cwd-scoped
workspace with per-step token usage captured in the durable run result; and
`npx workflow web` closing the run-observability gap off the shelf.

## Consequences

- **Replaces the runtime jigs was going to build for itself.** No jigs-owned
  sqlite store, process-per-activation worker, or stateless poller. The goals
  stand — detachable runs, idle-run-as-pure-disk-state, crash = re-run the
  step from zero — now delivered by the SDK. A long-lived server (systemd user
  unit) hosts execution; Postgres in docker is standing infrastructure.
- **Amends ADR 0001.** The CLI is no longer the execution owner: a service
  owns execution and the CLI becomes its HTTP client. Pipelines are compiled
  artifacts (Nitro build) rather than modules invoked by path.
- **Step config is plain data, enforced.** Nothing live crosses the
  workflow/step boundary; harness and model objects are hydrated inside the
  step from serializable config. This hardens AGE-289's reversed config shape
  from convention into a runtime guarantee.
- **Hook tokens are a global namespace per backend**: two active hooks cannot
  share a token (the second run fails outright), so jigs scopes tokens by run
  ULID, never by ticket id alone. *Superseded by ADR 0009: tokens are
  resource-scoped (`github:pr:…`, `linear:ticket:<uuid>`) and the collision
  is the exclusivity lock — one active run per external resource, failing
  loudly with the owner named.*
- ADR 0007's worktree lifecycle stands unchanged; only the teardown hook's
  placement moves into SDK-run steps.

## Considered options

- **Build the runtime** (sqlite + Drizzle, process-per-activation, poller):
  rejected after the prototype. It re-implements memoization, event-log
  persistence, crash rescue, retries, cancellation, and an observability UI
  the SDK ships tested — to save one docker container and a build system.

## Known costs, accepted with eyes open

- A mandatory build system (Nitro + rollup). Its bundling severed the Claude
  Agent SDK from its vendored CLI binary (fixed by pointing
  `pathToClaudeCodeExecutable` at the system `claude`, which jigs would use
  anyway); dev-server hot reload occasionally needs a clean restart.
- Early-adopter surface (`workflow@4.8.4`): a run whose workflow-level
  argument capture fails serialization never reaches a terminal state (stays
  `running`, re-enqueued on every restart); serialization failures are
  retried although they can never succeed; docs drift on the Nitro plugin
  import path.
