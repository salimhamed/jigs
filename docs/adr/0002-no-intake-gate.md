# No intake gate: approval is invocation, judgment is steps

jigs core performs no ticket validation. There is no label check, no required
sections, no blocker refusal — in v0 nothing autonomous selects tickets, so a
human invoking `jigs run … --input ticket=AGE-123` *is* the approval. The
`ready-for-agent` label survives as human triage convention and as the queue
filter for future automation; jigs never reads it.

The core contract is a data shape, not a policy:

- A run takes a ticket identifier as a typed input.
- On **each activation** (launch and every resume) jigs fetches the ticket and
  keeps that copy in run state, versioned — steps in one activation see one
  consistent snapshot via `{{KEY}}` interpolation, and the version history is
  the audit trail. A human's unblocking comment-reply is naturally present in
  the resume-time copy.
- Snapshot contents: title, description, labels, comments, blocker/blocking
  relations, attached links, sub-issue ids/titles. No file attachments; live
  or deep reads are opt-in via per-step Linear MCP.

Everything judgmental is composable steps. jigs ships a `ticketReview` jig —
one agent step whose default markdown prompt restates rather than re-decides
(normalize what's there, fill only genuine gaps, flag ambiguity) and emits a
structured **proceed / needs-human** verdict. On needs-human it posts findings
as a Linear comment @-mentioning the ticket creator and the run halts. The
normalized brief flows to the implement step in-process — the comment is for
the human and the record, never the data path. The implementer receives both
the brief and the snapshot, with the ticket authoritative on conflict.
Verification lessons (e.g. word-boundary search for "no longer appears"
criteria, never verifying from memory of one's own edits) accrete in the
default prompts, which are versioned markdown and always overridable.

jigs writes no Linear states in v0: worktree branches default to Linear's
`gitBranchName`, and the GitHub↔Linear integration drives ticket lifecycle
off the PR.

## Considered options

- **Deterministic intake gate** (label + required-sections + open-blocker
  checks in core, CLI-level like preflight): rejected — too prescriptive for a
  tool whose philosophy is composable, unopinionated constructs; readiness is
  a judgment call, and pipelines may legitimately work blocked tickets.
- **`ready-for-agent` as machine-read approval bit**: rejected for v0 —
  meaningful only when something autonomous picks work; until the post-v0
  managing agent exists, the invocation keystroke carries the same bit.
- **One immutable launch-time snapshot**: rejected — the common unblock path
  (human answers in ticket comments, run resumes) would depend on the MCP
  escape hatch instead of the default data path.
- **Brief-only handoff to the implementer**: rejected — it makes the whole run
  trust one agent's summarization; brief + ticket with an explicit precedence
  rule costs a few tokens and closes the gap.

## Consequences

- Nothing stops running a half-baked ticket; the `ticketReview` jig is the
  mitigation and it is optional. Acceptable for a single-user tool.
- Run-level trouble reaches Linear only via the needs-human comment;
  how the human is otherwise notified remains an open map question.
- Verify/review steps judge against the ticket's acceptance criteria, never
  the brief — a re-planning agent cannot move the goalposts.
- Requirements exported: function steps, verdict-branching transitions, and
  halt semantics to the construct model; snapshot persistence and storage
  medium to run state; `gitBranchName` defaulting to the worktree lifecycle.
