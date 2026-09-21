# jigs

Durable workflows that combine agent reasoning, model calls, and external operations.
Factories define their processes; jigs supplies reusable execution and domain blocks.

## Language

**Workflow**:
A complete process, defined once and reused across many runs.
_Avoid_: pipeline, flow, DAG

**Jig**:
The project name, from the manufacturing fixture that guides a tool through a
repeatable operation. Reusable workflow code is called a block.
_Avoid_: jig as a code term, sub-jig

**Block**:
Reusable workflow coordination that combines steps and replay-safe decisions.
Both jigs and factories supply blocks; a block has no independently recorded
result.
_Avoid_: building block, composition, flow, sub-workflow, primitive, helper,
util

**Prompt**:
A typed function beside the code that uses it, producing the instructions
given to an agent. Factories can override shipped prompts at a call site or
through a custom block that supplies shared defaults.
_Avoid_: template

**Step**:
A durable unit of work whose attempts and result the runtime tracks. Agent
steps drive coding agents, model steps make plain model calls, and function
steps perform other operations.
_Avoid_: node, task, stage

**Step id**:
The runtime address of a durable step, determined by its location and name.
Factory-local addresses are independent of the installed jigs version, but
renaming or moving a step changes its address.
_Avoid_: step key, step name, cache key

**Step wrapper**:
A factory-local durable function that delegates to a library implementation.
It establishes the durable address of that operation within the factory.
_Avoid_: shim

**Run**:
One execution of a workflow, including any suspensions and resumptions.
It survives the terminal that launched it.
_Avoid_: job, execution

**Binding**:
A named target repository, its repository-specific policy, and the provisioning
settings for its worktrees.
jigs maintains its own clone for each binding; the operator’s checkout is separate.
_Avoid_: registration, registry, target, checkout

**Binding clone**:
The repository copy jigs maintains for a binding and uses as the source of
its worktrees. It is managed by jigs rather than edited by an agent.
_Avoid_: mirror, cache, bare repo

**Factory repo**:
The user-owned repository containing workflow definitions, configuration and
custom code. It pins the jigs library and runs its own service.
_Avoid_: workflows repo, config repo

**jigs package**:
The single distributed library and CLI that provides blocks, step
implementations, service code and factory templates.
_Avoid_: the checkout, link:, @jigs/service, @salimhamed/jigs-service, the
jigs packages (plural), the jigs repo (as a dependency)

**Factory-supplied runtime**:
The workflow runtime, persistence backend, dashboard and schema library
installed by the factory at versions compatible with jigs.
_Avoid_: transitive deps, runtime deps, peer set

**Scaffold**:
The bare starting point a new factory receives: configuration, generated
integration and one trivial workflow. It presumes no process; recipes are
copied in separately. Those files become factory-owned.
_Avoid_: generated integration (for factory-owned code), starter kit

**Recipe**:
A complete workflow jigs ships as source and a factory copies in when it
wants that process. Once copied it is factory code, edited freely. The ship
process is a recipe.
_Avoid_: template (for a whole workflow), built-in workflow, example

**Run resource**:
Something a run creates or holds that jigs records against the run: a
worktree, a run directory, a pull request, a branch, a ticket comment. The
record is what listing and release read.
_Avoid_: artifact, side effect (for the thing itself), output

**Generated integration**:
The committed factory-local connection between shipped blocks and their
durable steps, maintained by jigs. Factory-specific behavior lives outside it
in custom blocks and steps.
_Avoid_: custom code

**Up**:
The operation that brings a factory’s installed dependencies, persistence,
built code and running service into agreement with its current configuration.
_Avoid_: deploy, bootstrap (for the whole), start (for the whole)

**Suspension**:
A run waiting for an external condition before it can continue. A suspended
run remains active and retains its worktrees.
_Avoid_: pause, block

**Satisfier**:
The external condition that permits a suspended run to continue, such as a
human reply. The run rechecks it whenever a wake arrives.
_Avoid_: trigger, wake condition

**Gate**:
An expected waiting point in a workflow, such as waiting for pull-request
review, CI results or closure.
_Avoid_: checkpoint, approval step

**Needs-human halt**:
A suspension that asks a human to resolve a question or repair a problem on
the ticket. A verified reply allows the workflow to continue or retry.
_Avoid_: failure, abort

**Worktree**:
The working copy an agent uses, provisioned from a binding’s clone for a run.
A workflow releases it as its last act, under a policy the factory defaults
and the workflow may override; leftovers remain available for inspection and
resource pruning.
_Avoid_: checkout, clone, workspace

**Release**:
The end of a run resource a workflow requests once its work is done, applied
under the factory's default policy or the workflow's own. Release never
deletes a branch holding commits the remote lacks.
_Avoid_: teardown (for the request), cleanup, gc

**Worktree registry**:
The record of worktrees managed by jigs, including their owning runs and
states. It supports reuse and reconciliation.
_Avoid_: worktree list, worktree cache

**Resource prune**:
The explicit maintenance of recorded run resources after inspection. Preview
reports what is eligible or preserved; apply removes only resources that pass
the ownership and safety checks.
_Avoid_: sweep, gc, cleanup job

**Abandoned worktree**:
A worktree remaining after its owning run ended or was interrupted.
It may be eligible for resource pruning; a suspended run’s worktree is not
abandoned.
_Avoid_: orphan, stale worktree

**Harness**:
An agent program jigs spawns, such as Claude Code, Codex or Pi. A harness owns
the agent loop and may use tools, a worktree and a resumable session.
_Avoid_: model, model source, backend, sandbox

**Model source**:
An API endpoint from which a model answers directly, without an agent program.
_Avoid_: harness, provider CLI, agent

