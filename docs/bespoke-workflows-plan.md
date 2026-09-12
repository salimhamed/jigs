# Agent-authored workflows: implementation plan

Status: agreed direction and implementation sequence; implementation is pending
at the time of this document. Recorded 2026-09-12. This is the handoff for future
sessions changing jigs or either factory. It distinguishes user-confirmed
constraints from capabilities to prove; it does not supersede existing ADRs.

## Objective

An agent can author a bespoke TypeScript workflow in a factory, build and deploy
it, launch it, and monitor it. Workflows may serve one work item, run repeatedly
on a schedule, or start from an external event. One work item may span many repos.
Factories own process and policy; jigs supplies reliable execution operations.

## Why this direction

Each engineer may accumulate many workflows in a factory: a single ticket's
implementation, a recurring investigation, or an incident response. Agents will
usually author their own prompts and workflow shape, and may launch and monitor
ad hoc runs themselves. The current ship workflows make a configured delivery
recipe convenient, but that recipe cannot anticipate all these processes.

The intended product is a general execution framework an agent can use during
its work. Its value is handling durable execution, sessions, workspaces and
external events consistently while leaving the process visible in factory code.
Workflow colocation lets an author find and change a whole bespoke task without
traversing unrelated top-level code-kind directories. Files still distinguish
replay-safe orchestration from effectful steps; colocation does not relax that
runtime boundary.

Three requested use cases guide the experiments:

1. Given a parent Linear ticket, implement its subtasks as concurrently as their
   declared dependencies allow. Use Codex for implementation and an independent
   Claude Code reviewer, loop as needed, and ask the user questions on Linear.
2. Given Slack context about a bug, coordinate up to five researchers across
   company repositories, synthesize findings into a Linear ticket, then plan,
   build and review with separate agents until a PR is ready. Report the PR in
   Slack and tag an engineer for review.
3. On a PagerDuty page, investigate, create a ticket, escalate urgent issues to
   the on-call engineer, and open a PR when a fix is possible. Scheduling must
   remain available alongside event-driven and manually launched workflows.

These are target behaviors, not integrations already implemented or permission
to contact people during the refactor. The staged experiments deliberately
exercise distinct shapes before extracting a general API.

## Confirmed constraints

- Generating code before each run is sufficient. Runtime code generation or
  modification of remaining work is unnecessary.
- Building and deploying the factory before launch is acceptable. Keep the
  existing service and Workflow SDK foundation.
- Workflow code determines concurrency. Five concurrent researcher branches
  are sufficient; jigs does not need a researcher scheduler or global limit.
- Each concurrent researcher gets its own local worktree, including for tests
  and prototypes. Preserve the existing exclusion of concurrent agents in one
  working directory. Research worktrees can be torn down after their work ends.
- Harness conversations must be continuable across builder/reviewer loops.
  Builder and reviewer use independent sessions; each can retain its own history.
- GitHub comments and Linear answers must be able to reach waiting workflows.
- Scheduling remains supported, and work may span multiple repositories.
- Prompts and workflow shape are usually specific to the workflow being authored.

Fixed code can still inspect inputs, traverse dependencies, branch on results,
and repeat loops. Workflow-defined concurrency must also govern replenishment:
for a variable task list, start another task only when an existing slot finishes.
Launching every item with Promise.all would not impose a five-task limit.

## Intended ownership

| Jigs | Factory and workflow |
| --- | --- |
| Durable harness calls, session continuation and observable failure | Agent roles, prompts, harness choices, review rules |
| Worktree provisioning, ownership and explicit cleanup operations | Repository selection, branches, prototype retention decisions |
| Verified event ingress and reliable routing to runs | Event subscriptions, questions, escalation and notification policy |
| Scheduling execution and run inspection | Schedule declarations and desired scheduling behavior |
| Run launch, status, cancellation and recovery | Dependency traversal, concurrency, iteration budgets and completion criteria |
| Optional integration operations and reusable recipes | Ticket structure, PR conventions and engineering process |

Keep deliverChange available as an optional recipe. Do not require it for the
experiments, or extend its options to accommodate every new workflow shape.
Keep the package together until an actual packaging problem warrants a split.

## Current evidence

- Both factories' ship workflows primarily configure jigs' delivery process.
- The JS factory's s3-bucket-analysis workflow already owns its process using
  runAgent, askModel, scratch directories and custom steps. Preserve it as a
  working example and regression reference.
- runAgent accepts a resume pointer. resumeOrRebuild can start a new conversation;
  that is different from successfully resuming the original context.
- The delivery implementation resumes some roles, but starts its implementation
  reviewer fresh on each round (src/blocks/delivery/bind.ts).
- executeAgent locks its working directory. Keep this guarantee.
- Worktree provisioning currently assumes ticket claiming prevents competing
  requests (src/steps/worktree/index.ts). Independent workflows need ownership
  correctness without depending on a ticket-specific protocol.
