---
status: accepted
---

# Ticket status is workflow policy

Jigs moves a ticket with a small durable step instead of relying on Linear's
GitHub automation. A workflow knows when it has claimed work, opened a pull
request, merged it, or stopped; Linear's automation sees only repository
events and cannot represent the full sequence.

The step takes an issue id and a state name. Its Linear implementation reads
the issue team's states, matches the name case-insensitively, and changes the
state only when needed. It does not decide which state means started, review,
done, or stopped.

That policy stays in workflow code. The ship recipe chooses `In Progress`,
`In Review`, `Done`, and `Todo` at its own durable lifecycle points. Factory
workflows with different tracker vocabulary make their own choices through
the same step. No service state machine or factory configuration records a
second interpretation of the run lifecycle.

`reviewTicket` and the ship recipe's delivery operation expose optional
workflow callbacks where their internal sequence has useful moments. They do
not turn those blocks into lifecycle owners: callbacks run as ordinary durable
workflow code and retain the factory's surrounding policy and data.
