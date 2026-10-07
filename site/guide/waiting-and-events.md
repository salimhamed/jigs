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
requires [Linear credentials](/guide/configuration#linear-app) and a claimed
ticket. Claiming prevents multiple runs from independently owning the same ticket.

This complete workflow resolves its `ticket` input in the Linear installation
its `linearInstallation` input names, such as `linear-acme`, claims the ticket, then
returns the person's answer. Save it as `workflows/ask-scope/ask-scope.ts` and
[register `ask-scope` in the factory](/guide/build-a-workflow#_3-register-the-workflow).
Rebuild with `pnpm exec jigs up`, then run
`pnpm exec jigs run ask-scope --input linearInstallation=linear-acme --input ticket=ENG-123`,
replacing `linear-acme` with your installation name and `ENG-123` with your
ticket identifier.

```ts
// workflows/ask-scope/ask-scope.ts
import {
  defineWorkflow,
  installationNameSchema,
  ticketInputSchema,
  type WorkflowInputs,
} from "@jigs-ai/jigs";
import { z } from "zod";
import { claimTicket, haltForHuman } from "#jigs/routines";
import { resolveLinearIssue } from "#jigs/steps";

const inputs = z.object({
  linearInstallation: installationNameSchema,
  ticket: ticketInputSchema,
});

export async function askScope(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const installationName = input.linearInstallation;
  const issue = await resolveLinearIssue({ installationName, reference: input.ticket });
  const claim = await claimTicket({
    installationName,
    issueId: issue.id,
    identifier: issue.identifier,
  });
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
it, and neither does a mention of the factory's app or a reply in a [Linear
conversation](/guide/linear-conversations) on the issue. The [routine reference](/api/factory/routines#haltforhuman) covers the options.

## Watch a pull request

**`watchPullRequest` reports facts. It does not decide what the facts mean or
what the workflow should do next.** This complete workflow watches an existing
pull request identified by the GitHub installation that reaches it, its owner,
repository and number. It requires
[GitHub credentials](/guide/configuration#github-app). Save it as
`workflows/watch-pr/watch-pr.ts` and register `watch-pr` in the factory. Rebuild
with `pnpm exec jigs up`, then run `pnpm exec jigs run watch-pr --input installationName=github-acme --input owner=acme --input repo=app --input number=42`
with your pull request's details.

```ts
// workflows/watch-pr/watch-pr.ts
import { defineWorkflow, type PullRequestRef, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { watchPullRequest } from "#jigs/routines";

const inputs = z.object({
  installationName: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.coerce.number().int().positive(),
});

export async function watchPr(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const pr: PullRequestRef = {
    installationName: input.installationName,
    owner: input.owner,
    repo: input.repo,
    number: input.number,
  };
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

## Post commit updates

After reading a snapshot, your workflow can use `postPullRequestNote` from
`#jigs/routines` to explain the status of a commit; the generated routines
supply the durable steps. Add this helper at file scope in the watcher module,
then call `await reportFailingCi(pr, snapshot)` inside the loop after the
closed-state check. Both arguments come from that loop; the helper posts only when CI is red.

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

## Hub events

GitHub, Linear and Slack waits wake on the events the factory's
[hub](/guide/configuration#hub) passes on; the hub keeps them while the service
is down. An event wakes only the runs waiting through the installation it
came from, and one from an installation with no name on the hub wakes none.
An event or a poke wakes the run so it can read the current facts again. Custom SDK hooks need their own event delivery.

## Check now with `jigs poke`

```sh
pnpm exec jigs poke <run>
```

Ask a waiting run to re-check its external condition now. `poke` does not
provide an answer or approval; it only causes an immediate re-check.