- The registry permits multiple worktrees per run. Delivery narrows its inputs
  to one worktree; do not confuse that recipe restriction with a runtime limit.
- GitHub/Linear ingress wakes resource-scoped listeners and drops deliveries
  without a listener. It does not supply general event-triggered run creation.
- Schedules currently skip missed ticks and overlapping runs of the same schedule,
  and interpret cron in host-local time. Preserve and document these defaults
  initially; expand configuration only when a concrete workflow needs it.

Recheck source and installed factory versions when implementing; these findings
describe the local checkouts inspected during this discussion.

## Delivery sequence

The immediate authorized work is to publish this plan, then refactor the
personal factory followed by the JS factory. The experiments below follow that
layout work; their live inputs and communication scope remain to be selected.

### 1. Refactor existing factories without changing their process

Start with `jigs-factory-personal`, then apply the validated layout to
`jigs-factory-js`. Locate the actual checkouts and read each factory's agent guide,
configuration and CI before editing. Keep dependency versions and delivery
policy unchanged during this stage.

Move workflow-specific orchestration, custom steps, prompts and tests beside
one another. Keep generated root `jigs.ts` in place. Put code shared by actual
workflows in `shared/`; create neither empty directories nor speculative shared
abstractions. A representative target is:

```text
workflows/
  ship/
    workflow.ts
    prompts.ts
  s3-bucket-analysis/
    workflow.ts
    steps.ts
    prompts.ts
    workflow.test.ts
shared/                    # only when existing workflows share custom code
jigs.ts                    # generated integration; stable location
jigs.config.ts
```

File names and the number of files should fit the existing code. A workflow may
need only `workflow.ts`. Keep pure helpers and effectful implementations in
separate modules as needed to preserve replay safety. Update registrations,
imports, build discovery, emitted-ID assertions and factory documentation.
Keep jigs' internal code-kind layout and public exports unchanged.

Moving workflow functions or custom step wrappers changes their durable IDs.
Capture the old and new emitted IDs and enumerate intentional changes. Prepare
and validate the refactor before deployment; affected active runs must finish
or be explicitly cancelled before deploying incompatible addresses or logic.
An inability to inspect active runs is an unverified deployment prerequisite,
not evidence that no runs exist. Cancellation requires separate authorization.

Acceptance:

- Personal factory is validated before beginning the JS refactor.
- Existing workflow inputs, prompts, policies and outputs remain unchanged.
- Each workflow's custom code is discoverable within its directory, with shared
  code identified by its real consumers.
- Generated wrappers retain their addresses; every moved workflow/custom-step
  address has an intentional, reviewed change in the build assertions.
- Each factory passes its required checks, including nested workflow/custom-step
  discovery and built-bundle safety checks where available.
- The handoff records checks run, changed durable IDs and deployment status.
  Local validation alone is not reported as deployment or replay verification.

### 2. Prove the authoring shape with a small factory workflow

Start in the personal factory with a bounded build/review experiment, using
existing low-level operations rather than deliverChange. Choose a small real
ticket at implementation time. Begin with one implementation worktree, a Codex
builder, a Claude reviewer, workflow-local prompts, and a finite review loop.

Use a new workflow directory with workflow.ts, steps.ts, prompts.ts and tests as
needed. Keep generated jigs.ts in place. Reuse the proven colocation convention.
Confirm the build discovers the new custom steps and records their addresses.

Acceptance:

- A second builder turn and second reviewer turn continue their respective
  conversations; verify provider session identity as well as returned content.
- A missing or unusable session is explicit. Any fresh-context reconstruction
  is a workflow choice and observable, not reported as successful continuation.
- Build, deploy, launch and monitoring use the existing factory commands.
- The agent can find all workflow-specific code within its directory.

If existing calls suffice, make no new session abstraction. If they do not,
change the smallest contract necessary and add a meaningful recovery test.

### 3. Extend to the parent-ticket workflow

Read subtasks and dependencies through factory-local steps. Keep dependency
coordination in ordinary workflow code. Give concurrently implemented subtasks
separate worktrees and separate builder/reviewer sessions. Correlate each human
question to its answer on Linear. Stop at a reviewable PR for the experiment.

Resolve these choices in the workflow before launch: whether a dependency means
reviewed or merged, how successor branches obtain predecessor changes, and
whether the work produces separate PRs or an integrated PR. These are per-workflow
policy choices, not missing framework decisions.

Acceptance:

- Independent subtasks overlap; dependent subtasks start only after their stated
  prerequisites and see the intended predecessor revisions.
- Cycles, unknown dependencies and failed prerequisites have explicit outcomes.
- Two pending questions on the same ticket cannot consume each other's answers.
- Restart during a human wait resumes without repeating completed agent calls.

