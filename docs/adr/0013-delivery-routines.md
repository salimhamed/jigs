# The pull request delivery engine ships as routines

Status: accepted

The linear-ticket-to-pr recipe carried its own delivery engine, about 750
lines that every factory copied and then edited. A second workflow reached into
one factory's copy, and every fix needed a hand merge into each copy. Under
[0007](./0007-routines-recipes-and-run-resources.md) two callers are the cue to
extract, so the engine moves into jigs as four routines, bound to the
factory's steps in the generated `jigs/routines.ts`:

- `buildAndReview(delivery, { rounds })` returns the reviewed commit, or a stop
  as a value: `rounds-exhausted`, `uncommitted` or `no-commits`, with the round
  it stopped in. A stop pushes nothing; the caller pushes the branch if it
  wants the work on the remote.
- `describePullRequest(delivery, { commit, check? })` has the writer write the title
  and body. The caller's `check` returns problems; the writer is sent back once
  with them, and a second answer with problems throws.
- `publishPullRequest(delivery, { commit, title, body, draft? })` pushes
  exactly `commit`, opens the pull request and records it. No agent runs and
  it needs no review.
- `followPullRequestToOutcome(delivery, pr, options)` returns `"merged"` or
  `"closed"`.

Each routine types its delivery as only the fields it reads; the full
`Delivery<W>` satisfies all four.

The engine is closed and the workflow extends it:

- **Prompts are the caller's.** `DeliveryPrompts<W>` names each prompt and the
  facts it receives; jigs ships no wording. The engine appends only the line
  that states the answer shape it parses, and owns the output schemas. Rules
  about behaviour, such as what makes a finding blocking or when to ask for a
  person, are prompt wording. An upgrade never changes what an agent is told.
- **Policy is the caller's.** Budgets and `approvalCovers` are required
  arguments, and so are three rules: `wake` (which snapshot facts wake the
  builder; `builderWakeFacts` is the default a caller passes), `mergeWhen`
  (consent to merge a snapshot, which can only make merging stricter than
  GitHub's readiness) and the optional describe `check`. Needs-human, a blocked
  merge included, is one callback carrying facts, with local paths scrubbed;
  the workflow words every note and picks its destination.
- **Sessions are the caller's.** The workflow creates the builder, reviewer
  and optional writer sessions. Separate session objects keep deliveries'
  conversations apart; a session's name only labels its log lines.
- **`work` is opaque.** Only the caller's prompts read it.

The mechanics stay inside: recovery of unpublished work, the head-lag
rechecks, merging only published work that GitHub reports ready, ten merge
tries 30 seconds apart, needs-human dedupe (never the same facts twice in a
row, which also covers a blocked merge on one head), telling the builder which
wake facts are new, and `blocking` deciding a review.

A delivery's `key` scopes the markers on its pull request notes, so a workflow
gives each pull request its own key. jigs does not check it.

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
  in jigs (an upgrade would silently change agent behaviour), and any key
  claim. A durable claim would add steps to every run; an in-memory one caught
  only one mistake within a run and was removed.
