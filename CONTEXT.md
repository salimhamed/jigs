# jigs

The vocabulary a maintainer meets in `packages/jigs/src/`. Use these words in code, comments
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

**Outcome**: How a routine that can end short ended, named by the `outcome`
field of the object it returns, such as `stopped` or `timed-out`. That ending's
facts sit beside it. Not an error: errors throw.
_Avoid_: status

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

**Needs-human halt**: A suspension that asks a person, in the run's Linear
agent session, to answer a question or fix a problem; any reply there lets the
workflow continue.
_Avoid_: failure, abort

**Wake**: A signal that makes a suspended run recheck its condition: a provider
event from the hub, or `jigs poke`.

**Claim**: A run-long hold on a ticket, keyed by a hook token that names it, so
a second active run cannot take it. It carries the Linear agent session the run
talks to people in. Nothing wakes it.
_Avoid_: lock, lease

**Session hook**: The hook a run holds for its whole life on the Linear agent
session it talks in, keyed by a token that names the session, so a second run
cannot take it. It marks the owner; nothing wakes it.
_Avoid_: session claim, session lock

**Listening hook**: The hook a run holds only while it reads what people send
in its Linear agent session: during a conversation or a needs-human halt. A
wake on it makes the run read the session's prompts again. A prompt that
arrives while the owner holds none waits for the run to listen again.

## Resources

**Binding**: A named target repository in `jigs.config.ts`, with its remote,
the GitHub installation name that reaches it, and how jigs merges and
provisions worktrees there.

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
such as `harnesses.claude({ model })`. For Claude Code it is the Claude Agent
SDK's own options type, and for Codex the provider's settings type, minus the
keys jigs owns.
_Avoid_: harness options, harness config

**Model source**: An API endpoint that answers directly, with no agent program.

**Driver**: The step-side code for one harness or model source: its checks,
environment, session handling and supported verbs.
_Avoid_: adapter, provider

**The four verbs**: `runAgent` runs a harness in a directory with tools;
`askAgent` asks a harness for one answer without tools; `askModel` asks a model
source directly; `askJev` asks a model source typed yes-no, choice or score
questions about one state.

**Agent runner**: A Codex harness opened inside a factory's own step, with the
same checks, environment and isolation as jigs' agent step.
_Avoid_: executor, injected dependencies

**Agent session**: One agent across several turns of a workflow. It resumes the
harness session it holds, and starts fresh when that session is unusable.
_Avoid_: role session, resumeOrRebuild

**Linear agent session**: Linear's thread between people and a Linear app on
one issue, opened by a mention of the app, an assignment to it, or a ticket run
at its claim. One a person opened is the `linear.agentSessions` source's
occurrence. Not an agent session.

**Ticket note**: A message a ticket run posts in its Linear agent session that
asks for nothing. Its `run` says what the run does next: an `ended` note ends
the session, as a response even when the run failed; a `waiting` one leaves
it awaiting input, so it never goes stale while the run waits on people.

**Conversation**: One Claude session answering in one Linear agent session, run
by one run: turns until it goes idle, someone stops it, or a turn fails.
_Avoid_: chat, thread

**Turn**: One agent call in an agent session or a conversation. A conversation
turn also takes the replies that arrive while it runs, and ends once Claude has
answered every message it took.

**Live turn**: A conversation turn running in this service process, which can
take a reply or a stop directly, without waking the run.

**Prompt**: A message a person sent into a Linear agent session: a reply, or a
stop when they pressed the stop button. Linear holds every prompt, so a run
re-reads them rather than trusting a wake to carry one.
_Avoid_: comment (for the session's own messages)

**Consumed**: A prompt a turn took. The prompt ids a conversation has consumed
are its cursor: the next turn takes every prompt not among them, so a turn
retried after a crash neither drops nor repeats one.

**Idle timeout**: How long a conversation waits for a reply before it ends and
the run goes on (`idleFor`).

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

**Factory context**: Which factory a process answers for: its root, slug,
configuration and environment. The service resolves it at boot, a CLI verb for
the factory it was typed in, and step code reads the process's own through
`currentFactoryContext()`; everything below takes it from them.
_Avoid_: credential root, factory root (for the whole of it)

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

**Source**: What an event trigger watches: one installation, and the
provider's own query parameters, such as a PagerDuty service's incidents or a
Slack channel's messages. It takes only events from its installation.
_Avoid_: filter, feed

**Occurrence**: One provider event a source counts as a reason to start a run,
such as a new incident or a top-level message. An event trigger starts at most
one run per occurrence, ever.
_Avoid_: event (for the deduplicated unit), delivery

**Preflight**: Checking a workflow's declared `requires` before a run exists.

**JIT check**: A check that can only run when a step is about to execute; its
failure becomes a needs-human halt.

**Check catalog**: The one set of checks and repair hints used by preflight,
JIT checks and doctor.

## Hub

**Hub**: The separate service that receives every provider event and holds
every app's credentials for the factories of its Organizations.
_Avoid_: relay, gateway, server

**Organization**: The group a hub serves as one: its members, apps, factories
and their provider events. Usually one company.
_Avoid_: team, workspace, tenant

**Provider**: An outside service jigs works with: GitHub, Linear, Slack or
PagerDuty.
_Avoid_: integration, vendor

**App**: An Organization's own identity on a provider, such as a GitHub App, a
Linear OAuth app, a Slack bot or a PagerDuty connection. A provider can have
several.
_Avoid_: integration, connection or bot (for the general term)

**Sign-in app**: The GitHub OAuth App people sign in to a hub's web pages
with. One per hub, set in the hub's environment; it is not an **App** in the sense above, belongs to
no Organization, and no factory uses it.
_Avoid_: OAuth app, login app, GitHub app (for this one)

**Installation**: Where an app is installed or connected: a GitHub account, a
Linear workspace, a Slack workspace or a PagerDuty account. Tokens are for one
installation.
_Avoid_: workspace, connection (for the general term)

**Installation name**: The name an admin gives an installation on the hub,
such as `slack-js` or `linear-personal`, which factories use to say which
installation they mean. Lowercase letters, digits and hyphens, starting with a
letter, and unique in the Organization. `installationName` in code. Every token
request, binding, step, harness, trigger and wait names one; nothing picks "the
only one". An installation the hub learned of by itself has none until an
admin sets it, and until then gets no tokens and its events reach no trigger
or wait.
_Avoid_: alias, label, account (the provider's own name for where it is installed)

**Assignment**: An app allowed to a factory. A factory receives provider events
from, and gets tokens for, only its assigned apps.
_Avoid_: subscription, grant

**Provider event**: One notification a provider sent through an app, kept as
received. It carries its installation's name, read when the factory collects
it, so naming an installation later labels its earlier uncollected events;
`null` while unnamed. In a factory it becomes a wake, an occurrence, or nothing.
_Avoid_: webhook (for the general term), delivery, message

**Message**: One entry in a factory's ordered list on the hub, which the
factory confirms in order. Its kind is `event`, carrying a provider event, or
`fellBehind`, telling the factory the hub dropped events it never confirmed,
so every waiting run re-reads its provider.
_Avoid_: delivery, notification

**Event log**: A factory's messages as the hub keeps them, confirmed or not,
until the retention expires.
_Avoid_: queue, inbox

**Factory token**: The secret a factory proves itself to its hub with, shown
once when the factory is added.
_Avoid_: API key, hub key
