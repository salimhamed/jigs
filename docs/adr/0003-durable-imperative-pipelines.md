# Durable-imperative pipelines with three step kinds

A pipeline is an `async` function the jigs runtime **calls**, not a graph the
pipeline builds and exports. Steps are awaited; their results are recorded in
run state under an author-supplied **key**. Resume re-invokes the body from the
top, and every already-recorded step returns its recorded result instead of
running again, so no agent invocation ever repeats. Control flow is therefore
plain TypeScript: branching is `if`, a review cycle is `for`, and a circuit
breaker is that loop's bound.

jigs ships two step builders and no control-flow constructs:

- **`agent()`** — a harness-backed coding agent. Requires a worktree.
- **`ask()`** — a plain AI SDK model call. No worktree, no repo binding.

Plain TypeScript steps are the runtime's own `"use step"` functions (ADR 0013);
the `fn()` wrapper that dressed one as a step result is gone. Both take `(key,
config)`. Harness-specific options (`model`, `mcpServers`) are written inside
the harness factory call, which jigs re-exports verbatim; framework-level
options (`skills`, `output`) sit on the step. A step declaring a zod `output`
schema returns the parsed object typed; every step returns a uniform
`StepResult` of `{ text, output, usage }`.

A run suspends through exactly two named primitives — `pullRequestGate()` and
`needsHuman()` — which share one run-state record of `{ key, reason, payload,
satisfiedBy }` and differ only in what satisfies them. There is no generic
gate: **no suspension without a satisfier**, because a run that idles with
nothing able to wake it is the worst failure a detachable runtime has. A
suspended run is not terminal, so it holds its worktree.

Worktrees are **requested**, not owned: `worktree()` asks the runtime to make
one and remember it, and the runtime tears every one down on a terminal state.
Authors never write teardown, because author-managed cleanup cannot work here —
the natural `try/finally` fires on suspension too, destroying a worktree the
run still needs.

Preflight reads a declared `requires` manifest of `{ bindings, harnesses }`;
per-step checks still run just-in-time, before a step burns a turn.

## Considered options

- **Static DAG** (`build()` returns a graph of node descriptors the runtime
  walks): rejected. Expressing verdict-branching, review cycles, and circuit
  breakers needs `chain`, `branch`, `cycle`, `halt`, and node-reference
  plumbing like `review.out("brief")` — five constructs and a bespoke
  data-flow model to say what `if`, `for`, and a local variable already say.
  Against the standing constraint that pipelines stay cheap for *agents* to
  author, a graph DSL is strictly worse than ordinary TypeScript.
- **Vercel Workflow SDK** (`"use workflow"` / `"use step"`): a genuine match —
  it implements this exact programming model, and supplies step memoization,
  a sandboxed determinism guarantee, hooks, retries, cancellation, and an
  observability UI. Deferred to a backlog spike rather than adopted, because
  v0 is one machine, one user, one run at a time: it would import a build
  system (Nitro/rollup), Postgres, and a long-lived service to coordinate a
  queue with no contention, and would make pipelines compiled artifacts rather
  than modules invoked by path. Because jigs' model is the same, migrating
  later is renaming builders and deleting a runtime, not redesigning
  pipelines.
- **Positional step keys** (runtime auto-suffixes repeat calls): rejected in
  favour of explicit keys. Positional identity depends on call *order*, which
  would have required runtime replay-divergence detection to be safe.
  Name-keyed lookup makes resume order-insensitive instead.
- **Structured output by transcript convention or a coercion model**:
  rejected. Claude Code and Codex both honor a JSON schema natively; Pi throws
  `HarnessCapabilityUnsupportedError`. A step declaring `output` on a harness
  that cannot honor it is a preflight error, not a silently degraded second
  interpretation of the agent's words.

## Consequences

- Keys are author-supplied, must be unique within an activation (a second use
  is an error), and are constrained in format because they land in run state.
- Determinism is a documented rule, not an enforced one: effects outside a
  step re-fire on resume. Explicit name-keyed memoization keeps the failure
  mode mild — a diverging body orphans records rather than corrupting them.
- No pre-run graph exists, so pipeline visualization is foreclosed rather than
  deferred. Run *history* rendering remains open.
- ADR 0001's "builds a DAG imperatively and default-exports it" no longer
  describes the model; see the amendment note there. Its core decisions —
  library-first, CLI as the single execution owner, pipelines as config
  modules that never launch themselves — stand unchanged.
