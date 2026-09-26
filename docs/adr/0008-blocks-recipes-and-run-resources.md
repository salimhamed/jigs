# Routines, recipes and run resources

Status: accepted

jigs workflows are ordinary TypeScript calling durable steps through routines.
The library ships the bottom two of three layers and no delivery process:

1. **Steps and their wrappers.** The generated `jigs/steps.ts` is the durable-address
   anchor, not an extension point ([0006](./0006-factory-owned-steps.md)). A
   factory adds steps as `"use step"` functions beside the workflow that owns
   them.
2. **Routines.** Reusable code in the workflow bundle that calls wrappers and
   other routines and carries no process policy: no round budgets, no "merged
   means done", no note wording. Workflow code imports the library from the
   root `@jigs-ai/jigs` (definitions, `JigsError`, descriptors, types, pure
   renderers) and routines from the generated `jigs/routines.ts`, which alone
   imports `@jigs-ai/jigs/routines`. Only the generated `jigs/steps.ts` imports
   `@jigs-ai/jigs/steps/<topic>`.
3. **Recipes.** Complete workflows shipped as source in `recipes/`, tested by
   `pnpm e2e`, and copied into a factory with `jigs recipe add`. Once copied a
   recipe is factory code. `jigs init` scaffolds a bare factory with one
   trivial workflow; `ship` is a recipe, never scaffolded.

A mechanism moves from a recipe into a shipped routine only when two workflows
use it.

## Run resources

What a run owns is one row per resource in the `jigs_resources` table, in the
same Postgres as the World: factory slug, run ID, kind, identity, URL, state,
reason, timestamps, and a worktree's clone and branch. It is the only store.
Rows stay after release as history, so `jigs status` shows what a run had and
what happened to each item. A run's cleanup status is its rows' states; nothing
else records it.

- **States** are `live` until release decides, then `kept` (by policy or a
  safety check), `released`, or `failed` (retried by the next pass). Every row
  carries the reason for its state.
- **Kinds.** `worktree`, `run-directory`, `codex-home`, `pi-home` and `branch`
  have release handlers; `pull-request` and any kind a factory registers are
  recorded only. One module (`steps/runtime/resource-kinds.ts`) holds the
  handlers and their safety checks, and status, explicit and automatic release,
  and prune all go through it. Handlers delete only what jigs recorded itself
  (run ID, identity, a worktree's clone and branch), never a factory-supplied URL.
- **Ownership** is "this factory has a row for it". Several factories may share
  one database, so every query filters on the factory slug.
- **Registration.** jigs records its own resources where it creates them.
  The `registerResource` step (kind, identity, URL) writes a row for anything
  else; registering again refreshes the URL and marks the row live.
- **One read.** `readRunState` returns a run's state as plain data: its rows,
  plus the hook facts (the ticket claim and what it waits on). Status, release
  and prune read runs through it, and it is the snapshot later decisions are
  asked over.

## Release

The factory service owns release. Policy resolves from the workflow entry, then
the factory default, then `{ onSuccess: "release", onFailure: "keep" }`;
`completed` uses `onSuccess`, `failed` and `cancelled` use `onFailure`. A
workflow may call the `release` step to get the report early; the rows it marks
`kept` are final for the run. Each worktree is then decided by the
[teardown rules](./0002-worktree-lifecycle.md). Harness homes stay while any of
the run's worktrees is kept, because they hold the sessions that resume it.

## Consequences

- The service waits on the World's terminal-status signal and also reconciles,
  at startup and on a timer, every terminal run that still has live or failed
  rows, so a lost signal, a restart or a transient error is retried. Suspended
  runs, including one parked on a pull request, are never candidates.
- Cancellation lets a running step finish, so cleanup waits until the World
  shows no active step, takes a run-scoped Postgres advisory lock that
  provisioning also takes, and checks again under it. The lock is held through
  the git safety checks and deletion. Shutdown stops timers and drains admitted
  attempts before the World closes.
- `jigs resources prune` is the operator path for what release left: it acts
  only on this factory's `live` rows of finished runs and, with
  `--include-kept`, `kept` rows. It previews until `--apply`, which requires
  the service and its children to be stopped, and reads the run's status from
  the World's table because the offline CLI cannot open the World. It uses the
  same lock and handlers. Dirty or unmerged work has no bypass.
- The schema is Drizzle, with hand-written migrations in `migrations/`; there
  is no `drizzle-kit`. Upgrading from run attributes kept no old records: runs
  had to finish and be pruned first.
- Rejected: a workflow DSL, scaffolding recipes with `jigs init`, an editable
  `jigs.ts`, and resource records on Workflow SDK run attributes (per-key
  limits, no transactions with provisioning, and a second store beside the
  worktree table).
