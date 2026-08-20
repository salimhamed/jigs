# jigs

A lights-on software development factory: pipelines that take approved Linear
tickets through agent implementation, review, and human approval to a merged PR.

## Language

**Pipeline**:
The full DAG of steps a ticket or feature moves through, defined in a plain
TypeScript module. One pipeline definition can be reused across many runs.
_Avoid_: workflow, flow

**Jig**:
A reusable sub-DAG — a TypeScript function that returns a fragment of a
pipeline (e.g. implement → agent review → human review → merge). Pipelines are
composed from jigs.
_Avoid_: segment, pattern, template

**Step**:
One node in a pipeline, usually a single agent invocation with its own harness,
model, and repo binding.
_Avoid_: node, task, stage

**Run**:
One execution of a pipeline. Detachable: it survives terminal close and idles
awaiting human review.
_Avoid_: job, execution

**Binding**:
A registered target repository — where its checkout lives and its defaults. A
binding attaches to a step, never to a run.
_Avoid_: registration, target

**Factory repo**:
The central git-tracked repository holding the user's pipeline definitions.
Target repos contain no pipeline code.
_Avoid_: pipelines repo, config repo

**Gate**:
A transition that blocks a run until a human approves.
_Avoid_: checkpoint, approval step

**Harness**:
The coding-agent runtime a step runs on (Claude Code, Codex, Pi), driven
through `@ai-sdk/harness` adapters.
_Avoid_: agent CLI, backend
