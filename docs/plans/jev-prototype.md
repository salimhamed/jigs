# Jev prototype plan

A proof of concept that uses Jev, TypeSafe's decision model, where it clearly
earns its place: it saves an agent turn, or it replaces a hand-written rule for
reading people's text. The branch is installed on factories for testing before
anything merges to main.

## Background

Jev takes JSON or text and answers typed questions in 70–500 ms, at
$0.042 per million input tokens. There are three question kinds:

- **yes/no:** returns a probability.
- **choice:** returns an option, a probability for each option, and a confidence.
- **score:** returns a position on an ordered scale.

Jev cannot write text, run tools, or see anything beyond the state it is given.

## Decisions

- **Aim:** less code and fewer branches, not Jev everywhere. A site stays only
  when it saves agent work or deletes a rule.
- **No fallback paths:** every question names `whenUnsure`, the answer to act
  on below its cutoff. `decide` returns one value per question, so a call site
  is a single `switch` and the old code path is gone.
- **Credentials:** one `OPENROUTER_API_KEY`, used locally and in CI. Because
  `haltForHuman` asks Jev, preflight checks the key for every workflow that
  declares the `linear` integration.
- **Evals:** basic hand-written cases, run against the live model in CI and
  reported without failing the build.
- **Off limits:** the merge gate, head SHA matching, dedupe markers and
  replay-safe cursors stay exact. Jev may only add a refusal on top of them.
- **Ticket notes:** the fix that posts each ticket note and halt question at
  most once per run lands on main by itself, not in this prototype.

## Shared pieces

- **`decide`** (`src/workflow/agents/decide.ts`): named questions about one
  state, each `{ question, whenUnsure, cutoff? }`, asked in one model request.
  The cutoff defaults to `DECISION_CUTOFF`, 0.9.

  ```ts
  const { wake } = await decide({
    site: "pull-request-wake",
    state,
    questions: { wake: { question: pullRequestWake, whenUnsure: "builder" } },
  });
  ```

- **`jevModel`:** `models.openrouter("typesafe/jev-1.13")`.
- **Decision log:** the `executeJev` step appends each answered call to
  `decisions.jsonl` in the run directory. For `decide`, the line also records
  each answer's resolved value, confidence, and whether `whenUnsure` was used.
- **Evals** (`@jigs-ai/jigs/evals`): `runEvalSet` asks a set's cases with the
  site's exact rule and prints accuracy, how many answers were sure enough to
  act on, how many were sure but wrong, and mean confidence on right and wrong
  answers. It is free of any test runner; each repo wraps it in a
  `test.skipIf(!evalsConfigured())` call. jigs runs its sets with `pnpm eval`
  and a report-only `evals` CI job.

## Library sites

1. **Pull request wake**
   - **Where:** `followPullRequest` in
     `recipes/linear-ticket-to-pr/delivery/delivery.ts`, before `builder.run`.
   - **Decides:** idle, builder, human, or merge. Unsure means builder.
   - **Acts:**
     - idle: record the snapshot as assessed and keep watching.
     - human: `maintenanceStopped`.
     - merge: with `mergedBy: "jigs"`, re-read the pull request and merge only
       if the facts are unchanged and `isPullRequestMergeReady` passes;
       otherwise the builder runs. With `mergedBy: "human"`, treated as idle.
     - builder: run the builder as today.
2. **Comment triage**
   - **Where:** the same file, before the wake question.
   - **Decides:** one choice per new comment (at most the 20 newest), keyed by
     comment id: question, change request, FYI, praise, automated, or author
     reply. Unsure means question, which owes an answer.
   - **Acts:** the labels go into the wake question's state. When every new
     comment asks nothing, no review arrived, and the head, CI, merge state,
     approval, draft flag and labels are unchanged, the wake is idle without
     asking the wake question.
3. **Ticket reply**
   - **Where:** `haltForHuman` in `src/workflow/linear/halt-for-human.ts`, after
     a candidate reply is found.
   - **Decides:** yes/no, "does this comment answer what we asked?" Unsure
     means yes.
   - **Acts:** no excludes the comment by id and re-reads on the same wake;
     the cursor never moves past it, because a real answer may share that read.

## Factory sites (jigs-factory-js)

The factory pins a prerelease of this branch published as a GitHub prerelease
tarball.

- **`approve-then-pr`:** replace the go/stop keyword rules outright with a Jev
  choice of go, stop or unclear. Unsure means unclear, which re-asks as today.
- **`clarify-then-ship`:** replace the phrase, letter and positional parsing
  outright. Jev answers the three scope questions from the ticket text and the
  reply in one `decide` call, each with an undecided option that is also its
  `whenUnsure`; undecided leads to the existing ask or re-ask.
- **Model routing,** if wanted, belongs in a factory: which model a ticket
  deserves is a factory's policy, not the library's.
- **Dropped:** the CI failure cause in `fix-ci-loop`, and the s3 follow-up and
  severity checks.

## Shelved

Built, then removed to keep the prototype small. Each is in this branch's
history.

- **Webhook relevance** (service ingress): waking a run was already cheap, and
  watchers drop unchanged snapshots anyway.
- **Ticket readiness** (`reviewTicket`): replaced the reviewer's own judgement
  with a guess before it read the ticket.
- **Review convergence** (`implementAndReview`): rarely confident, and stopping
  early overrides the reviewer.
- **Ticket size, model routing and budgets** (recipe): cost is not a concern
  for these factories, and routing is factory policy.
- **Failure triage and the outage wait** (recipe): steps already retry three
  times on their own, so what reaches the recipe is mostly a person's to fix.

## More candidates

Not built. Each would need to earn its place under the aim above.

- **Agent start failures** (`runAgentOrHalt`): today only failed tool checks
  halt. Jev could sort any other agent error into transient (retry), needs a
  human (halt with the error), or bug (throw).
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

## Findings

Record for each kept site: eval accuracy, how often Jev was sure enough to act,
agent turns avoided in real runs (from `decisions.jsonl`), and anything that
went wrong. Then decide what merges to main.
