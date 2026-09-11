# Bindings are committed factory-repo config

A binding is the least state that makes a name meaningful: a **name plus a
remote URL**, declared in a committed `jigs.yml` at the factory repo root
under a top-level `bindings:` section. The operator's own checkout is not part
of it — jigs keeps its own bare clone per binding under `jigsDataDir()`, made
when the service starts, and cuts worktrees from that. Auth is the operator's
ssh agent, the location is not configurable, and the disk is jigs', one object
store per binding per factory.

Everything else — default branch, remotes, freshness — is derived fresh from
git at each activation, carrying claude-code-flow's "derive, don't store"
precedent as far as it goes; the remote pin is an assertion against bind rot,
not a cache. jigs keeps no user-level configuration anywhere: the run store
holds state, never config, and `jigs.yml` doubles as the factory-repo marker —
`bind`/`unbind`/`bindings` resolve the factory repo by walking up from cwd and
error with guidance outside one.

Onboarding is one command. `jigs bind <remote-url> [--name <n>]` derives the
name from the repo, writes the entry (comment-preserving yaml edit),
idempotently updates on re-bind, and does the webhook leg. It is otherwise a
pure config edit.

Worktree provisioning lives on the binding itself — `copy`, `post_create` and
`hook_timeout_minutes` in the factory repo's `jigs.yml`, with `copy` entries
relative to the binding's own `bindings/<name>/` directory in that repo. One
reviewable place describes how a worktree is provisioned, and the target repo
carries no jigs config at all.

## Considered options

- **User-level registry** (`~/.config/jigs/`): rejected — a pipeline's
  `requires.bindings` names and the definitions they resolve to should travel
  together, reviewable in one repo; invisible per-user state contradicts the
  transparency goal.
- **Bindings in the sqlite store**: rejected — configuration in a
  runtime-owned state database is hostile to hand-editing and inspection.
- **Split registry** (committed `name + remote`, gitignored per-machine
  overrides): rejected — reintroduces two-file complexity for churn that may
  never materialize. Local overrides can be retrofitted the day they hurt.
- **Compat-reading `.worktreerc.yml`** out of the target repo: rejected — two
  sources of truth, and the provisioning story belongs beside the binding that
  uses it.

## Consequences

- Binding names are unique per factory repo, not per user. Independent
  factory repos may bind the same remote; many bindings may share one remote.
  A binding attaches to a step, never to a run.
- The operator's checkout is never touched, because jigs never has it. Agents
  work in worktrees cut from jigs' own clone.
- Preflight resolves `requires: { bindings }` against `jigs.yml`; an
  undeclared binding fails with the exact `jigs bind` invocation to run, and a
  declared binding whose clone does not exist yet fails with the restart to
  run.
- Harness and model selection stays in pipeline code, never on the binding.
- Dev-server runbook info has a natural future home on the binding but no v0
  schema — deliberately unspecified until something consumes it.
