# Jev prototype plan

A proof of concept that uses Jev, TypeSafe's decision model, wherever jigs or a
factory currently spends an agent turn, or a fixed rule, on a question with a
fixed set of answers. This branch may grow into a long-running one.

## Background

Jev takes JSON or text and answers typed questions in 70–500 ms, at
$0.042 per million input tokens. There are three question kinds:

- **yes/no:** returns a probability.
- **choice:** returns an option, a probability for each option, and a confidence.
- **score:** returns a position on an ordered scale.

Jev cannot write text, run tools, or see anything beyond the state it is given.

Jigs already has `askJev` (`src/workflow/agents/jev.ts`). It is a durable step
that calls `typesafe/jev-1.13` through OpenRouter. Nothing calls it yet.

## Decisions

- **Scope:** every candidate site below, first in the jigs library and then in
  jigs-factory-js.
- **Mode:** Jev acts at every site. There is no shadow mode.
- **Low confidence:** when Jev is under a site's cutoff, the site does exactly
  what it does today.
- **Credentials:** one `OPENROUTER_API_KEY`, used locally and in CI.
- **Evals:** basic hand-written cases, run against the live model in CI and
  reported without failing the build.
- **Off limits:** the merge gate, head SHA matching, dedupe markers and
  replay-safe cursors stay exact. Jev may only add a refusal on top of them.

## Phase 1: shared groundwork

**`decide()`**, in `src/workflow/agents/decide.ts`. It wraps `askJev` with one
question, a site name and a cutoff:

```ts
const wake = await decide({
  site: "pull-request-wake",
  state: { ci, failingChecks, newComments, reviews },
  question: choice("What does this pull request need now?", {
    idle: "Nothing for the builder: CI running, bot noise, or already handled",
    builder: "The builder should act on CI, review or discussion",
    human: "A person must decide something the builder cannot",
    merge: "Approved, green, nothing outstanding",
  }),
  cutoff: 0.9,
});
if (!wake.confident) return today();
switch (wake.answer.choice) { ... }
```

- **Model:** one constant, `JEV_MODEL = models.openrouter("typesafe/jev-1.13")`.
- **Decision log:** the `executeJev` step appends
  `{ site, state, answer, cutoff, confident }` to `decisions.jsonl` in the run
  directory. Real runs can then supply eval cases later.
- **Cutoffs:** every site starts at 0.9 and is tuned from eval results.

**Evals**:

- **Location:** `evals/<site>.eval.ts`, run by `vitest.eval.config.ts` with
  `pnpm eval`.
- **Cases:** each file lists 5–10 hand-written cases, each
  `{ name, state, expected }`.
- **Report:** accuracy for each site, how often Jev was confident but wrong,
  and the mean confidence on right versus wrong answers.
- **CI:** a new `evals` job in `ci.yml`, with `continue-on-error: true`. It
  runs when `OPENROUTER_API_KEY` is set and skips itself otherwise, for example
  on fork PRs.
- **Secret:** set with `gh secret set OPENROUTER_API_KEY` on jigs and on
  jigs-factory-js, after confirmation.

## Phase 2: library sites

Each site gets a `decide()` call, an eval file, and unit tests of what it does
with each answer. The unit tests use a stubbed `executeJev`.

1. **Pull request wake**
   - **Where:** `followPullRequest` in `recipes/linear-ticket-to-pr/delivery/delivery.ts`,
     before `builder.run`.
   - **State:** the snapshot, plus the comments added since the last assessed one.
   - **Decides:** idle, builder, human, or merge.
   - **Acts:**
     - idle: record the snapshot as assessed and keep watching.
     - human: `maintenanceStopped`.
     - merge: merge only if `isPullRequestMergeReady` and `mergedBy === "jigs"`.
       Otherwise fall through to builder.
     - builder: run the builder as today.
   - **Fallback:** builder.
