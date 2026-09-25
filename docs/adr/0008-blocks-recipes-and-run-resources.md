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

What a run creates (worktree, run directory, branch, pull request) is recorded
against the run as kind, identity and URL on Workflow SDK run attributes, one
reserved key per resource (`$jigs.resource.v1:<kind>:<identity>`, the URL as
value). There is no jigs table. The record knows kinds, not pull requests, so a
run with several pull requests or a custom kind records them the same way.
Registration is a separate idempotent step from creation, is observation only,
and grants no deletion authority. `jigs status <run-id>` lists the resources
independently of the workflow's return value. Keys and values are capped by the
SDK's attribute limits and never truncated.

## Release

The factory service owns release. Policy resolves from the workflow entry, then
the factory default, then `{ onSuccess: "release", onFailure: "keep" }`;
`completed` uses `onSuccess`, `failed` and `cancelled` use `onFailure`. A
workflow may call the `release` routine as its last line to get the report; an
explicit `keep` it records is final for the run. Each worktree is then decided
by the [teardown rules](./0002-worktree-lifecycle.md).

## Consequences

- The service waits on the World's terminal-status signal and also reconciles
  every terminal run at startup and on a timer, so a lost signal, a restart or
  a transient error is retried. Suspended runs, including one parked on a pull
  request, are never candidates.
- Progress lives in a fixed pair of reserved attributes (`pending`, `running`,
  `kept`, `complete`, `failed`). Released, kept and unknown resources stay
  visible; an unknown kind is never passed to deletion code. Release tolerates
  already-absent resources, so repeated attempts converge.
- Cancellation lets a running step finish, so cleanup waits until the World
  shows no active step, takes a run-scoped Postgres advisory lock that
  provisioning also takes, and checks again under it. The lock is held through
  the git safety checks and deletion. Shutdown stops timers and drains admitted
  attempts before the World closes.
- `jigs resources prune` is the operator path for kept resources: preview until
  `--apply`, which requires the service and its children to be stopped and uses
  the same lock and teardown decision. Dirty or unmerged work has no bypass.
- Rejected: a workflow DSL, scaffolding recipes with `jigs init`, an editable
  `jigs.ts`, and a jigs-owned resources table.
