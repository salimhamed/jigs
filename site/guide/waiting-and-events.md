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

This complete workflow resolves its `ticket` input, claims the ticket, then
returns the person's answer. Save it as `workflows/ask-scope/ask-scope.ts` and
[register `ask-scope` in the factory](/guide/build-a-workflow#_3-register-the-workflow).
Rebuild with `pnpm exec jigs up`, then run
`pnpm exec jigs run ask-scope --input ticket=ENG-123`, replacing
`ENG-123` with your ticket identifier.

```ts
// workflows/ask-scope/ask-scope.ts
import { defineWorkflow, ticketInputSchema, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { claimTicket, haltForHuman } from "#jigs/routines";
import { resolveLinearIssue } from "#jigs/steps";

const inputs = z.object({ ticket: ticketInputSchema });

export async function askScope(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
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
  return reply.body;
}

export default defineWorkflow({
  inputs,
  requires: { integrations: ["linear"] },
  workflow: askScope,
});
```

The comment mentions the ticket's creator and assignee, or your
[`linear.operator`](/guide/configuration#linear-operator) and the assignee. Pass
`mention: ["dana@example.com"]` in the halt to mention more people.

Answer the existing question on Linear. Starting a second run does not answer
it. The [routine reference](/api/factory/routines#haltforhuman) covers the options.

## Watch a pull request

**`watchPullRequest` reports facts. It does not decide what the facts mean or
what the workflow should do next.** This complete workflow watches an existing
pull request identified by its owner, repository and number. It requires
[GitHub credentials](/guide/configuration#github-identity). Save it as
`workflows/watch-pr/watch-pr.ts` and register `watch-pr` in the factory. Rebuild
with `pnpm exec jigs up`, then run `pnpm exec jigs run watch-pr --input owner=acme --input repo=app --input number=42`
with your pull request's details.

```ts
// workflows/watch-pr/watch-pr.ts
import { defineWorkflow, type PullRequestRef, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { watchPullRequest } from "#jigs/routines";

const inputs = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.coerce.number().int().positive(),
});

export async function watchPr(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const pr: PullRequestRef = { owner: input.owner, repo: input.repo, number: input.number };
  for await (const snapshot of watchPullRequest(pr)) {
    if (snapshot.state === "closed") {
      return { merged: snapshot.merged };
    }
    // Add this workflow's reactions to open snapshots here.
  }
}

export default defineWorkflow({
  inputs,
  requires: { integrations: ["github"] },
  workflow: watchPr,
});
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

Add this helper at file scope in a workflow module. It takes the `pr` and
`snapshot` from the watcher above, the root ID of a thread the workflow has
chosen to answer, and the reply text. Call it inside the watch loop after your
workflow has decided what to say. It finds the thread in the current snapshot
and fails if that thread is absent.

```ts
import { JigsError, type PullRequestRef, type PullRequestSnapshot } from "@jigs-ai/jigs";
import { postReviewAnswers } from "#jigs/routines";

export async function answerReview(
  pr: PullRequestRef,
  snapshot: PullRequestSnapshot,
  threadId: number,
  body: string,
) {
  const selectedThread = snapshot.reviewThreads.find((thread) => thread.rootId === threadId);
  if (!selectedThread) throw new JigsError("The selected review thread is absent from this snapshot.");

  await postReviewAnswers({
    pr,
    scope: "delivery",
    threads: [selectedThread],
    answers: {
      answers: [{ threadId: selectedThread.rootId, body }],
      commitExplanation: null,
    },
  });
}
```

The routine sends the answer to the right GitHub thread and marks which
feedback it addresses. You can also include an explanation of a pushed commit.
The [reference](/api/factory/routines#postreviewanswers) lists those options.

### Post a commit update

Use `postPullRequestNote` for a status message about the current commit. Add
this helper at file scope in the watcher module, then call
`await reportFailingCi(pr, snapshot)` inside the loop after the closed-state
check. Both arguments come from that loop; the helper posts only when CI is red.

```ts
import type { PullRequestRef, PullRequestSnapshot } from "@jigs-ai/jigs";
import { postPullRequestNote } from "#jigs/routines";

export async function reportFailingCi(pr: PullRequestRef, snapshot: PullRequestSnapshot) {
  if (snapshot.ci !== "red") return;
  await postPullRequestNote({
    pr,
    scope: "delivery",
    headSha: snapshot.headSha,
    reason: "ci",
    body: "CI fails on this commit. The failing checks need investigation.",
  });
}
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