### 4. Build the five-researcher, multiple-repo experiment in the JS factory

Author the Slack investigation with five explicit concurrent researcher branches.
A lead can prepare assignments and synthesize results within the fixed workflow;
the workflow launches the researchers. Each researcher owns its own worktrees.
Use factory-local operations for Slack intake, ticket creation and PR reporting.
Follow research with separate planning, implementation and review steps.

Add a scoped worktree release operation if existing cleanup cannot express
research completion. Preserve research reports and any selected patch artifacts
outside the worktrees before release. The workflow explicitly decides which
prototype changes are disposable. Cleanup must account for failed/cancelled work,
unfinished agent processes and durable retries; never delete a still-used tree.

Acceptance:

- At most five researcher branches run concurrently, as defined in code; harness
  internal delegation is not used to enforce this concurrency model.
- At least two repositories participate in one work item.
- Researchers can create files and run tests without interfering with each other.
- Retained findings survive cleanup; one researcher's cleanup cannot remove a
  sibling's tree or an implementation tree belonging to the same run.
- A PR and its originating Slack context remain linked in the run's results.

### 5. Generalize events through the PagerDuty experiment

Use a verified PagerDuty event to start a triage workflow. Route later incident
updates to the intended run. Keep urgency thresholds, on-call lookup, escalation
and whether to attempt a fix in factory code. Urgent escalation should have a
path that does not wait for exhaustive research. Retain a scheduled workflow as
an acceptance case alongside event-triggered and manual runs.

Design event-start deduplication and correlation before enabling live triggers.
For human answers and other early events, establish how they remain recoverable
if no waiter is registered yet: persisted delivery or provider-state reconciliation
with a reliable wake/recheck path. Do not assume a hook alone guarantees this.

Acceptance:

- Duplicate deliveries do not create duplicate incident runs or notifications.
- An answer arriving before suspension is still observed.
- Restart between receipt and handling does not lose the work.
- Existing GitHub/Linear waits still work, and scheduled launches still work.

### 6. Extract proven operations and improve the scaffold

Compare the experiments and extract repeated execution complexity. Prefer a
small interface over adding options to delivery. Keep workflow-specific loops,
prompts and integration policy local even if their code is short and repetitive.

Update jigs init, the author/operate guides, and factory import conventions to
make the demonstrated layout the normal path. Offer delivery as an example.
By this stage the existing ship workflows will have moved during stage 1;
change their process or API usage only when the experiments demonstrate concrete
value.

## Decisions to revisit explicitly

- [ADR 0019](adr/0019-layout-by-code-kind.md) currently describes factory custom code in separate root workflows,
  blocks and steps directories. Workflow colocation revises that factory
  convention, while retaining jigs src's code-kind layout and replay safety.
  Record the implemented factory convention and its rationale in the factories;
  revise the jigs ADR/scaffold convention when adopting the demonstrated layout
  generally. This plan records the departure without rewriting that ADR early.
- [ADR 0007](adr/0007-worktree-lifecycle.md) centers lifecycle policy on delivery and merged worktrees. Scoped
  release of disposable research trees extends that policy and needs a documented
  artifact/retention contract. Its prose also contains historical inconsistencies;
  verify the implementation rather than treating every paragraph as current.
- [ADR 0009](adr/0009-webhook-ingress-resource-scoped-tokens.md) specifies stateless ingress with resource-scoped tokens. Persisted
  delivery or more general correlation would revise that decision. Preserve
  useful resource exclusivity without making it the only routing mechanism.
- [ADR 0013](adr/0013-factory-owned-steps.md)'s factory-owned durable addresses remain. Build/deploy is accepted,
  but changing workflow logic can still break active replay without moving IDs.
  Initially preserve active workflow definitions and finish/cancel affected runs
  before incompatible deployments. Adding new definitions must be tested while
  another run is suspended. Version-pinned execution is deferred unless needed.

## Focused investigation and validation

Investigate installed harness providers and SDKs only to answer a concrete gap:
session storage/continuation, interrupted-turn recovery, cancellation, or access
to multiple worktrees. Broad Claude SDK source research is not a prerequisite.

For each experiment, record the smallest implementation, caller friction, any
proposed extraction, and observed failure behavior. Retry after partial external
side effects deserves particular attention: durable steps do not make arbitrary
agent actions or external writes exactly-once.

For jigs implementation changes run pnpm check and pnpm e2e. Use Postgres-backed
live checks for claims about restart, suspension and service lifecycle. For each
factory follow its own CI sequence, including building before tests that inspect
emitted IDs. Mocks alone cannot establish session continuation or replay safety.

This plan does not select live tickets, enable event subscriptions, or authorize
Slack/Linear/PagerDuty messages. Select the real inputs and communication scope
when running each experiment. No further framework-level clarification blocks
starting the factory layout refactor.
