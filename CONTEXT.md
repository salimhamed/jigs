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
The name of the project, from the manufacturing fixture that guides a tool
through a repeatable operation. It is not a name for any kind of code. A
reusable stretch of pipeline-side code is a **block**.
_Avoid_: jig as a code term, sub-jig

**Block**:
Pipeline-side reusable code that calls steps in a fixed way. A block is one
async TypeScript function taking the step wrappers it needs as plain
parameters. It carries no directive, so it owns no step id and
renaming one is safe. jigs ships blocks and a factory writes its own; both are
the same kind of thing.
jigs ships the blocks a wrong edit would break: the ones holding the builder's
session, the resume fallback, the ids the gate cursor needs back, the
code-review call the brief is kept out of. What a wrong edit would merely
change, such as the order, the CI bound, the merge policy, the escalation
prose and the prompts, the factory writes as blocks of its own.
_Avoid_: building block, composition, flow, sub-pipeline, primitive, helper,
util

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
`step//workflow@4.8.4//fetch` is the only such id today; see ADR 0013). The
jigs package's version appears in none of them, so releasing jigs moves none.
Not authored, not stable across a move — a step id that changes is every
in-flight run losing its memory.
_Avoid_: step key, step name, cache key

**Step wrapper**:
The `"use step"` function in a factory's own `steps/jigs.ts` that delegates to
one of jigs' plain step implementations. Scaffolded once by `jigs init`, then
committed source the factory owns and extends by hand: its file path and its
name *are* the step id. Edit one freely; renaming or moving one changes its id
and orphans every run parked against it, so that waits for a `jigs ps` with no
parked runs.
_Avoid_: shim, binding, adapter

**Run**:
One execution of a pipeline. Detachable: it survives terminal close and idles
awaiting human review.
_Avoid_: job, execution

**Binding**:
A target repository declared in the factory repo's config — a name mapped to
the repo's remote URL plus the worktree provisioning it carries (`copy`,
`post_create`, `hook_timeout_minutes`), the one place that story is told. jigs
keeps its own clone per binding; the operator's checkout of the repo is not
part of it. A binding attaches to a step, never to a run.
_Avoid_: registration, registry, target, checkout

**Binding clone**:
The bare git clone jigs keeps for each binding of each factory, under the jigs
data directory. Created when the service starts, fetched before every cut,
and the `git -C` root for that binding's worktree, branch and
branch-deletion operations — a run's push comes from the worktree itself.
Nobody edits it; it has no working tree.
_Avoid_: mirror, cache, bare repo

**Factory repo**:
The central git-tracked repository holding the user's pipeline definitions
and bindings. Target repos contain no pipeline code. It pins jigs to a
version and runs its own copy of the CLI (`pnpm exec jigs`); no jigs is
installed globally and no checkout is linked.
_Avoid_: pipelines repo, config repo

**jigs package**:
`@salimhamed/jigs` — the CLI, the blocks, the step implementations, the
service, and the templates `jigs init` writes from. A factory reaches the
blocks through `@salimhamed/jigs/blocks` and the step implementations through
`@salimhamed/jigs/steps`; the root carries the types a factory names and
`ticketInput`, and the service subpaths belong to the build. Published
compiled to GitHub Packages under the `@salimhamed` scope and installed by a
factory like any dependency, through a scope line in its `.npmrc` and a
`read:packages` token in the operator's `~/.npmrc` (ADR 0017).
_Avoid_: the checkout, link:, @jigs/service, @salimhamed/jigs-service, the
jigs packages (plural), the jigs repo (as a dependency)

**Factory-supplied runtime**:
The four packages a factory installs itself, at the versions jigs peers on:
`workflow`, `@workflow/world-postgres`, `@workflow/web` and `zod`. The SDK
loads the World and the dashboard by name from the factory's own
`node_modules`, `workflow` must be one copy per process, and
one zod copy is what lets the factory's schemas unify with jigs' types;
`strictPeerDependencies` in the factory turns a mismatch into an install
failure. Everything else the service needs is its own dependency.
_Avoid_: transitive deps, runtime deps, peer set

**Scaffold**:
What `jigs init` writes into a factory, once each and never again: the
infrastructure (`jigs.yml`, `package.json`, `.npmrc`, `nitro.config.ts`,
`docker-compose.yml`, `.env.example`, the build config) and the code the
factory starts from (`jigs.config.ts`, `pipelines/ship.ts`,
`steps/jigs.ts`, `blocks/jigs.ts`, `blocks/review-loop/`,
`prompts/describe-pr.ts`, the ids test). `init` touches nothing on the machine;
`jigs up` is what runs.
_Avoid_: generated code, boilerplate, template (for the written files)

**Up**:
`jigs up` — the command that takes a factory from any state to a running
service: env, install, World, bootstrap, build, start-or-restart, ready,
doctor, each idempotent and each its own line, stopping at the first failure
with its repair. Also the command after every change; an unchanged factory
installs, migrates and restarts nothing. `jigs upgrade` is a bump of both
jigs pins, then `up`, then the factory's typecheck.
_Avoid_: deploy, bootstrap (for the whole), start (for the whole)

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
The working copy an agent step runs in, cut from the binding's clone. Requested
by the pipeline; the runtime remembers every one it made and tears them down
when the run ends.
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
context, falling back to a fresh agent fed the run's record whenever the
pointer is unusable — stale, or recorded on a different harness than the step
runs on.
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
The jigs block that normalizes a ticket into a brief, parking on a
needs-human verdict and re-reading the ticket each round until it proceeds. It
returns a handoff, never a verdict to branch on.
_Avoid_: intake, triage

**Review loop**:
The factory's own blocks that carry a handoff from implementation to a merged
PR: implement until the code review approves, then the pull request gate,
answered by the builder. Scaffolded into `blocks/review-loop/`, one decision per file; the
jigs blocks it calls come from `@salimhamed/jigs/blocks`.
_Avoid_: build loop, PR loop, the reviewLoop jig

**Brief**:
The normalized implementation plan a ticket review produces — the
implementer's working plan. The ticket stays the definition of done.
_Avoid_: plan, spec

**Handoff**:
What a ticket review returns and every builder block takes: the brief plus the
ticket snapshot it was written from. The two travel together on purpose. The
ticket is authoritative wherever they conflict, and a review step judges the
work against the snapshot's acceptance criteria rather than against the brief,
so a re-planning agent cannot move the goalposts.
_Avoid_: context, payload, the brief (for the pair)

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
its HTTP client. A host process, not a container: it drives the operator's
`claude` and `codex` logins, the AWS SSO cache and the git clones.
_Avoid_: server, daemon, worker, container

**Dashboard**:
The SDK's run-history UI, hosted by the service on a second port the factory
declares — one dashboard per factory, reading the World its own service
writes. `jigs logs` links to a run's page there. Never run standalone against
a live World: opening that World starts a second queue worker, which delivers
the run's own jobs to a port with no workflow route.
_Avoid_: observability UI, web, console

**Trigger**:
The service route that creates a run: it validates a named pipeline's zod
`inputs` against plain JSON and calls the runtime's start. It injects
`triggerId` on every run, and for a pipeline taking a `ticket` the `issueId`
and `identifier` it resolved the ref to; a body that reads them types itself
`PipelineInputs` or `TicketPipelineInputs`, and the injection site is checked
against the same declaration, so a field added on one side and not the other
fails to compile. Distinct from a wake, which resumes a run that already
exists. Preflight lives in the trigger path.
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
only its runs. The service refuses to start without one: the worktree
registry lives in the same database. Selected by environment, never by code.
_Avoid_: backend, database, store
