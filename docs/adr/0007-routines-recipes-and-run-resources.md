# Routines, recipes and run resources

Status: accepted

jigs workflows are ordinary TypeScript calling durable steps through routines.
The library ships the bottom two of three layers and no delivery process:

1. **Steps and their wrappers.** The factory step file `#jigs/steps` is the
   durable-address anchor, not an extension point
   ([0006](./0006-factory-owned-steps.md)). A factory adds steps as
   `"use step"` functions beside the workflow that owns them.
2. **Routines.** Reusable code in the workflow bundle that calls wrappers and
   other routines and carries no process policy: no round budgets, no "merged
   means done", no ticket-status choices, no note wording. Workflow code
   imports the library from the root `@jigs-ai/jigs` and routines from
   `#jigs/routines`.
3. **Recipes.** Complete workflows shipped as source in `recipes/`, tested by
   `pnpm e2e`, and copied into a factory with `jigs recipe add`. Once copied a
   recipe is factory code. `jigs init` scaffolds a bare factory with one
   trivial workflow; `linear-ticket-to-pr` is a recipe, never scaffolded.

A mechanism moves from a recipe into a shipped routine only when two workflows
use it.

## Run resources

What a run owns is one row per resource in the `jigs_resources` table, in the
same Postgres as the World. It is the only store. Rows stay after release as
history, so `jigs status` shows what a run had and what happened to each item.
A run's cleanup status is its rows' states; nothing else records it.

- **States** are `live` until release decides, then `kept` (by policy or a
  safety check), `released`, or `failed`. A failed row is retried with backoff
  and kept, with its last error, after a few failed attempts. Every row carries
  the reason for its state.
- **Kinds.** Worktrees, run directories and harness homes have release
  handlers, and only jigs records them. `branch`, `pull-request` and any kind a
  factory registers are recorded only: they stay `live` as history. Handlers
  delete only what jigs recorded itself, never a factory-supplied URL.
- **Branches.** jigs never deletes remote branches. A branch is recorded only
  when the run's push created it, so a default branch or a person's branch is
  never listed. `jigs resources prune` lists the finished runs' branches that
  still exist, with the command that deletes them.
- **Ownership** is "this factory has a row for it". Several factories may share
  one database, so every query filters on the factory slug.
- **One read.** `readRunState` returns a run's state as plain data: the World's
  status, what the run is parked on, its claim and its rows. Status, the run
  API, automatic release and prune all read runs through it.

## Release

The factory service owns release. Policy resolves from the workflow entry, then
the factory default, then `{ onSuccess: "release", onFailure: "keep" }`. A
workflow may call the `release` step to get the report early. Each worktree is
decided by the [teardown rules](./0002-worktree-lifecycle.md). Harness homes
hold the sessions that resume a worktree, so they are removed only once every
worktree of the run is released.

## Consequences

- The service reacts to the World's terminal-status signal and also reconciles,
  at startup and on a timer, every terminal run that still has unreleased rows,
  so a lost signal or a restart is retried. Suspended runs are never
  candidates.
- Cancellation lets a running step finish, so cleanup waits until the World
  shows no active step and holds a run-scoped lock that provisioning also
  takes.
- `jigs resources prune` is the operator's explicit override of the release
  policy: it releases kept resources too, but never overrides a kind's safety
  checks. Dirty or unmerged work has no bypass.
- Rejected: a workflow DSL, scaffolding recipes with `jigs init`, editable factory
  step files, and resource records on Workflow SDK run attributes
  (per-key limits, no transactions with provisioning, a second store).