2. **Comment triage**
   - **Where:** a new `triageComments` routine in `src/workflow/pull-requests/`.
   - **Decides:** one Jev call with one choice per new comment, keyed by comment
     ID: question, change request, FYI, praise, or automated.
   - **Acts:**
     - The labels feed site 1's state and the maintenance prompt.
     - If every new comment is FYI, praise or automated, and CI has not
       changed, site 1 may skip its call and treat the wake as idle.
   - **Fallback:** comments go unlabeled.
3. **Ticket reply**
   - **Where:** `haltForHuman` in `src/workflow/linear/halt-for-human.ts`, after a
     candidate reply is found. `checkForTicketHumanReply` is a step, so the
     question is asked from the workflow side.
   - **Decides:** yes/no, "does this comment answer what we asked?"
   - **Acts:** no advances the cursor past the comment and keeps waiting.
   - **Fallback:** accept the comment, as today.
4. **Ticket readiness**
   - **Where:** `reviewTicket` in `src/workflow/linear/review.ts`, before the
     reviewer agent runs.
   - **Decides:** a choice of reason: ready, no acceptance criteria, missing
     reproduction, conflicting requirements, or too large for one PR.
   - **Acts:** any reason other than ready halts for a human, with fixed text
     for that reason, because Jev cannot write the question itself.
   - **Fallback:** the reviewer agent runs as today.
5. **Review convergence**
   - **Where:** `implementAndReview`, from round 2 onward.
   - **State:** the ledger of rounds: how many findings each round had, and
     which ones repeat.
   - **Decides:** a score of converging, slow, or stalled.
   - **Acts:** stalled stops early with the open findings.
   - **Fallback:** keep going until the round budget is spent.
6. **Webhook relevance**
   - **Where:** GitHub and Linear ingress in `src/service/app.ts`, before
     `resumeAndLog`.
   - **Decides:** yes/no, "could this event change what the waiting run should
     do?"
   - **Acts:** no records the event and does not wake the run.
   - **Fallback:** wake the run.
   - **Why it is the least valuable site:** wakes are already cheap, because
     `watchPullRequest` drops snapshots that did not change. It is also the
     first Jev call outside a workflow, so it calls the driver directly. A
     wrongly skipped wake is covered by polling nudges.
7. **Builder model choice**
   - **Where:** `recipes/linear-ticket-to-pr/linear-ticket-to-pr.ts`, after
     `reviewTicket`.
   - **Decides:** a score of the ticket and brief on the scale trivial, small,
     medium, large.
   - **Acts:** trivial and small use a lighter builder. The `agents` map gains a
     `builderLight` entry.
   - **Fallback:** the default builder.
8. **Failure triage**
   - **Where:** the recipe's error handling, for an agent or step error that is
     not `DeliveryStopped`.
   - **Decides:** transient, needs a human, or a jigs bug.
   - **Acts:**
     - transient: retry the phase once.
     - needs a human: note on the ticket and move it to Todo.
     - a jigs bug: rethrow.
   - **Fallback:** rethrow, as today.

## Phase 3: factory sites (jigs-factory-js)

These run on a branch of the factory that pins a GitHub Packages prerelease of
this jigs branch.

9. **`fix-ci-loop`:** a choice between caused by the change, flaky or
   infrastructure, and base branch broken. Flaky reruns the checks without
   spending a fix round. Base branch broken stops, with a note.
10. **`clarify-then-ship`:** yes/no, "does the ticket need clarification before
    planning?" A confident no skips the clarification halt.
11. **`s3-bucket-analysis`:** yes/no, "does this finding duplicate an open issue?"
    It skips duplicates. A severity score sets the issue's priority.

Each factory site gets its own eval file, and the factory CI gets the same
report-only eval job.

## Phase 4: findings

Record in this doc, for each site:

- eval accuracy;
- how often Jev was confident;
- agent turns avoided in real runs, counted from `decisions.jsonl`;
- anything that went wrong.

Then decide which sites to keep, move to shadow mode, or drop.

## Open questions

- **Site 7:** whether it is worth doing at all. Routing easy tickets to a
  cheaper model only pays off if a cheaper model is acceptable for them.

## Resolved

- **Factory dependency in CI:** the factory pins prereleases of this branch
  published to GitHub Packages, versioned `<next>-jev.N`.
