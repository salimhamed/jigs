# The pull request delivery engine ships as routines

Status: accepted

The linear-ticket-to-pr recipe carried its own delivery engine, about 750
lines that every factory copied and then edited. A second workflow reached into
one factory's copy, and every fix needed a hand merge into each copy. Under
[0007](./0007-routines-recipes-and-run-resources.md) two callers are the cue to
extract, so the engine moves into jigs as three routines, bound to the
factory's steps in the generated `jigs/routines.ts`:

- `buildAndReview(delivery, { rounds })` returns the reviewed commit, or a stop
  as a value: `rounds-exhausted`, `uncommitted` or `no-commits`, after pushing
  the branch when it can.
- `publishPullRequest(delivery, { commit, body? })` describes the diff, pushes
  exactly `commit`, opens the pull request and records it. It needs no review.
- `followPullRequestToOutcome(delivery, pr, options)` returns `"merged"` or
  `"closed"`.

The engine is closed and the workflow extends it:

- **Prompts are the caller's.** `DeliveryPrompts<W>` names each prompt and the
  facts it receives; jigs ships no wording. The engine appends only the line
  that asks for the answer shape it parses, and owns the output schemas. An
  upgrade never changes what an agent is told.
- **Policy is the caller's.** Budgets, `mergedBy` and `approvalCovers` are
  required arguments. Needs-human and a blocked merge are callbacks carrying
  facts, with local paths scrubbed; the workflow words every note and picks its
  destination.
- **Sessions are the caller's.** The workflow creates and names the builder,
  reviewer and optional writer sessions, so deliveries never collide.
- **`work` is opaque.** Only the caller's prompts read it.

The mechanics stay inside: the wake rules, recovery of unpublished work, the
head-lag rechecks, merging only published work, ten merge tries 30 seconds
apart, needs-human dedupe, and `blocking` deciding a review.

## Delivery keys

A delivery's `key` scopes its pull request markers, so two deliveries in one
run with one key would read each other's notes as their own. Each routine
records the delivery object under its run and key in a module-level map, and
throws when a different object arrives with a key already held. The Workflow
SDK evaluates the bundle afresh for every activation and runs the workflow
once in it, so the map holds exactly the deliveries the current activation has
built and is rebuilt identically on replay. It records nothing durable.

## Consequences

- A change to these routines' step sequence breaks runs parked on the old one,
  so it ships as a breaking release whose notes say to let parked runs finish
  first. `jigs up` lists parked and active runs before any restart, even with
  `--force`.
- Several repositories are several deliveries, run in sequence or with
  `Promise.all`. One agent step still works in one GitHub owner
  ([0012](./0012-agents-act-as-the-factory-app.md)).
- The description is written by the writer session, the builder by default,
  which now resumes its session instead of starting a fresh agent.
- Rejected: one all-in-one routine (no seam between phases), default prompts
  in jigs (an upgrade would silently change agent behaviour), and a durable
  key claim (it would add steps to every run).
