# Centrally housed worktrees, policy-owned teardown, guarded fast-forward

> **Amended 2026-09-05 (R5).** Worktrees are cut from jigs' own bare clone of
> the binding's remote, at
> `jigsDataDir()/bindings/<factory-slug>/<binding-name>/{repo.git,seed,worktrees/<branch-dirname>}`.
> The guarded fast-forward is **removed entirely** — jigs never touches
> anyone's checkout, so there is nothing to fast-forward, and the
> `ff_default_branch` opt-out is gone with it; the sweep now fetches
> `origin/<default>` explicitly before its merge check, which is the one thing
> the fast-forward was load-bearing for. `workspace_dir` is gone too. The sweep
> also no longer scans for unregistered directories — every worktree it can see
> came from a registry row — so the `unregistered` state is gone from the
> classifier. Everything else below stands: the three-way branch resolution,
> the `base_sha`/`head_sha`/`behind_default` triple, the explicit-cwd
> invariant, the reuse rules, the teardown matrix, and `.jigs.yml`'s
> `copy`/`post_create`/`hook_timeout_minutes` semantics — whose `copy` source
> is now the binding's seed directory, and whose config is read from the seed
> directory first, then the worktree. A parked run must not straddle the
> rollout: its memoized worktree path points into the old layout, and its
> teardown would find no registry row for it.

Worktrees live in a central data dir —
`~/.local/share/jigs/worktrees/<factory-slug>/<binding-name>/<branch-dirname>`
— never beside the human's checkout unless a binding's `workspace_dir` says so.
The factory slug (dirname + short path-hash) mirrors the store's factory
tagging (ADR 0005): binding names are unique only per factory repo, so the
path needs factory identity to keep two factories' same-named bindings apart.

Freshness never touches the human checkout's local default branch: the gate is
`git fetch`, and new worktree branches fork from `origin/<default>`. The
ported three-way resolution (existing local ref checked out as-is and never
auto-reset; remote-only branch tracked; otherwise a new branch off the fetched
default) and the `base_sha`/`head_sha`/`behind_default` triple carry over from
claude-code-flow, as does the cwd invariant: every git call passes an explicit
main-root `cwd`, because removing a worktree deletes the CWD of whoever
orchestrates.

Fast-forwarding the binding checkout's local default branch is **default-on
with guards** — a deliberate reversal of the map's original "explicit,
opt-in" framing. It fires at both the activation freshness pass and post-merge
teardown, and only ever performs a pure fast-forward on a clean checkout
(default branch checked out → `pull --ff-only`; another branch checked out →
`git fetch origin <default>:<default>`); anything else skips with a logged
notice, never an error. Per-binding `ff_default_branch: false` opts out. A
per-checkout advisory file lock serializes concurrent runs' ff attempts (the
shared-mutable hazard ADR 0005 forwarded here); the loser re-checks and
no-ops. ADR 0006's "never surprised" is thereby sharpened to "never unsafely
moved".

Reuse follows sandcastle's battle-tested rules plus registry ownership: a
worktree registered to a live or suspended run is a hard error naming the
owner; unowned, clean, and ff-safe is reused; unowned but dirty or diverged is
preserved untouched and errors with resolution guidance; a branch with no
worktree goes through three-way resolution.

