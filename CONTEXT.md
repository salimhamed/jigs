# jigs

A lights-on software development factory: pipelines that take approved Linear
tickets through agent implementation, review, and human approval to a merged PR.

## Language

**Pipeline**:
The whole route a ticket or feature moves through, written as a plain
TypeScript async body the runtime calls. One pipeline definition can be reused
across many runs.
_Avoid_: workflow, flow, DAG

**Jig**:
A reusable stretch of a pipeline — an async TypeScript function you call from
a pipeline body (e.g. implement ⇄ review until approved). Pipelines are
composed from jigs.
_Avoid_: segment, pattern, template

**Step**:
One recorded unit of work in a pipeline, awaited from the body and memoized
by the runtime's deterministic replay. Three kinds: an **agent step** (a
coding agent on a harness, in a worktree), a **model step** (a plain model
call, no worktree), and a **function step** (plain TypeScript).
_Avoid_: node, task, stage

**Step id**:
The name the runtime memoizes a step's result under: the step file's path
relative to the factory root plus the function's name (an installed
dependency's steps take name+version+subpath instead — the SDK's own
`step//workflow@4.8.4//fetch` is the only such id today; see ADR 0013). No
jigs package's version appears in any of them, so releasing jigs moves none.
Not authored, not stable across a move — a step id that changes is every
in-flight run losing its memory.
_Avoid_: step key, step name, cache key

**Step wrapper**:
The `"use step"` function in a factory's own `steps/jigs.ts` that delegates to
one of jigs' plain step implementations. Hand-written and committed — jigs
scaffolds none of them: its file path and its name *are* the step id, so
renaming one orphans every parked run that memoized against it.
_Avoid_: shim, binding, adapter

**Run**:
One execution of a pipeline. Detachable: it survives terminal close and idles
awaiting human review.
_Avoid_: job, execution

**Binding**:
A target repository declared in the factory repo's config — a name mapped to
where its checkout lives, pinned to its expected remote. A binding attaches
to a step, never to a run.
_Avoid_: registration, registry, target

**Factory repo**:
The central git-tracked repository holding the user's pipeline definitions
and bindings. Target repos contain no pipeline code.
_Avoid_: pipelines repo, config repo

**Suspension**:
A run pausing until a named external condition satisfies it. Never open-ended:
every suspension declares what can wake it. A suspended run is not terminal,
so it keeps its worktree.
_Avoid_: pause, block

**Satisfier**:
The named external condition a suspension declares can wake it — a PR
approval for the gate, a human reply for the needs-human halt. Checked on
every wake; an unsatisfied wake simply re-suspends.
_Avoid_: trigger, wake condition

**Gate**:
A suspension the pipeline plans for. v0 ships one, the pull request gate,
satisfied by a human approving the PR.
_Avoid_: checkpoint, approval step

**Needs-human halt**:
A suspension raised from a step's verdict rather than planned, satisfied by a
human's reply on the Linear ticket.
_Avoid_: failure, abort

**Worktree**:
The working copy an agent step runs in. Requested by the pipeline; the runtime
remembers every one it made and tears them down when the run ends.
_Avoid_: checkout, clone, workspace

**Worktree registry**:
The run store's record of every worktree the runtime created — which run owns
it and what state it is in. What reuse checks and the sweep consult.
_Avoid_: worktree list, worktree cache

**Sweep**:
The reconciliation that compares worktrees on disk against the registry and
run states — reporting what it finds, deleting only on explicit request. The
cleanup net for runs that never reached their own teardown.
_Avoid_: gc, prune, cleanup job

**Abandoned worktree**:
A worktree still on disk whose owning run is terminal or interrupted — leaked
by a crash, or deliberately preserved because it held uncommitted work.
Sweep-eligible; a suspended run's worktree is never abandoned.
_Avoid_: orphan, stale worktree

**Harness**:
The coding-agent runtime a step runs on, driven through its AI SDK provider
with the worktree as plain `cwd` (Claude Code and Codex in v0).
_Avoid_: agent CLI, backend, sandbox

