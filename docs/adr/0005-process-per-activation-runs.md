# Process-per-activation runs on a sqlite store

> **Superseded by [ADR 0008](./0008-adopt-workflow-sdk-runtime.md).** The
> Workflow SDK's Postgres World replaces the jigs-owned runtime described
> below: no sqlite store, process-per-activation worker, or stateless
> poller. The goals stand — detachable runs, idle-run-as-disk-state,
> crash = re-run the step from zero — and the crash-model reasoning below
> remains the reference for *why* those semantics were chosen.

A run is disk state, not a process. A process exists only while an activation
executes: `jigs run` (and every wake) spawns a detached worker that executes
the pipeline body; a suspension writes its record and the process **exits**; a
terminal state tears down registered worktrees and exits. An idle run —
suspended for days at a PR gate — is rows and files, so reboot survival is by
construction and "detachable" is trivially true. Resume needs no saved program
counter: the body replays from the top, recorded steps return instantly, and
execution reaches the suspension in milliseconds — ADR 0003's memoization *is*
the resume mechanism.

The store is the only interface. CLI verbs are store readers (`ps`, `show`,
`logs --follow`) or worker spawners (`run`, `resume`, `poll`, `watch`), plus
`cancel`, which signals the pid recorded in the run's lock file. Nothing
searches the OS for processes: the database is the process registry, liveness
is a point probe of the lock pid, and `interrupted` (stored `running`, dead
pid) is derived at read time, so no reaper patrols for crashes.

Structured state lives in sqlite — `~/.local/share/jigs/jigs.db`, one database
across all factory repos, rows tagged with factory identity (repo path + git
remote) — managed with Drizzle and drizzle-kit: runs, activations, step
results, suspension records, the worktree registry, harness session pointers,
and per-activation ticket snapshots as JSON columns. Append streams
(activation logs, step transcripts) are files under `runs/<run-id>/`. Run
identity is dual: a timestamp-sortable ULID is canonical; the ticket is
indexed metadata the CLI also resolves, along with unique id prefixes.

Wake is a stateless poller. `jigs poll` sweeps suspended runs' satisfiers and
spawns activations for any satisfied; `jigs watch` loops it; the blessed
always-on deployment is watch under a systemd user unit, shipped as
copy-paste docs rather than an `--install` code path. An unsatisfied wake is
harmless — the replay re-suspends without burning a turn — so the poller only
needs to be cheap, never right, and manual `jigs resume` always works.
Concurrency is bounded per run, not globally: a pid lock taken at activation
start prevents double-resume, and serializing runs would starve a 30-second
review reply behind a 40-minute implement step.

## Considered options

- **Daemon + client** (`jigsd` owning runs, CLI as socket client): rejected.
  An IPC protocol, client/daemon version skew, resident-process lifecycle,
  and a single crash point taking the factory's liveness with it — to rebuild
  the "long-lived service coordinating a queue with no contention" ADR 0003
  declined to import. Its one real advantage, a resident server for the
  future dashboard, is recovered by putting a reader in front of the store;
  its useful *behavior*, always-on responsiveness, is watch-under-systemd.
- **Per-run resident workers** (one process per run, alive across
  suspensions, polling while idle): rejected as the worst of both — a
  days-idle process is exactly what reboots and OOM killers eat, and it holds
  nothing that isn't already persisted.
- **Flat JSON files** for run state: overridden with eyes open, against ADR
  0002's lean. The web dashboard is a committed close follow-up, and sqlite
  also buys v0 value the files lacked — transactional crash-safety and the
  cross-run queries `jigs ps` wants. JSON1 columns keep documents queryable;
  Drizzle keeps the schema in TypeScript with migrations.
- **Partial-step crash recovery** via harness session resume: rejected for
  v0. A step is the atomicity unit everywhere else; an interrupted run
  re-runs the mid-flight step from zero and eats the lost turn. Session
  pointers are still recorded per agent step (best-effort — they point into
  harness-owned storage and can dangle) because they are capturable only at
  step time and the GitHub review loop wants them.
- **Pinning pipeline code per run**: rejected — a fix made while a run idles
  should reach the resumed run, and ADR 0003's divergence tolerance already
  makes drift survivable. v0 doesn't even warn on drift; sha-stamping is a
  cheap later add.

## Consequences

- The suspension signal unwinds through author code as a runtime-owned
  throw, so an over-broad author `catch` can swallow it. The implementation
  must make it recognizable and rethrow where possible; the documented rule
  is "rethrow what you didn't throw".
- `jigs cancel`: SIGTERM via the lock pid → the worker aborts the in-flight
  provider turn, marks cancelled, tears down, releases; `--force` escalates
  to SIGKILL with CLI-side cleanup. A suspended run cancels with no process
  involved. Cancelled is terminal.
- Stored statuses are `running / suspended / done / failed / cancelled`;
  `interrupted` is derived, never stored. Step keys are constrained to
  `[a-z0-9.-]`, ≤64 chars, enforced at call time like duplicate keys.
- Two active runs at once is normal. The one shared-mutable hazard —
  concurrent fast-forward of the same binding checkout — belongs to the
  worktree lifecycle spec.
- A future dashboard or daemon is additive: a resident process may read the
  store, poll, and serve HTTP, but execution ownership stays in spawned
  activations. Adopting the Workflow SDK (backlog spike) would supersede
  this ADR's runtime while keeping the CLI verbs and pipeline bodies.
