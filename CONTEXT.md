# jigs

The vocabulary a maintainer meets in `src/`. Use these words in code, comments
and issues; the _Avoid_ lists name the words that mean something else here.

## Code

**Workflow**: A whole process, one Workflow SDK `"use workflow"` function in a
factory file, started by `jigs run`, a schedule or an event trigger.
_Avoid_: pipeline, flow, DAG

**Step**: A durable operation whose attempts and result the SDK records. jigs
ships the implementation; the factory's step wrapper gives it an address.
_Avoid_: task, node, stage

**Step wrapper**: A factory `"use step"` function that delegates to a library
step. Its file path and function name are the **step id**, so moving or
renaming one changes the address, and a jigs version bump never does.

**Generated integration**: The factory's committed `jigs/` directory, written by
`jigs generate`: the step wrappers, and the routines bound to them. Custom code
lives outside it.

**Routine**: A function a workflow calls that runs steps and may wait on
something outside the run, such as `runAgent` or `watchPullRequest`. It has no
directive and no recorded result of its own.
_Avoid_: helper, primitive, sub-workflow

**Workflow code**: Code that runs inside the workflow bundle and so must be
replay-safe, with no Node built-ins, environment or network.
_Avoid_: block, workflow-side

**Delivery**: One piece of work taken to a pull request by the delivery
routines (`buildAndReview`, `describePullRequest`, `publishPullRequest`,
`followPullRequestToOutcome`): the caller's work and prompts, a worktree, and
the agent sessions the workflow created. The routines decide mechanics; the
caller supplies every prompt, budget, note, and the wake, merge and describe
rules.
_Avoid_: ship, pipeline

**Delivery key**: The short name a delivery's pull request notes are scoped by.
One key per pull request.

**Recipe**: A workflow jigs ships as source, which `jigs recipe add` copies into
a factory. Once copied it is factory code.
_Avoid_: template, built-in workflow

**Scaffold**: What `jigs init` writes: config, the generated integration and a
trivial workflow. It presumes no process.

## Runs

**Run**: One execution of a workflow, across all its suspensions and wakes.
_Avoid_: job

**Activation**: One execution of the workflow body after launch or a wake.
Recorded step results replay the earlier decisions.

**Snapshot**: The copy of a run's subject, such as a Linear ticket, read once
per activation so every step in it sees the same thing.

**Suspension**: A run waiting on a hook for an outside condition. It stays
active and keeps its resources.
_Avoid_: pause

**Gate**: A planned suspension, such as waiting for pull-request review, CI or
closure.

**Needs-human halt**: A suspension that asks a human on the ticket to answer a
question or fix a problem; a verified reply lets the workflow continue.
_Avoid_: failure, abort

**Wake**: A signal that makes a suspended run recheck its condition: a webhook,
the service's poll, `jigs poke` or reconciliation.

**Claim**: A run-long hold on a ticket, keyed by a hook token that names it, so
a second active run cannot take it.
_Avoid_: lock, lease

## Resources

**Binding**: A named target repository in `jigs.config.ts`, with its remote and
how jigs merges and provisions worktrees there.

**Binding clone**: The copy of a binding's repository jigs keeps and cuts
worktrees from. Nobody edits it by hand.
_Avoid_: mirror, bare repo

**Worktree**: An agent's working copy for a run, on the run's own branch, cut
fresh from the binding clone's default branch. No other run ever uses it.
_Avoid_: checkout, workspace

**Run directory**: A scratch directory held for a run, with no repository.

**Run resource**: A durable thing a run owns, such as a worktree, harness home,
branch or pull request, recorded as a row that stays after release as history.
A row is this factory's proof of ownership.
_Avoid_: artifact

**Resource state**: `live`, `kept`, `released` or `failed`, with the reason. A
run's cleanup status is its resources' states.

**Kept resource**: A resource release left in place, by policy or because a
safety check refused, such as a worktree with uncommitted work.
_Avoid_: orphan, abandoned

**Registry**: The jigs tables in the World's Postgres.

**Release**: Removing a finished run's eligible resources under its release
policy. Dirty or unmerged work is kept, and remote branches are never deleted.
_Avoid_: teardown (for the request), gc

**Resource prune**: `jigs resources prune`, the operator's override of the
release policy, still bound by release's safety checks.
_Avoid_: sweep, cleanup job

## Agents

**Harness**: An agent program jigs spawns (Claude Code, Codex, Pi) that owns
the agent loop, tools and session.
_Avoid_: model, backend

**Harness descriptor**: The plain data a workflow builds to name a harness,
such as `harnesses.claude({ model })`. For Claude Code and Codex it is the
provider's own settings type, minus the keys jigs owns.
_Avoid_: harness options, harness config

**Model source**: An API endpoint that answers directly, with no agent program.

**Driver**: The step-side code for one harness or model source: its checks,
environment, session handling and supported verbs.
_Avoid_: adapter, provider

**The four verbs**: `runAgent` runs a harness in a directory with tools;
`askAgent` asks a harness for one answer without tools; `askModel` asks a model
source directly; `askJev` asks a model source typed yes-no, choice or score
questions about one state.

**Agent runner**: A Claude Code or Codex harness opened inside a factory's own
step, with the same checks, environment and isolation as jigs' agent step.
_Avoid_: executor, injected dependencies

**Agent session**: One agent across several turns of a workflow. It resumes the
harness session it holds, and starts fresh when that session is unusable.
_Avoid_: role session, resumeOrRebuild

**Session reference**: The small plain data that lets a later step resume the
same harness session.
_Avoid_: session pointer, agent session (for the data)

**Invocation home**: A private config directory made for one Codex or Pi
invocation, holding generated config and a link to the operator's login.
_Avoid_: sandbox home

## Service

**Service**: A factory's long-running process: triggers, wakes, schedules,
release and the dashboard.
_Avoid_: server, daemon

**World**: The Workflow SDK's persistence and queue backend; one Postgres per
factory.
_Avoid_: database, store

**Up**: `jigs up`: bring install, World, build and the running service in line
with the factory, then run doctor.
_Avoid_: deploy

**Trigger**: A request to create a run: input validation, preflight, then start.
Schedules and event triggers make one; a wake resumes an existing run instead.

**Schedule**: A named cron trigger with fixed inputs. A tick is skipped while
the schedule's previous run is still active.
_Avoid_: cron job

**Event trigger**: A named trigger that starts one run per occurrence from a
source, with fixed inputs and a cap on its active runs. It only starts runs;
later events on a run's resources are wakes.
_Avoid_: webhook trigger, subscription, event router

**Source**: What an event trigger watches, in the provider's own query
parameters, such as a PagerDuty service's incidents or a Slack channel's
messages.
_Avoid_: filter, feed

**Occurrence**: One provider event a source counts as a reason to start a run,
such as a new incident or a top-level message. An event trigger starts at most
one run per occurrence, ever.
_Avoid_: event (for the deduplicated unit), delivery

**Delivery kind**: How a source learns of occurrences: polling, which every
source has, or a push kind such as a webhook or a socket.
_Avoid_: transport, mode

**Ingress**: The optional webhook routes that turn provider events into wakes
and occurrences. The poll does the same either way; ingress only makes it
sooner.
_Avoid_: webhook handler

**Preflight**: Checking a workflow's declared `requires` before a run exists.

**JIT check**: A check that can only run when a step is about to execute; its
failure becomes a needs-human halt.

**Check catalog**: The one set of checks and repair hints used by preflight,
JIT checks and doctor.
