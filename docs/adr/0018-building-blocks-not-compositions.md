# jigs ships building blocks; the factory owns the composition

jigs ships small building blocks and nothing else: the step implementations
that talk to git, GitHub and Linear, `agent()` and `ask()`, `resumeOrRebuild`,
`implementAndReview`, `answerAsBuilder`, `fixCi`, `commitLeftoverWork`,
`pullRequestGate`, `needsHuman`, `claimTicket`, the ticket snapshot and review,
and the worktree lifecycle. Each is one function, each stays stable, and a fix
to any of them reaches every factory by `jigs upgrade`. The **composition** —
the order those blocks run in, what happens between them, and what the run says
when it gives up — belongs to the factory: `jigs init` scaffolds a ~120-line
review-loop composition, the sequence `loop.ts` runs today, as factory code
beside `pipelines/ship.ts`, and the team edits it freely from the first commit.
jigs stops exporting `reviewLoop`. Decided by Salim on 2026-09-06.

**There are no options on a building block.** If a block does not fit a
factory's process, the factory copies it and edits its copy; the API grows by
adding blocks, never by adding knobs. This is the whole point rather than a
detail of it. Many teams will run factories with processes we cannot enumerate
in advance, and a knob is a permanent public commitment made on a guess about
one of them. The evidence is already in the tree: the last audit pass (R9)
deleted `maxReviewCycles`, `maxCiAttempts`, `maxCycles` and two prompt
overrides because **no factory used any of them**, leaving `ReviewLoopOptions`
with exactly one optional field, `merge?: "jigs" | "human"`. Hand-porting fixes
across many factories does not scale either, which is why the blocks stay in
the library. Small API, open for extension in the factory, closed for
modification in jigs.

**Prompts stay in jigs, as exported interpolable strings.** They are library
content a factory reads and may replace; the scaffold copies out only the ones
a factory actually edits, so a factory that likes the defaults carries no prose
at all.

## The rule the line is drawn on

**jigs owns what a wrong edit would break. The factory owns what a wrong edit
would merely change.**

Mechanics, session handling, the resume fallback, the gate's cursor and
self-comment guard, and the hidden brief are all in the first category: edit
one wrong and the run is incorrect, silently. The order of the steps, the merge
policy, the escalation prose and every prompt are in the second: edit one wrong
and the run is different, visibly, in the way the team asked for.

That rule also answers the readable-API test. A newcomer narrates `ship.ts`,
then narrates the 120-line `review-loop.ts` beside it, instead of stopping at
an opaque call with eleven injected functions.

## What was measured

`reviewLoop` today is five files under `src/review-loop/`: 777 lines, 629
excluding comments and blanks. `loop.ts` — the composition, 299 code lines —
is the only file that moves. `implement.ts`, `builder.ts` and `fix-ci.ts` (239
code lines) stay, and `pull-request.ts` stays because it is step
implementations, not composition.

The measured divergence between the two real factories is **about 45 lines of
prose, one assert-versus-repair policy in `describePr`, and two zod input
defaults**. `pipelines/ship.ts` is identical line for line apart from those
defaults; the fifteen shipped wrappers in `steps/jigs.ts` are byte-identical.
That number is the case for taking the composition out of the library rather
than the case against: two factories duplicate ~230 lines of `describePr`
mechanics each to vary 45 lines of prose, which is refactor audit item R10
restated as a measurement.

The primitives are already adequate for a pipeline that is not a review loop.
The JS factory runs `s3-bucket-analysis.ts` — 119 lines over `agent`, `ask`,
`needsHuman` and three Linear wrappers — and it never touches `reviewLoop`.

## Constraints that survive the move

- **The code-review prompt still hides the brief from the reviewer.**
  `implementAndReview` stays in jigs, so the call site that interpolates only
  `TICKET` and `BASE_SHA` stays in jigs too. A factory can break the property
  only by rewriting a library function, which is the one arrangement where the
  guard is structural rather than a sentence in a document.
- **Session continuity is unchanged.** The builder's session pointer is
  captured in `implementAndReview` and resumed by `fixCi`, `answerAsBuilder`
  and `commitLeftoverWork`; sessions are harness-specific, so those three share
  a harness and the code reviewer does not. All four functions stay in jigs, so
  the invariant moves nowhere.
