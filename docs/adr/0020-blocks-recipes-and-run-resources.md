---
status: proposed
---

# Blocks, recipes and run resources: the workflow API after the six prototypes

Six bespoke workflows were written in the JS factory on 2026-09-17, one per
ticket, none using `deliverChange`, and each ran against a real repository
([AGE-448](https://linear.app/salboogie/issue/AGE-448) holds the outcomes,
the six AI tickets hold the per-workflow write-ups, and an independent Codex
review reached the same conclusions from the code). The evidence says the
steps and blocks were good enough to write six process shapes in a day, and
that almost every complaint is about what sits between them and a workflow.
So jigs keeps its execution model, ordinary TypeScript workflows calling
durable steps through blocks, and changes three things: the library stops
shipping a delivery process and ships recipes instead, blocks get the edges
the prototypes had to hand-roll, and the runtime records what a run creates
so it can show and release it. Decided with Salim on 2026-09-17.

## What the prototypes showed

- About 110 lines were identical in all six: the ticket prelude (resolve,
  claim, snapshot, worktree), the two guards after an agent pass (dirty tree,
  no commit), the push-open-note tail, a URL builder and a copy of
  `JigsError`, which `skills/jigs/author.md` tells authors to throw and no
  subpath exports.
- Four workflows each wrote a factory step around `git` because there is no
  step that reports what changed (`readWorktreeDiff` is a raw patch truncated
  at 200k characters, no file list, no subjects) and no step that runs a
  command in a worktree.
- Every run that opened a pull request shows `-` in `jigs ps` once it ends,
  because the listing recognises only a return value shaped
  `{ pr: { owner, repo, number } }`, a contract written nowhere.
- Every run left its worktree on disk. The teardown step exists, but the
  workflow has to call it, and only a merged delivery ever did.
- `reviewPullRequest` accepts `approve` and `request-changes`, GitHub refuses
  both from the account that opened the pull request, this factory acts as
  that account, and the wrapper has `maxRetries = 0`, so the first attempt
  ends the run. The prototypes posted comments whose first line carries the
  verdict.
- The halt for a human returns a raw comment body. Two workflows wrote two
  parsers; one had to learn that "don't approve" is not approval. The
  renderer's stock instruction, "reply with `1a, 2b`", was right for the
  three-question halt and wrong for the yes-or-no one. An unanswered halt
  parks forever.
- A `ci-red` wake carries a check's name, its conclusion and a link. Nothing
  reads why it failed.
- The delivery surface is almost unused: `deliverChange` has one caller (the
  scaffolded `ship`), three of its four phases have none, and 41 of the 47
  names exported from `./delivery` are imported by nothing in a factory.

## The decision

### Three layers, and the library owns the bottom two

1. **Steps and their wrappers.** Unchanged in shape. The generated `jigs.ts`
   stays a byte-exact copy of the shipped integration
   ([ADR 0013](./0013-factory-owned-steps.md)); it is the anchor for durable
   addresses and not an extension point. The extension point is the one the
   prototypes used: a `"use step"` function in a file beside the workflow
   that owns it, which the build already discovers. The author skill and the
   scaffold name that convention instead of leaving it to be found.
2. **Blocks.** Reusable workflow-side code, shipped by jigs under one subpath
   per topic (`agents`, `linear`, `pull-requests`, `workspaces`, `git`,
   `human`) and written by factories beside their workflows. A block calls
   wrappers and other blocks and carries no process policy: no round budgets,
   no "merged means done", no ticket-note wording. The blocks list below is
   what the prototypes showed was missing.
3. **Recipes.** Complete workflows jigs ships as source in `recipes/` in this
   repository, tested by `pnpm e2e`, and a factory copies one in when it
   wants it. Once copied, a recipe is factory code and is edited freely.
   `jigs init` scaffolds a bare factory: configuration, the generated
   integration, one trivial workflow that proves the build, and nothing that
   presumes how the factory works. `ship` becomes the first recipe.

### Delivery leaves the library

`deliverChange`, `implementAndReview`, `publishApprovedChange`,
`followPullRequest`, their option types, default prompts and renderers move
out of the package and into the `ship` recipe. Each prototype was a different
composition of the same blocks, and a delivery process bundled with round
limits, stand-down notes and a fixed reading of "done" is exactly the thing a
factory needs to vary.

The mechanics that composition carries are kept, as blocks, because more than
one workflow already wants them: marking a comment with the run's scope so
the gate does not count the run's own words as feedback; standing a change
down (push the branch, post the note, throw); continuing or rebuilding an
agent session with the reason recorded; publishing exactly the commit a
reviewer approved. They are extracted before the move, one at a time, and
only when the recipe and at least one prototype both use them. Anything with
a single caller stays inside the recipe. Over-abstracting early is the failure
this ADR is most likely to cause, and the two-caller rule is the guard.

### Blocks get the edges the prototypes hand-rolled

- `JigsError` is exported from the root, with the types a workflow needs to
  consume public operations (`CheckRun`, the pull-request snapshot, review
  requests, operation results).
- `openPullRequest` returns the pull request with its URL.
- A `readChange(worktree, base)` step returns structured change evidence:
  base and head commits, each file with its status and line counts, every
  commit subject, and whether anything was truncated. Patch text is a
  separate, caller-selected request.
- A branch-sync step reports the worktree's relation to its remote branch,
  ahead, behind or diverged, and makes discarding local state an explicit
  argument. The prototype's `reset --hard` is a policy and does not become a
  default.
- A bounded command step, `runInWorktree(cmd, args)`, with an output cap, a
  timeout and no retry, as an explicit escape hatch beside the semantic
  steps. ADR 0013 rejected a generic dispatch step as the way to reach
  library operations; this is not that, and library operations stay named.
- The ticket prelude becomes one block that returns the claim, the snapshot
  and the worktree facts, with provisioning separable because
  `clarify-then-ship` provisions only after a human answers.
- The halt for a human takes questions with options and returns the chosen
  option per question, or "unreadable" so the caller can re-ask, with a
  yes-or-no variant and an optional deadline that wakes the run with "timed
  out". Each answer is tied to the question it answers. The renderer writes
  its instruction from the halt's actual shape.
- Review posting knows the acting identity and the pull request's author and
  refuses an approval it cannot post before the call, rather than failing on
  the provider's error. It does not downgrade an approval to a comment on its
  own; the caller decides.
- Pull-request observation is separable from the merge gate: a workflow can
  subscribe to the wakes (`ci-red`, `review-comments`, `merge-ready`,
  `closed`) without adopting the gate's approval semantics or its exclusive
  writer claim, so a workflow interested only in closure or in CI does not
  inherit delivery's meaning of "ready".
- A `ci-red` wake keeps its provider-neutral facts (check identity, conclusion,
  link) and carries evidence when the factory supplies it. Evidence comes
  from a hook the factory registers per binding, keyed by check name, which
  may use any credentials the factory has; or from the agent itself, given an
  MCP server for the CI provider. jigs ships no per-provider CI code.

### The runtime records run resources and applies release policy

The worktree registry (`jigs_worktrees`) becomes the general record of a
run's resources: worktree, scratch directory, pull request, branch, ticket
comment, with kind, identity, URL and the run that made it. Steps register
what they create; a factory step calls the same function. `jigs ps` and
`jigs logs` read that record, so a finished run shows its pull request
without a magic return shape, and the record survives failure and
cancellation.

Release is a run-level policy jigs applies when a run reaches a terminal
state, not a call a workflow makes and not a `finally`
([ADR 0007](./0007-worktree-lifecycle.md) already forbids the latter because
suspension throws). The decide-and-apply matrix in ADR 0007 stands; what
changes is who applies it. Two rules join it: a run that watches a pull
request releases when that pull request closes, and no release deletes a
branch ref holding commits the remote does not have. A factory sets the
policy per workflow (release on completion, keep on failure), and a workflow
may release one resource early by name.

Conflict resolution on a parked pull request is opt-in and off by default
([AGE-463](https://linear.app/salboogie/issue/AGE-463)). When a factory
enables it, an agent resolves the conflict by rebase or by merging the base
in, the factory's choice, and jigs owns the push with lease and treats the
new head as unapproved.

## Considered options

- **A workflow DSL or configuration-driven pipeline.** Rejected. The six
  prototypes were readable as plain TypeScript, and the variation between
  them is control flow, which a DSL would have to grow to express.
- **Scaffolding `ship` and other recipes with `jigs init`.** Rejected by
  Salim. A recipe presumes a way of working; a new factory should start bare
  and copy in what it wants. The Codex review preferred a starter recipe and
  was overruled on this point.
- **Fixing the missing pull request in `jigs ps` by documenting the return
  shape.** Rejected. It keeps a delivery-shaped contract on every workflow,
  including ones that open several issues and no pull request.
- **Per-provider CI adapters in jigs (CodeBuild, GitHub Actions, ...).**
  Rejected. The factory hook and the agent's MCP server cover the same ground
  without jigs learning each provider.
- **Rebasing a conflicting branch by default.** Rejected; it rewrites a
  branch on a company repository unasked. Opt-in as above.
- **Making the generated `jigs.ts` editable by factories.** Rejected; it is
  the durable-address anchor and drift is what the build check exists to
  catch. Steps beside workflows already extend it.

## Consequences

- Breaking: `./delivery` is removed from the exports map, `jigs init` writes
  a different scaffold, `e2e/expected-ids.txt` changes, and the personal and
  JS factories adopt `ship` as a recipe when they upgrade. One `!` release.
- `docs/bespoke-workflows-plan.md` said delivery stays an optional library
  recipe; this ADR revises that, and the plan's stage 6 is this document.
- The first slice is the part with the least design risk and the most
  duplicated code: export `JigsError`, return the pull request URL,
  `readChange`, the ticket-prelude block, and recording a run's pull request
  so `ps` shows it. The recipe move and the release policy follow, each with
  its own ticket. Typed halts, PR observation and CI evidence come after the
  first factory needs them again.
- Validation before calling the API general: a concurrent multi-repository
  investigation and an event-started workflow with no pull request, with a
  restart during a human wait, competing worktree acquisition and a lost
  response after an external write.