**Activation**:
One waking of a run — its launch or any resume. Steps within one activation
all see the same snapshot.
_Avoid_: session, attempt

**Snapshot**:
The copy of a Linear ticket fetched at each activation and kept in run state.
What steps read; the audit record of what agents saw.
_Avoid_: cache, mirror

**Builder**:
The agent that implemented a run's change. The review loop resumes its
persisted session so review answers come from the agent that holds the
context, falling back to a fresh agent fed the run's record when resume
fails.
_Avoid_: implementer, author agent

**Ingress**:
The service's static HTTP routes that receive provider webhooks — verify the
signature, reconstruct the hook token from the payload, resume the hook.
Stateless: an unroutable delivery is dropped, never queued.
_Avoid_: webhook handler, receiver, endpoint

**Wake**:
One delivery of external activity to a suspended run — from a webhook, a
manual poke, or reconciliation. Always a hint: the satisfier is re-checked
against the provider API on every wake, and an unsatisfied wake re-suspends.
_Avoid_: trigger, notification

**Claim**:
A run's run-long hold of an external resource's hook token, enforcing one
active run per resource — claiming an owned token fails loudly, naming the
owner. The ticket claim is a run's first act and doubles as the needs-human
wake channel.
_Avoid_: lock, lease

**Ticket review**:
The shipped head-jig that normalizes a ticket into a brief and issues a
proceed / needs-human verdict.
_Avoid_: intake, triage

**Review loop**:
The shipped jig that carries a brief from implementation to a merged PR:
implement ⇄ agent review, then the pull request gate, answered by the builder.
_Avoid_: build loop, PR loop

**Brief**:
The normalized implementation plan a ticket review produces — the
implementer's working plan. The ticket stays the definition of done.
_Avoid_: plan, spec

**Preflight**:
The trigger-path verification, before a run is created, that its
requirements are satisfiable — the pipeline's `requires` manifest plus jigs'
service credentials. Aggregates every failure with repair instructions; a
failed preflight means no run ever existed.
_Avoid_: health check, validation, smoke test

**Check catalog**:
The shared module of requirement checks and their repair instructions, used
by preflight, JIT checks, and `jigs doctor` — one source of repair text at
launch and mid-run.
_Avoid_: validators, checkers

**JIT check**:
The verification a step runs at hydration, just before burning agent turns —
the only honest moment for requirements invisible before the body executes,
like a step's MCP servers. Failure raises the needs-human halt.
_Avoid_: runtime check, lazy check

**Managed Codex home**:
The jigs-owned `CODEX_HOME` directory every Codex step runs under — a curated
zero-server `config.toml` plus a symlink to the real `auth.json`. What makes
MCP deny-by-default enforceable on a harness with no strict-config flag.
_Avoid_: isolated home, custom home, sandbox home

**Service**:
The long-lived process (one per factory repo, supervised by `jigs service`)
that owns execution: it hosts the compiled pipelines, creates runs at the
trigger, and resumes them on wakes. Everything else — the CLI included — is
its HTTP client.
_Avoid_: server, daemon, worker

**Trigger**:
The service route that creates a run: it validates a named pipeline's zod
`inputs` against plain JSON and calls the runtime's start. Distinct from a
wake, which resumes a run that already exists. Preflight lives in the
trigger path.
_Avoid_: launch endpoint, kickoff, start route

**Schedule**:
A named recurring trigger a factory declares — a pipeline, a five-field cron
in the service host's local time, and the static inputs to fire it with. The
service is the clock; each fire goes through the trigger path, so a missed
tick is skipped and a fire while the schedule's last run is still active is
skipped too.
_Avoid_: cron job, timer, recurring run

**World**:
The Workflow SDK's persistence-and-queue backend a service runs against —
one per factory repo: its own Postgres container on its own port, holding
only its runs. The SDK's filesystem World is for scratch development only.
Selected by environment, never by code.
_Avoid_: backend, database, store