- **No step id moves.** Ids are factory-local paths plus function names
  ([ADR 0013](./0013-factory-owned-steps.md)), the fifteen wrappers do not
  move, and the scaffolded composition carries no `"use step"` directive, so it
  adds none. `pnpm e2e` proves it the same way it always has:
  `e2e/expected-ids.txt` stays 17 lines.

## Consequences

- **`reviewLoop` leaves the public API, and no second copy stays behind.** Two
  homes for one 300-line composition would drift, and the evidence pointed the
  other way already: a byte-identical file across two factories is the signal
  to promote it *into the scaffold*, as `steps/jigs.ts` was promoted in ADR
  0013's amendment — not the signal to keep two of them.
- **Amends [ADR 0017](./0017-single-package.md)'s public surface.** Its subpath
  list includes `./review-loop/loop`; that subpath goes when the composition
  moves to the scaffold. `./review-loop/pull-request` stays — it is step
  implementations.
- **AGE-341 closes as superseded.** A per-role harness is a line in factory
  code once the composition is factory code: the composition names a harness
  per call site, exactly as `describePr` already picks Claude Opus while the
  loop runs Codex.
- **AGE-356 re-scopes** to exporting the prompt strings and scaffolding the
  editable ones. The override bag it asked for is not built.
- **Three audit items fold into the move rather than shipping on their own.**
  R10 (`describePr` mechanics in jigs, prose in the factory) becomes doable
  without the duplication that made it a trade; R13 (`ticketReview`'s
  needs-human loop) is composition, so it lands wherever the factory puts it;
  C16 mostly deletes itself, because `ReviewLoopDeps` drops from eleven entries
  to roughly three once the factory's own composition imports its own wrappers
  directly.
- **The scaffold gets larger and the library gets smaller.** A new factory
  starts with more code it is expected to read. That is the intended trade: the
  120 lines it starts with are the 120 it is most likely to want to change.
- **Sequenced after Salim's end-to-end test of `0.3.0`.** Nothing here moves
  until that run is done; this ADR records the boundary, not a release.

## Considered options

- **A — keep `reviewLoop` in jigs and add knobs.** `ReviewLoopOptions` grows a
  `reviewHarness`, a `prompts` override bag, and whatever the next difference
  needs. Cheapest by far (2–3 PRs) and correct if the honest forecast is "two
  factories, both mine, for the next six months" — the measured divergence
  between the two that exist is 45 lines of prose. Rejected on the forecast:
  it re-adds five knobs deleted the day before for being unused, every knob is
  permanent, and each new team's process difference becomes a jigs release. It
  is also the option where the hidden-brief guard is weakest — an override bag
  lets a factory lose it silently, with documentation as the only guard.
- **B — jigs ships primitives only; the scaffold owns the whole loop.**
  `loop.ts`, `implement.ts`, `builder.ts`, `fix-ci.ts` (~538 code lines) and
  all eight prompts become templates; the scaffold roughly doubles to ~1000
  lines per factory. Rejected on the upgrade path, which is the one trade no
  measurement settles: the loop gained empty-push recovery, no-commit
  escalation and 405-merge handling in a single week, and under B every one of
  those is hand-ported into every factory, forever. Keeping
  `implementAndReview` in the library is also what keeps the hidden brief a
  structural property; under B both locks on it become factory prose.
- **Keeping a library `reviewLoop` beside the scaffolded one** — the shape the
  decision brief recommended, so a factory could start from a call and graduate
  to a copy. Rejected as the one deviation from that recommendation: it is two
  homes for the same composition, and the maintained one would be whichever the
  next bug happened to be reported against.

## Known costs, accepted with eyes open

- **Composition fixes stop arriving by upgrade.** A bug in the *order* of the
  loop — not in a block, in how the blocks are strung together — is now a diff
  a human ports into each factory. The blocks underneath are where the last
  week's four fixes actually lived, so the exposure is smaller than under B,
  but it is not zero and it grows with the number of factories.
- **The scaffold is a fork the moment it is written.** A factory that never
  touches its `review-loop.ts` still does not track the template, so an
  improvement to the scaffolded composition reaches only new factories. There
  is no drift check, and the first one to want a "what changed in the template"
  command will find it does not exist.
- **This is the largest of the three options to implement** — the split *and*
  the scaffold — and it lands after a release whose end-to-end test has not
  been run yet.