Teardown is runtime-owned (authors never call a destructor; an author
`finally` would fire on suspension too) and applies only to terminal states —
a suspended run holds its worktree. The matrix: **done (merged)** removes the
worktree and deletes the local branch and, idempotently, the remote branch
(tolerating GitHub's delete-on-merge having got there first); **failed or
cancelled with a clean tree** removes the worktree but keeps local and remote
branches as the insurance copy of unmerged work; **failed or cancelled with a
dirty tree** preserves the worktree, marks it abandoned-dirty in the registry,
and surfaces it in `ps`/`sweep` — never an automatic WIP commit, which would
push half-states onto the Linear/GitHub-keyed branch name. `keep: true` keeps
worktree and branch unconditionally. `jigs sweep` is the net for paths that
never executed: it joins disk against the registry and run states, holds
suspended, marks abandoned (terminal or interrupted owner) eligible, lists
unregistered directories as orphans, and reports by default — `--clean`
deletes eligible entries, dirty ones only with `--force` — then GCs empty
workspace directories.

Provisioning ports claude-code-flow's `.worktreerc.yml` semantics verbatim
into the target repo's `.jigs.yml` `worktree:` section: `copy` patterns are
gitignore-blind disk globs relative to the checkout root (copying `.env`-class
files is their purpose), a directory match copies the whole tree, existing
destinations are never overwritten, and the file self-copies into the
worktree unless the repo tracks its own, which the copy would only make
dirty. `post_create` commands run in the worktree with `VIRTUAL_ENV`
stripped and stdin `/dev/null`, **fail fast** — a failing hook fails the
`worktree()` request, leaving the half-provisioned tree registry-marked for
diagnosis — under a single overridable `hook_timeout_minutes` (default 10).
Scratch data is not a category: scratch *is* the worktree; `runs/<run-id>/`
files are the kept record.

## Considered options

- **Worktrees beside the checkout** (`<repo>-worktrees/` sibling): rejected
  as the default — jigs writing into the human-owned directory neighborhood
  contradicts the untouched-checkout stance; `workspace_dir` recovers it
  per binding for repos whose tooling assumes proximity.
- **Keeping fast-forward opt-in** (the map's original wording): rejected with
  eyes open. The operator never works on the default branch directly, the
  guards make an unsafe move impossible rather than unlikely, and a
  perpetually stale local `main` is the actual daily paper cut. The opt-out
  preserves frozen checkouts.
- **`pull --ff-only` on the local default as the freshness mechanism** (the
  claude-code-flow behavior): rejected — it makes mutating the human checkout
  load-bearing for correctness. Branching off `origin/<default>` decouples
  base freshness from checkout convenience entirely.
- **Deleting branches of failed runs**: rejected — the branch is the only
  cheap copy of unmerged agent work; unmerged jigs branches are listed by
  sweep for explicit deletion instead.
- **Auto-WIP-committing dirty failed worktrees**: rejected — pushes half-states
  under the ticket-keyed branch name; dirty-worktree preservation (sandcastle's
  rule) keeps the evidence in place instead.
- **Warn-and-continue on `post_create` failure**: rejected — an agent building
  in a half-provisioned tree produces expensive garbage; failing the request
  is cheaper than the run it would corrupt.
- **A jigs-owned scratch-dir primitive**: rejected for v0 — the construct
  model already ruled agent steps share the run's worktree; a third data
  category would add cleanup surface with no consumer.

## Consequences

- The `.jigs.yml` `worktree:` schema stays small: `copy`, `post_create`,
  `hook_timeout_minutes`. Binding-side additions: `workspace_dir`,
  `ff_default_branch`. Everything else in this ADR is runtime behavior, not
  config.
- The TS glob implementation must match dotfiles (Python's `pathlib.glob`
  does; most JS globbers default to ignoring them) or `.env`-class copies
  silently vanish.
- Registry states gain `abandoned-dirty`; `jigs ps` surfaces it so preserved
  wreckage is visible, not just discoverable.
- These are git-substrate policies, deliberately runtime-agnostic: if the
  Workflow SDK spike (AGE-304) replaces the execution engine, only the
  placement of the teardown hook moves; the matrix, sweep, freshness, and ff
  rules stand.

## Amendment (2026-08-30, AGE-318 dogfood)

The background sweep timer is removed, and `reviewLoop` no longer calls
teardown itself. The first mid-stream cancellation showed the timer deleting
state between two commands an operator was reading — automation nobody asked
for. The lifecycle is now: a merged run's pipeline calls `teardownWorktrees`
as its own last line (a plain sequential call, never a `finally` — suspension
is a thrown error); every other ending leaves the worktree on disk, `jigs ps`
shows it as `abandoned` via the same classifier sweep uses, and the operator
reclaims it through `jigs sweep` — interactive per worktree on a terminal,
report-only otherwise, `--force` as the explicit unattended yes (the old
`--clean`/`--force` pair collapsed into it). `jigs cancel` names the worktrees
it leaves behind. The matrix (decide/apply) is unchanged.
