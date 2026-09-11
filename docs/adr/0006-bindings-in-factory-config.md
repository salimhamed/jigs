# Bindings are committed factory-repo config

> **Amended 2026-09-05 (R5).** A binding is now a **name plus a remote URL**;
> the operator's checkout is not part of it. jigs keeps its own bare clone per
> binding under `jigsDataDir()`, made when the service starts, and cuts
> worktrees from that. The `path`, `workspace_dir` and
> `ff_default_branch` keys are gone, as is the bind-time `.jigs.yml` scaffold
> offer. This reverses the "`jigs bind <remote-url>` cloning: rejected for v0"
> option below — auth is the operator's ssh agent, location is not
> configurable, and the disk is jigs', one object store per binding per
> factory. `jigs bind` is now a pure config edit plus the webhook leg.
> Worktree provisioning now lives on the binding itself — `copy`,
> `post_create` and `hook_timeout_minutes` in the factory repo's `jigs.yml`,
> with `copy` entries relative to the binding's own `bindings/<name>/`
> directory in that repo. The target repo's `.jigs.yml` and the per-binding
> seed directory are gone entirely.

A binding is the least state that makes a name meaningful: `name → checkout
path + expected remote`, declared in a committed `jigs.yml` at the factory
repo root under a top-level `bindings:` section. Everything else — default
branch, remotes, freshness — is derived fresh from git at each activation,
carrying claude-code-flow's "derive, don't store" precedent as far as it
goes; the remote pin is an assertion against bind rot (a moved or replaced
checkout fails loudly), not a cache. jigs keeps no user-level configuration
anywhere: the run store holds state, never config, and `jigs.yml` doubles as
the factory-repo marker — `bind`/`unbind`/`bindings`
resolve the factory repo by walking up from cwd and error with guidance
outside one.

Onboarding is one command. `jigs bind <path> [--name <n>]` verifies an
existing git checkout with a remote, derives the name from the repo dirname,
writes the entry (comment-preserving yaml edit, `~`-relative paths),
idempotently updates on re-bind, and *offers* — interactively,
write-on-confirm, never overwriting — to scaffold the target repo's optional
`.jigs.yml`: a `worktree:` section (copy rules + `post_create`) with
`post_create` inferred from the lockfile mapping table. No `.jigs.yml` means
no copy rules and no hooks; a zero-config bind works.

## Considered options

- **User-level registry** (`~/.config/jigs/`): rejected — a pipeline's
  `requires.bindings` names and the definitions they resolve to should travel
  together, reviewable in one repo; invisible per-user state contradicts the
  transparency goal.
- **Bindings in the sqlite store**: rejected — configuration in a
  runtime-owned state database is hostile to hand-editing and inspection.
- **Split registry** (committed `name + remote`, gitignored per-machine
  `name → path`): rejected — reintroduces the two-file complexity for churn
  that may never materialize. Committed paths with `~` expansion are honest
  and visible; local overrides can be retrofitted the day they hurt.
- **Compat-reading `.worktreerc.yml`**: rejected — two sources of truth; the
  bind-time scaffold makes migration a one-liner.
- **`jigs bind <remote-url>` cloning**: rejected for v0 — auth, location
  policy, and disk ownership for a step that takes a human ten seconds. A
  missing path is a preflight failure with a repair instruction, and the
  binding checkout stays human-managed, never surprised.

## Consequences

- Committed absolute-ish paths make a factory repo machine-flavored. Accepted
  with eyes open (teams/multi-user are out of scope); a wrong path on another
  machine fails preflight with "re-run `jigs bind`", and the rewrite is a
  visible commit.
- Binding names are unique per factory repo, not per user. Independent
  factory repos may bind the same checkout; many bindings may share one
  remote. Binding the checkout you actively work in is supported — worktrees
  isolate agent work and the ff-only rule (worktree lifecycle spec) protects
  the checkout — with "give jigs its own checkout for busy repos" as docs
  advice only.
- Binding defaults are near-none: an optional workspace-dir override is the
  only admitted field; the global worktree-location convention and the typed
  `worktree:` schema belong to the worktree lifecycle spec. Harness/model
  selection stays in pipeline code.
- Preflight resolves `requires: { bindings }` against `jigs.yml`; an
  undeclared binding fails with the exact `jigs bind` invocation to run.
- Dev-server runbook info has a natural future home (`.jigs.yml`) but no v0
  schema — deliberately unspecified until something consumes it.
