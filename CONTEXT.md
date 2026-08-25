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
One recorded unit of work in a pipeline, awaited from the body and identified
by its key. Three kinds: an **agent step** (a coding agent on a harness, in a
worktree), a **model step** (a plain model call, no worktree), and a
**function step** (plain TypeScript).
_Avoid_: node, task, stage

**Step key**:
The author-supplied name a step's result is recorded under. Unique within an
activation; what makes resume order-insensitive.
_Avoid_: id, label

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

**Ticket review**:
The shipped head-jig that normalizes a ticket into a brief and issues a
proceed / needs-human verdict.
_Avoid_: intake, triage

**Brief**:
The normalized implementation plan a ticket review produces — the
implementer's working plan. The ticket stays the definition of done.
_Avoid_: plan, spec
