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
- `publishPullRequest(delivery, { commit, pullRequest? })` describes the diff,
  lets the caller reshape the title and body or open a draft, pushes exactly
  `commit`, opens the pull request and records it. It needs no review.
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
- **Sessions are the caller's.** The workflow creates the builder, reviewer
  and optional writer sessions. Separate session objects keep deliveries'
  conversations apart; a session's name only labels its log lines.
- **`work` is opaque.** Only the caller's prompts read it.

The mechanics stay inside: the wake rules, recovery of unpublished work, the
head-lag rechecks, merging only published work, ten merge tries 30 seconds
apart, needs-human dedupe, one blocked-merge callback per head, and `blocking`
deciding a review.

## Delivery keys

A delivery's `key` scopes the markers on its pull request notes. Markers live
on one pull request, so keys collide only when two deliveries share a pull
request, which means they share a worktree's branch. Each routine records the
worktree path under the run and key in a module-level map, and throws when the
same key arrives with a different worktree. Copies of one delivery, such as
`{ ...delivery, writer }`, pass. The Workflow SDK evaluates the bundle once per
run session and runs the workflow once in it, so the map holds only that
session's keys and is rebuilt identically on replay. It records nothing
durable.

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
