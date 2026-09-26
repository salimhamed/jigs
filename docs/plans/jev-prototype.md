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
     - merge: with `mergedBy === "jigs"`, read the pull request again and merge
       only if its facts are unchanged and `isPullRequestMergeReady` passes.
       Otherwise fall through to builder. With `mergedBy === "human"`, treat it
       as idle.
     - builder: run the builder as today.
   - **Fallback:** builder.
   - **Status:** done. The question is in `delivery/decisions.ts`.
2. **Comment triage**
   - **Where:** `triageComments` in the recipe's `delivery/delivery.ts`, not a
     library routine: the library only ships a routine once two workflows use
     it.
   - **Decides:** one `askJev` call with one choice per new comment, keyed by
     comment ID: question, change request, FYI, praise, automated, or an author
     reply. At most the 20 newest comments are triaged.
   - **Acts:**
     - The labels feed site 1's state and the maintenance prompt.
     - If every new comment is FYI, praise, automated or an author reply, no
       review arrived, and the head, CI, merge state, approval, draft flag and
       labels are unchanged, the wake is idle without asking site 1.
   - **Fallback:** comments go unlabeled.
   - **Status:** done.
3. **Ticket reply**
   - **Where:** `haltForHuman` in `src/workflow/linear/halt-for-human.ts`, after a
     candidate reply is found. `checkForTicketHumanReply` is a step, so the
     question is asked from the workflow side.
   - **Decides:** yes/no, "does this comment answer what we asked?"
   - **Acts:** no excludes that comment by ID and reads again on the same wake.
     The cursor stays put, because a real answer may be in the same read.
   - **Fallback:** accept the comment, as today.
   - **Status:** done. The questions live in `src/workflow/linear/decisions.ts`,
     and `bindLinearSteps` takes `executeJev`.
4. **Ticket readiness**
   - **Where:** `reviewTicket` in `src/workflow/linear/review.ts`, once, before
     the first reviewer turn. The reviewer judges the human's reply, so Jev and
     the human cannot loop.
   - **Decides:** a choice of reason: ready, no acceptance criteria, missing
     reproduction, conflicting requirements, or too large for one PR.
   - **Acts:** any reason other than ready halts for a human, with fixed text
     for that reason, because Jev cannot write the question itself.
   - **Fallback:** the reviewer agent runs as today.
   - **Status:** done.
5. **Review convergence**
   - **Where:** `implementAndReview`, from round 2 onward.
   - **State:** the ledger of rounds: how many findings each round had, and
     which ones repeat.
   - **Decides:** a score of converging, slow, or stalled.
   - **Acts:** stalled stops early with the open findings. It is not asked
     after the last round, which the budget already ends.
   - **Fallback:** keep going until the round budget is spent.
   - **Status:** done.
6. **Webhook relevance**
   - **Where:** GitHub and Linear ingress in `src/service/app.ts`, before
     `resumeAndLog`.
   - **Decides:** yes/no, "should this event wake the paused run described in
     `waiting`?"
   - **State:** the trimmed event, including `fromJigs` when a comment carries
     jigs' marker, beside what the run is waiting for:
     - pull request activity, with the head and draft flag from the payload
       and the last wake;
     - a reply to the run's open question, whose text is read from Linear;
     - nothing on this ticket, when the run holding it has no question open.
     
     The ingress reads this from the World's hooks, plus one Linear read for
     an open question. A token no run holds wakes without asking.
   - **Acts:** no logs `reason=not-relevant` and does not wake the run.
   - **Evals:** before the waiting context, 8/8 right and 1/8 over the cutoff.
     With it and a crisper question, 10/10 right and 7/10 over the cutoff,
     including every "no" case. Only a confident "no" changes behaviour, so an
     unsure "yes" costs nothing.
   - **Never asked:** pull request closed, reopened, synchronize and
     ready_for_review; completed check suites; `status` events; Linear removals.
   - **Fallback:** wake the run. A missing `OPENROUTER_API_KEY` or a failed
     call also wakes.
   - **Status:** done, in `src/service/wake-relevance.ts`. Decisions are logged
     under the run directory named `ingress`.
   - **Why it is the least valuable site:** wakes are already cheap, because
     `watchPullRequest` drops snapshots that did not change. It is also the
     first Jev call outside a workflow, so it calls the driver directly. A
     wrongly skipped wake is covered by polling nudges.
7. **Ticket size: model routing and budgets**
   - **Where:** `recipes/linear-ticket-to-pr/linear-ticket-to-pr.ts`, after
     `reviewTicket`.
   - **Decides:** a score of the ticket and brief on the scale trivial, small,
     medium, large.
   - **Acts:**
     - Trivial and small tickets use `builderLight` and `reviewerLight`, new
       entries in the recipe's `agents` map. By default those are Claude Sonnet.
     - The size sets `budget.reviewRounds` (1, 2, 3, 3) and
       `budget.attemptsPerUpdate` (1, 2, 3, 3). An agent or budget passed as a
       run input still wins, so the `builder`, `reviewer` and budget inputs no
       longer have defaults.
     - The recipe declares `jevModel` in `requires.models`, so a missing
       `OPENROUTER_API_KEY` fails the service's startup checks instead of the
       first run.
   - **Fallback:** the default agents and budgets.
   - **Status:** done. The question is in the recipe's root `decisions.ts`.
