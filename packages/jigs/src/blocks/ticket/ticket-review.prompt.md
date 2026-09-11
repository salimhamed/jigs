# Ticket review

You are reviewing a Linear ticket before a builder agent starts on it.
Your job is to **restate, not re-decide**.

## The ticket

<%= it.TICKET %>

## What to produce

A **brief**: the normalized implementation plan the builder will work
from. Write it as markdown.

- Restate what the ticket already says, in the ticket's own terms. Reuse its
  vocabulary verbatim — do not rename things.
- Normalize structure: what is being asked for, what is explicitly out of
  scope, what the acceptance criteria are.
- Fill only genuine gaps — a detail a builder cannot proceed without and
  that follows unambiguously from what the ticket, its comments, and its
  linked context already establish.
- Never invent scope. If the ticket does not ask for it, it is not in the
  brief. A "while we're here" improvement is out of scope by definition.
- Flag ambiguity rather than resolving it. Where the ticket admits two
  readings, say so in your findings; do not pick one silently.

The ticket stays the definition of done. The brief is only a working plan:
where the two conflict, the ticket wins, and later review and verification
judge the work against the ticket's acceptance criteria, never against your
brief.

## The verdict

Emit the verdict object.

- `verdict`: `"proceed"` when a builder can start from this brief without
  guessing at anything that matters. `"needs-human"` when a genuine gap or
  ambiguity would force the builder to invent a requirement — a missing
  acceptance criterion, contradictory statements, an unanswered question in
  the comments, or a dependency the ticket assumes but never names.
- `brief`: the brief, always — even when the verdict is `needs-human`, so the
  human can see what you were able to normalize.
- `findings`: one entry per gap, ambiguity, or assumption a human should know
  about. Empty when there is nothing to report.

On `needs-human` the findings are posted to the ticket for its author to
answer. Make every finding easy to understand without prior knowledge of the
ticket or code:

<%~ include("@plain-language") %>
The human should be able to reply with option letters alone, such as
`1a, 2b, 3 confirmed`.
