# Ask a human and wait

When a workflow needs a decision, `haltForHuman` can post a question on a Linear
ticket and suspend the run until a human replies. The current integration uses
Linear; it is not a generic chat inbox. Pull-request approval is a separate
policy used by the [ship recipe](./ship).

The workflow needs a claimed Linear ticket, integration credentials, and working
webhook delivery. The ship recipe already includes ticket acquisition and
claiming. See the [setup runbook](https://github.com/salimhamed/jigs/blob/main/docs/setup.md)
for configuring Linear and the public webhook URL.

## Ask a concrete question

This fragment belongs inside a workflow that already holds a `TicketClaim` named
`claim`. It posts a question and returns the human’s reply:

```ts
import { haltForHuman } from "#jigs";

const reply = await haltForHuman(claim, {
  headline: "The workflow needs a decision before continuing.",
  where: "requirements review",
  questions: [
    {
      question: "Should the report include archived projects?",
      options: [{ label: "Active projects only" }, { label: "Include archived projects" }],
    },
  ],
  onReply: "continue",
});

// reply.body contains the human's answer. Your workflow decides how to use it.
```

The workflow owns the meaning of the answer. Suggested choices help the person
respond, but their reply is text; do not assume the response is a validated enum
or that any reply grants permission for every subsequent action.

## Answer a waiting run

Run `pnpm exec jigs status <run-id>` to see its question and the link where a
reply is needed. Reply to the ticket comment. The incoming notification wakes the
existing run, which checks for a human reply before continuing.

A waiting run is still active and retains its worktrees. Do not start a second
run just to answer the first, and do not release its directories while it waits.

For the question, claim, and reply types, see the [API reference](/api/).
