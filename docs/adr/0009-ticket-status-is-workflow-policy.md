# Ticket status is workflow policy

Status: accepted

jigs moves a ticket with a small durable step, `setTicketStatus`, instead of
relying on Linear's GitHub automation. A workflow knows when it has claimed
work, opened a pull request, merged it or stopped; Linear's automation sees
only repository events and cannot represent that sequence.

The step takes an issue id and a state name. It reads the issue team's states,
matches the name case-insensitively and changes the state only when needed. It
does not decide which state means started, review, done or stopped.

## Consequences

- The policy stays in workflow code. The ship recipe picks `In Progress`,
  `In Review`, `Done` and `Todo` at its own durable points; a factory with a
  different vocabulary makes its own choices through the same step.
- No service state machine or factory configuration records a second reading
  of the run lifecycle. Adding one would be a regression.
- `reviewTicket` and the ship recipe's delivery expose optional callbacks at
  useful moments. They run as ordinary durable workflow code and do not make
  those routines lifecycle owners.
