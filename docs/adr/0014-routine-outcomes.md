# Routines that can end short return an outcome object

Status: accepted

Some routines can end without the result the caller asked for, and without an
error: a build stops, a pull request closes unmerged, a Slack wait times out or
loses its thread. Each reported that its own way: `followPullRequestToOutcome`
and `waitForSlackReply` with string literals, `buildAndReview` with a
`{ stopped }` wrapper beside a bare result. A string literal cannot carry
anything else, and each shape needed its own test in the caller.

Every such routine now returns one object per ending, discriminated by an
`outcome` field, with that ending's facts beside it:

- `buildAndReview`: `approved` with the reviewed commit, notes and ledger, or
  `stopped` with the reason, open findings and round.
- `followPullRequestToOutcome`: `merged` or `closed`.
- `waitForSlackReply`: `replied` with the replies, `timed-out` or `gone`.

The rule covers any routine, not only delivery, so it lives here rather than
in [0013](./0013-delivery-routines.md). It applies to routines only. A step's
result is recorded by the SDK and replayed to parked runs, so reshaping one
breaks them; steps such as `mergePullRequest` and `fetchSlackMessage` keep
their own shapes. Routines whose only alternative ending is a thrown error or
a suspension, such as `haltForHuman` or `describePullRequest`, return their
plain value.

## Consequences

- A new fact for an ending, such as when a wait timed out, is a field on that
  variant; callers that switch on `outcome` keep compiling.
- Callers write `result.outcome === "closed"` instead of `result === "closed"`.
- The change is workflow-side only: no step, step order or durable ID moves,
  so parked runs replay across the upgrade.