**Driver**:
The step-side implementation that hydrates one model source or harness,
declaring its checks, environment allowlist, session metadata and execution verbs.
_Avoid_: adapter, backend, provider

**runAgent**:
Run a harness with a working directory, tools and optional session continuation.
_Avoid_: askAgent, askModel, askJev

**askAgent**:
Ask a harness for one answer without a working directory or tools.
_Avoid_: runAgent, askModel, askJev

**askModel**:
Ask a model source directly through its API driver.
_Avoid_: runAgent, askAgent, askJev

**askJev**:
Ask a model source to judge, evaluate or verify an artifact under a dedicated contract.
_Avoid_: runAgent, askAgent, askModel

**Activation**:
One execution of a run’s workflow body following launch or a wake.
Recorded step results allow it to replay prior decisions.
_Avoid_: session, attempt

**Snapshot**:
A captured view of a Linear ticket that a workflow uses as evidence.
Ticket review refreshes it after a human reply before reviewing again.
_Avoid_: cache, mirror

**Builder**:
The agent responsible for implementing a run’s change. Its session is reused
when possible, or rebuilt from the run’s record when necessary.
_Avoid_: implementer, author agent

**Ingress**:
The service’s entry point for provider webhooks, translating external
activity into wakes for existing runs.
_Avoid_: webhook handler, receiver, endpoint

**Wake**:
A notification asking a suspended run to recheck its satisfier.
A webhook, manual poke or reconciliation can supply it.
_Avoid_: trigger, notification

**Claim**:
A run-long hold on an external resource that prevents another active run
from claiming the same resource.
_Avoid_: lock, lease

**Ticket review**:
The block that turns a ticket into an implementation brief, asking a human
when clarification is needed. It returns a handoff when review can proceed.
_Avoid_: intake, triage

**Ticket status**:
The named state a workflow sets on its work item to reflect its own progress.
The workflow owns both the names and when it changes them.
_Avoid_: lifecycle state machine, tracker configuration

**Delivery**:
The whole of carrying a work item to a merged or closed pull request:
implementation, code review, publication, pull-request feedback, CI repair and
merge or closure, under factory-selected policy. It is a process a recipe
describes, not a block jigs ships.
_Avoid_: shipping, the pipeline, the review loop (for the whole)

**Review loop**:
The part of the ship recipe that repeats implementation and code review until the
review approves or the round budget runs out. The reviewer retains its session
across rounds.
_Avoid_: build loop, PR loop, the whole delivery

**Blocking finding**:
A review finding that sends the round back to the builder: a stated requirement
left unmet, a defect a user could hit, or an untested risk that matters.
Everything else is non-blocking — preferences about naming, structure,
comments, extra test cases and wording — and is kept in the pull request
description instead of failing the round.
_Avoid_: nit, blocker, P1

**Findings ledger**:
The ordered record of the ship recipe’s review rounds: findings, verdicts and
builder responses. It supplies context when a reviewer’s session is lost.
_Avoid_: history, transcript, review log

**Budget**:
The number of rounds or attempts a phase of the ship recipe may spend before
stopping or asking a human. A continuation extends only the exhausted phase’s
budget.
_Avoid_: limit (for the number), retries, max, quota

**Round**:
One implementation attempt plus its review, or one batch of pull-request
feedback answered, in the ship recipe. Each counts against its phase’s budget.
_Avoid_: iteration, loop, pass

**Attempt**:
One try by a phase’s agent in the ship recipe. CI repair counts individual
attempts; implementation review and pull-request feedback count rounds.
_Avoid_: retry (for the first try), run

**Brief**:
The implementation plan produced by ticket review. The ticket remains the
authoritative definition of done.
_Avoid_: plan, spec

**Ticket handoff**:
The brief and the ticket snapshot from which it was produced, passed together
to builder blocks. The ticket takes precedence when they conflict.
_Avoid_: handoff (without ticket context), context, payload, the brief (for the pair)

**Preflight**:
Verification that a workflow’s declared requirements and service credentials
are available before creating a run.
_Avoid_: health check, validation, smoke test

**Check catalog**:
The shared set of requirement checks and repair instructions used before
launch, during steps and when inspecting factory health.
_Avoid_: validators, checkers

**JIT check**:
Verification of requirements that become known only when a step is about to
execute. Failure can produce a needs-human halt.
_Avoid_: runtime check, lazy check

**Managed Codex home**:
The jigs-managed Codex configuration that supplies an agent step’s selected
capabilities while retaining the operator’s authentication.
_Avoid_: isolated home, custom home, sandbox home

**Service**:
The long-running process owned by a factory that executes workflows,
accepts triggers and wakes, and hosts the dashboard.
_Avoid_: server, daemon, worker, container

**Dashboard**:
The factory’s run-history interface, showing durable step attempts and events
from the same persistence backend as its service.
_Avoid_: observability UI, web, console

**Trigger**:
A request to create a new run, including input validation and preflight.
A wake resumes a run that already exists.
_Avoid_: launch endpoint, kickoff, start route

**Schedule**:
A named recurring trigger with a workflow, cron expression and fixed inputs.
Missed ticks and ticks overlapping its previous active run are skipped.
_Avoid_: cron job, timer, recurring run

**World**:
The workflow runtime’s persistence and queue backend, dedicated to one
factory’s runs.
_Avoid_: backend, database, store

**Work item**:
The requirements a delivery process implements, independent of their source.
_Avoid_: Linear ticket (for a source-independent work item)

**Run directory**:
A scratch directory retained for a run while it is active, without a Git repository requirement.
_Avoid_: worktree (for a directory without a repository)
