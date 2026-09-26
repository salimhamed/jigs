# jigs

The vocabulary a maintainer meets in `src/`. Use these words in code, comments
and issues; the _Avoid_ lists name the words that mean something else here.

## Code

**Workflow**: A whole process, one Workflow SDK `"use workflow"` function in a
factory file, started by `jigs run`, a schedule or a trigger.
_Avoid_: pipeline, flow, DAG

**Step**: A durable operation whose attempts and result the SDK records. jigs
ships the implementation in `src/steps/`; the factory's step wrapper gives it an
address.
_Avoid_: task, node, stage

**Step wrapper**: A factory `"use step"` function that delegates to a library
step. Its file path and function name are the **step id**, so renaming or moving
one changes the address, and a jigs version bump never does.

**Generated integration**: The factory's committed `jigs/` directory, written by
`jigs generate` from the installed library. `jigs/steps.ts` holds every step
wrapper and is the only generated file with a directive; `jigs/routines.ts`
binds the library's routines to those wrappers. Workflows import them as
`#jigs/steps` and `#jigs/routines`. Custom code lives outside it.

**Routine**: A function a workflow calls that runs steps and may wait on
something outside the run, such as `runAgent` or `watchPullRequest`. It lives
in `src/workflow/`, has no directive and no recorded result of its own, and
reaches a factory through the generated `jigs/routines.ts`, which binds it to
the factory's step wrappers.
_Avoid_: helper, primitive, sub-workflow

**Workflow code**: Everything in `src/workflow/`: code that runs inside the
workflow bundle and so must be replay-safe, with no Node built-ins, environment
or network. Routines, descriptors, schemas and pure renderers live here.
_Avoid_: block, workflow-side

**Recipe**: A workflow jigs ships as source under `recipes/`, which
`jigs recipe add` copies into a factory. Once copied it is factory code.
_Avoid_: template, built-in workflow

**Scaffold**: What `jigs init` writes from `templates/`: config, generated
integration and the `hello` workflow. It presumes no process.

## Runs

**Run**: One execution of a workflow, across all its suspensions and wakes.
_Avoid_: job

**Activation**: One execution of the workflow body after launch or a wake.
Recorded step results replay the earlier decisions.

**Snapshot**: The copy of a Linear ticket read once per activation, so every
step in that activation sees the same ticket.

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

**Claim**: A run-long hold on a ticket, keyed by a hook token that names the
ticket, so a second active run cannot take it.
_Avoid_: lock, lease

## Resources

**Binding**: A named target repository in `jigs.config.ts`, with its remote,
merge overrides and worktree provisioning settings.

**Binding clone**: The copy of a binding's repository jigs keeps and cuts
worktrees from. Nobody edits it by hand.
_Avoid_: mirror, bare repo

**Worktree**: An agent's working copy for a run, on the run's own branch (the
requested name plus a suffix from the run ID), forked fresh from the binding
clone's `origin/<default>`. No other run ever uses it.
_Avoid_: checkout, workspace

**Run directory**: A scratch directory held for a run, with no repository.

**Run resource**: A durable thing a run owns, recorded as one row of the
`jigs_resources` table (kind, identity, URL, state, reason): worktrees, run
directories, harness homes, branches, pull requests. Rows stay after release
as history. Status, release and pruning read these rows; a row is this
factory's proof of ownership.
_Avoid_: artifact

**Resource state**: `live`, `kept`, `released` or `failed`, with the reason. A
run's cleanup status is its resources' states.

**Resource kind**: What a resource is, and whether jigs can release it.
`pull-request` and factory-registered kinds are recorded only and stay `live`
as history.

**Run state**: One run's resources plus its hook facts (claim, what it waits
on), read as plain data by `readRunState`.

**Registry**: The jigs tables in the World's Postgres; today only
`jigs_resources`.

**Release**: Removing a finished run's eligible resources under the factory's
or workflow's release policy. The service applies it after a run ends and
reconciles missed ones on a timer. Dirty or unmerged work is kept, and remote
branches are never deleted: prune lists the ones runs left on GitHub.
_Avoid_: teardown (for the request), gc

**Kept resource**: A resource release left in place, by policy or because a
safety check refused, such as a worktree with uncommitted work.
_Avoid_: orphan, abandoned

**Resource prune**: `jigs resources prune`: the operator's override of the
release policy. It previews what release kept, failed or never decided for
this factory's finished runs, and with `--apply` releases what passes the same
safety checks as release.
_Avoid_: sweep, cleanup job

## Agents

**Harness**: An agent program jigs spawns (Claude Code, Codex, Pi) that owns
the agent loop, tools and session.
_Avoid_: model, backend

**Harness descriptor**: The plain data a workflow builds to name a harness,
`harnesses.claude({ model, ...settings })` and the like. For Claude Code and
Codex it is the provider's own settings type, kept to the keys whose values are
data and minus a policy deny list (`ClaudePolicyKey`, `CodexPolicyKey`); Pi's
is jigs-shaped. The driver spreads the settings first and its policy last.
_Avoid_: harness options, harness config

**Agent runner**: What `createAgentRunner` in `@jigs-ai/jigs/steps` returns: a
Claude Code or Codex harness opened inside a factory's own step, with the same
checks, environment, lock and private home as the built-in agent step, and the
live provider model. The built-in step runs on it too.
_Avoid_: executor, injected dependencies

**Model source**: An API endpoint that answers directly, with no agent program.

**Driver**: The step-side code for one harness or model source, in
`src/steps/agents/drivers/`: its checks, environment allowlist, how it reads a
session reference, and supported verbs.
_Avoid_: adapter, provider

**The four verbs**: `runAgent` runs a harness in a directory with tools;
`askAgent` asks a harness for one answer without tools; `askModel` asks a model
source directly; `askJev` asks a model source typed yes-no, choice or score
questions about one state.

**Agent session**: One agent across several turns of a workflow, the live
`AgentSession` from `agentSession()`. It resumes the harness session it holds,
and starts fresh when the step reports that session unusable or the reference
was recorded on another harness.
_Avoid_: role session, resumeOrRebuild

**Session reference**: The small plain data, `AgentSessionRef`, that lets a
later step resume the same harness session: the harness kind, the provider's
session id, and the descriptor it was recorded on. `runAgent` returns it as `session` and takes it as
`resume`; an agent session holds one between turns.
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

**Up**: `jigs up`: bring install, World, migrations, build and the running
service in line with the factory, then run doctor.
_Avoid_: deploy

**Trigger**: A request to create a run: input validation, preflight, then start.
A wake resumes an existing run instead.

**Preflight**: Checking a workflow's declared `requires` before a run exists.

**JIT check**: A check that can only run when a step is about to execute; its
failure becomes a needs-human halt.

**Check catalog**: The one set of checks and repair hints used by preflight,
JIT checks and doctor (`src/checks/catalog.ts`).

**Ingress**: The optional webhook routes that turn provider events into wakes.
The poll wakes parked runs either way; ingress only makes it sooner.
_Avoid_: webhook handler

**Schedule**: A named cron trigger with fixed inputs. A tick is skipped while
the schedule's previous run is still active.
_Avoid_: cron job
