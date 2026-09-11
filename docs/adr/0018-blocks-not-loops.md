# jigs ships blocks; the factory owns the process

A **block** is pipeline-side reusable code that calls steps in a fixed way: one
async function, no options, taking the step wrappers it needs as plain
parameters. jigs ships blocks and nothing above them. The **process**, meaning
the order the blocks run in, what happens between them, and what the run says
when it gives up, belongs to the factory, which writes it as blocks of its own.
`jigs init` scaffolds that layer beside `pipelines/ship.ts` and the team edits
it from the first commit. jigs exports no `reviewLoop`. Decided by Salim on
2026-09-06.

> **Rewritten on 2026-09-11.** The decision is unchanged. The original text
> named the blocks by the names they had in 0.4.x and located the factory's
> review loop in `pipelines/review-loop.ts`; 0.5.0 renamed several blocks and
> moved the factory's loop to `blocks/review-loop/`, one decision per file.
> The measurements that justified the split are in git history.

## The rule the line is drawn on

**jigs owns what a wrong edit would break. The factory owns what a wrong edit
would merely change.**

Mechanics, session handling, the resume fallback, the gate's cursor and self
comment guard, and the hidden brief are all in the first category: edit one
wrong and the run is incorrect, silently. The order of the steps, the merge
policy, the escalation prose and every prompt are in the second: edit one
wrong and the run is different, visibly, in the way the team asked for.

That rule also answers the readable-API test. A newcomer reads `ship.ts`, then
reads the handful of small files under `blocks/review-loop/` beside it,
instead of stopping at one opaque call with eleven injected functions.

## There are no options on a block

If a block does not fit a factory's process, the factory copies it and edits
the copy. The API grows by adding blocks, never by adding knobs. This is the
whole point rather than a detail of it. Many teams will run factories with
processes nobody can enumerate in advance, and a knob is a permanent public
commitment made on a guess about one of them. The evidence was already in the
tree when this was decided: an audit pass deleted `maxReviewCycles`,
`maxCiAttempts`, `maxCycles` and two prompt overrides because no factory used
any of them.

Hand-porting fixes across many factories does not scale either, which is why
the blocks stay in the library. Small API, open for extension in the factory,
closed for modification in jigs.

## Prompts stay in jigs, and stay replaceable

Every prompt jigs ships sits beside the block that uses it, as a
`<name>.prompt.ts` file, and is exported from `@salimhamed/jigs/blocks` as a
plain interpolable string. A factory reads one, interpolates it, or passes its
own instead. The scaffold copies out only the prose a factory is actually
expected to edit, so a factory that likes the defaults carries no prose at all.

## Constraints that survive the split

- **The code-review prompt still hides the brief from the reviewer.**
  `implementUntilCodeReviewApproves` stays in jigs, so the call site that
  interpolates only the ticket and the base sha stays in jigs too. A factory
  can break the property only by rewriting a library function, which is the
  one arrangement where the guard is structural rather than a sentence in a
  document.
- **Session continuity is unchanged.** The builder's session pointer is
  captured in `implementUntilCodeReviewApproves` and resumed by `fixCi`,
  `answerReview` and `commitWork`. Sessions are harness specific, so those
  three share a harness and the code reviewer does not. All four stay in jigs,
  so the invariant moves nowhere.
- **No step id moves.** Ids are factory local paths plus function names
  ([ADR 0013](./0013-factory-owned-steps.md)), and a factory's own blocks carry
  no `"use step"` directive, so they add none.

## Consequences

- **jigs exports no `reviewLoop`, and keeps no second copy.** Two homes for one
  process would drift, and the maintained one would be whichever the next bug
  happened to be reported against.
- **The scaffold is larger and the library is smaller.** A new factory starts
  with more code it is expected to read. That is the intended trade: what it
  starts with is what it is most likely to want to change.
- **A per-role harness is a line in factory code.** The factory's own blocks
  name a harness per call site, exactly as `describePr` already picks Claude
  Opus while the loop runs Codex.

## Considered options

- **Keep `reviewLoop` in jigs and add knobs.** `ReviewLoopOptions` grows a
  review harness, a prompt override bag, and whatever the next difference
  needs. Cheapest by far, and correct if the honest forecast is two factories,
  both Salim's, for the next six months: the measured divergence between the
  two that existed was about 45 lines of prose, one policy choice in
  `describePr`, and two zod input defaults. Rejected on the forecast. It
  re-adds five knobs deleted the day before for being unused, every knob is
  permanent, and each new team's process difference becomes a jigs release. It
  is also the option where the hidden-brief guard is weakest: an override bag
  lets a factory lose it silently, with documentation as the only guard.
- **jigs ships steps only; the factory owns every block.** The scaffold
  roughly doubles. Rejected on the upgrade path, which is the one trade no
  measurement settles. In the week before the decision the loop gained empty
  push recovery, no-commit escalation and 405-merge handling, and under this
  option every one of those is hand-ported into every factory, forever.
  Keeping `implementUntilCodeReviewApproves` in the library is also what keeps
  the hidden brief a structural property.
- **Keep a library `reviewLoop` beside the scaffolded one**, so a factory could
  start from a call and graduate to a copy. Rejected: it is two homes for the
  same process, and only one of them would stay maintained.

## Known costs, accepted with eyes open

- **Fixes to the process stop arriving by upgrade.** A bug in the order of the
  loop, rather than in a block, is now a diff a human ports into each factory.
  The blocks underneath are where the fixes actually landed, so the exposure is
  smaller than under the steps-only option, but it is not zero and it grows
  with the number of factories.
- **The scaffold is a fork the moment it is written.** A factory that never
  touches its `blocks/review-loop/` still does not track the template, so an
  improvement to the scaffolded process reaches only new factories. There is no
  drift check, and no command that reports what changed in the template.