8. **Failure triage**
   - **Where:** the recipe's error handling, for an agent or step error that is
     not `DeliveryStopped`.
   - **What reaches it:** the Workflow SDK (`workflow` 5.0.0-beta.53) retries a
     failed step 3 more times by default (`DEFAULT_STEP_MAX_RETRIES`), unless
     the error is a `FatalError` or the step sets `maxRetries`. A `JigsError`
     is an ordinary `Error`, so a step that throws one is retried too. Once
     the retries are spent, the workflow sees a `FatalError` whose message
     begins `Step "<id>" failed after 3 retries:`. Errors thrown in workflow
     code, such as routine invariants, reach it directly with no retry. So a
     brief blip never gets here: what arrives is an outage or rate limit that
     outlasted the quick retries, something a person must fix, or a bug.
   - **Decides:** outage, needs a human, or a jigs bug. The question tells Jev
     about the step retries.
   - **Acts:**
     - outage: wait five minutes (a durable `sleep`), then retry the phase once.
     - needs a human: throw `DeliveryStopped` with the error, so the ticket
       gets a note and moves to Todo.
     - a jigs bug: rethrow.
   - **Fallback:** rethrow, as today.
   - **Status:** done, as `withFailureTriage` around each phase call.
   - **Why every phase is safe to retry:**
     - `openPullRequest` adopts the branch's open pull request, and pushing
       the same commit again does nothing.
     - A failed `followPullRequest` leaves the `for await` loop, which closes
       the watch generator and disposes its pull request hook. The retried
       watch creates the hook again in the same run, and the World deletes a
       disposed hook, so there is no conflict. `watch.test.ts` covers this.
     - Ticket notes are idempotent too; see "Idempotent ticket notes" below.
   - **Evals:** 8/8 right, 7/8 over the cutoff, with outage cases written the
     way a spent step retry reads.

### Idempotent ticket notes

- **Why:** `postTicketNote` and `postTicketHumanInputRequest` are steps the
  SDK retries. If Linear created the comment but the response was lost, the
  retry would post it a second time.
- **How:** each comment is created with a client-chosen id
  (`CommentCreateInput.id`). The id is a UUID v4 derived from the run id, the
  issue and the note's input, not its rendered text, since the rendering
  includes participants that can change between attempts. Before creating,
  the step looks for a comment with that id and returns it if it exists.

### More candidates

These were found while building the Phase 2 sites and are not built yet.

- **Agent start failures** (`runAgentOrHalt`): today only failed tool checks
  halt. Jev could sort any other agent error into transient (retry), needs a
  human (halt with the error), or bug (throw). This overlaps site 8 and may be
  the better home for it, since every workflow calls this routine.
- **Abandoned halts** (`haltForHuman`): a choice on the accepted reply between
  "answered" and "stop this work". A confident "stop" would end the run instead
  of feeding "never mind, closing this" to the next agent.
- **Risky assumptions** (`reviewTicket`): a yes/no on whether the reviewer's
  assumptions are risky enough to ask about first, rather than posting them as
  a note and going ahead.
- **Stalled runs** (`src/service/stalls.ts`): a choice on a run's recent steps
  and errors between healthy, slow and stuck, shown by `jigs status`.
- **Poll cadence** (`src/service/nudge.ts`): a score of how soon a parked run is
  likely to have something to do, to poll more often while CI is running and
  less often while waiting on a person.
- **Workflow routing** (`src/service/trigger.ts`): a choice of which workflow a
  new ticket should start, for factories with several.
- **Finding severity** (`implementAndReview`): a yes/no per review finding,
  "is this blocking under the rubric?". A confident no would downgrade a
  preference the reviewer marked blocking, so rounds are not spent on naming.
  It overrides the reviewer, so it needs eval evidence first.
- **Second opinion on needs-human** (`followPullRequest`): before stopping on a
  builder's `needs-human`, a yes/no on whether the builder could resolve it
  itself, such as a merge conflict it called a blocker, with one more turn.
- **Red CI cause** (`followPullRequest`): the `fix-ci-loop` question of caused by
  the change, flaky or base branch broken. Flaky would re-run checks without a
  builder turn, which needs a new re-run-checks step.
- **Light reviewer on late rounds** (`implementAndReview`): from round 2, when
  only small findings remain, review with `reviewerLight`.

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

## Resolved

- **Site 7:** do both model routing and budgets. Use Jev as aggressively as
  possible.

- **Factory dependency in CI:** the factory pins prereleases of this branch
  published to GitHub Packages, versioned `<next>-jev.N`.
