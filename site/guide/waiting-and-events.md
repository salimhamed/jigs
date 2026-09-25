# Waiting and external events

Real processes spend much of their time waiting: for a person, CI, a pull
request review or a ticket update. A durable workflow can stop while it waits
and continue later without keeping the original CLI command or JavaScript
process alive. The Vercel Workflow SDK saves progress and reuses recorded
step results as explained in [Core concepts](/guide/concepts#how-durable-execution-works).
The factory service must be running to receive events and continue work.

## Wait for a person

`haltForHuman` currently uses Linear. It asks a question on a ticket, marks the
run as waiting, then continues the same run when a person replies there. It
requires [Linear credentials](/guide/configuration#linear-identity) and a claimed
ticket. Claiming prevents multiple runs from independently owning the same ticket.

Declare a `ticket` input and `requires: { integrations: ["linear"] }` in the
workflow definition. Add these imports at file scope and the calls inside the
workflow function:

```ts
import { claimTicket, haltForHuman } from "#jigs/routines";
import { resolveLinearIssue } from "#jigs/steps";

const issue = await resolveLinearIssue(input.ticket);
const claim = await claimTicket(issue.id, issue.identifier);
const reply = await haltForHuman(claim, {
  headline: "A decision is needed before work continues.",
  where: "scope",
  questions: [{
    question: "Should the fix include archived drafts?",
    options: [{ label: "Active drafts only" }, { label: "Include archived drafts" }],
  }],
  onReply: "continue",
});
// reply.body contains the person's answer.
```

Answer the existing question on Linear. Starting a second run does not answer
it. The [routine reference](/api/factory/routines#haltforhuman) covers the options.

## Watch a pull request

**`watchPullRequest` reports facts. It does not decide what the facts mean or
what the workflow should do next.** Pass a `PullRequestRef`, such as the result
of opening a pull request:

```ts
import { watchPullRequest } from "#jigs/routines";

for await (const snapshot of watchPullRequest(pr)) {
  if (snapshot.state === "closed") {
    return { merged: snapshot.merged };
  }

  // Decide what this workflow should do with the current facts.
}
```

The watcher reads GitHub on its first call and after each wake. It yields only
when the snapshot changes, so duplicate notifications do not repeat your work.
The workflow decides whether to change code, respond to feedback or merge.
See the [watcher reference](/api/factory/routines#watchpullrequest) and
[snapshot fields](/api/jigs#pullrequestsnapshot) for the exact data.

## Reply to reviews and post updates

After reading a snapshot, your workflow can use `postReviewAnswers` to reply to
review threads, or `postPullRequestNote` to explain the status of a commit. Both
come from `#jigs/routines`; the generated routines supply the durable steps.

### Reply to a review

Once the workflow has chosen feedback to answer, send the reply with the thread
from the snapshot. In this example, `selectedThread` is one of
`snapshot.reviewThreads`:

```ts
import { postReviewAnswers } from "#jigs/routines";

await postReviewAnswers({
  pr,
  scope: "delivery",
  threads: [selectedThread],
  answers: {
    answers: [{
      threadId: selectedThread.rootId,
      body: "Added a regression test for saving a draft twice.",
    }],
    commitExplanation: null,
  },
});
```

The routine sends the answer to the right GitHub thread and marks which
feedback it addresses. You can also include an explanation of a pushed commit.
The [reference](/api/factory/routines#postreviewanswers) lists those options.

### Post a commit update

Use `postPullRequestNote` for a status message about the current commit:

```ts
import { postPullRequestNote } from "#jigs/routines";

await postPullRequestNote({
  pr,
  scope: "delivery",
  headSha: snapshot.headSha,
  reason: "ci",
  body: "CI still fails on this commit. The failing test needs investigation.",
});
```

It checks the pull request before posting and skips a note already recorded for
that scope, commit and reason. This avoids repeating the same status message
on each update. See the [reference](/api/factory/routines#postpullrequestnote)
for the available reasons and failure behavior.

Keep `scope` stable to identify this workflow's work on the pull request. These
routines write comments; they do not decide whether to retry, fix code or merge.
`watchPullRequest` still reports all current facts, including your own comments.
Your workflow decides which feedback needs a reply and what to do next.

## Polling and webhooks

The built-in GitHub and Linear waits always have polling as a fallback.
Webhooks make them react sooner, but are not required for correctness. A poll
or webhook wakes the run so it can read the current facts again. Custom SDK
hooks need their own event delivery; jigs does not automatically poll them.
See [Configuration](/guide/configuration#webhooks) for webhook setup and intervals.

## Check now with `jigs poke`

```sh
pnpm exec jigs poke <run>
```

Ask a waiting run to re-check its external condition now. `poke` does not
provide an answer or approval; it only causes an immediate re-check.
