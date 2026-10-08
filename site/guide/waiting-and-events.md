# Waiting and external events

Real processes spend much of their time waiting: for a person, CI, a pull
request review or a ticket update. A durable workflow can stop while it waits
and continue later without keeping the original CLI command or JavaScript
process alive. The Vercel Workflow SDK saves progress and reuses recorded
step results as explained in [Core concepts](/guide/concepts#how-durable-execution-works).
The factory service must be running to receive events and continue work.

## Wait for a person

`haltForHuman` asks a question in Linear and continues the same run when a
person replies. It requires the factory's [Linear app](/guide/configuration#linear-app)
and a claimed ticket. Claiming prevents two runs from owning the same ticket,
and it opens a Linear agent session on the ticket, or takes the one the run
was started from with `acquireTicket`'s `session` argument. A ticket run talks
to people only in that session: Linear shows it working, with an Open button
that links to the run's page and a Stop button that works for the whole run.

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
import { acquireTicket, haltForHuman, noteOnTicket } from "#jigs/routines";

const inputs = z.object({
  linearInstallation: installationNameSchema,
  ticket: ticketInputSchema,
});

export async function askScope(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const installationName = input.linearInstallation;
  const { claim } = await acquireTicket({ installationName, reference: input.ticket });
  const reply = await haltForHuman(claim, {
    headline: "A decision is needed before work continues.",
    where: "scope",
    questions: [{
      question: "Should the fix include archived drafts?",
      options: [{ label: "Active drafts only" }, { label: "Include archived drafts" }],
    }],
    onReply: "continue",
  });
  await noteOnTicket(claim, {
    headline: "Thanks, noted.",
    notes: [reply.body],
    closing: "",
    endsRun: "success",
  });
  return reply.body;
}

export default defineWorkflow({
  inputs,
  requires: { integrations: ["linear"] },
  workflow: askScope,
});
```

The question mentions your [`linear.operator`](/guide/configuration#linear-operator),
or the ticket's creator without one, and the assignee. Pass
`mention: ["dana@example.com"]` in the halt to mention more people. Anyone who
replies in the session answers it. Messages sent there before the question
count too, and the reply holds each message after its author's name.

`noteOnTicket` posts a note in the session and notifies the people it
mentions. A note with `endsRun` is the run's last message, as a success or a
failure; end every way out of a ticket run with one, or Linear keeps showing
the run as working.

- **A message sent while the run works** gets the reply "I'm working and
  can't take instructions mid-run; I'll ask here if I need you. Use Stop to end
  the run." The run reads it at its next question. If the run never asks
  again, it never reads the message.
- **Stop** cancels the run within about 30 seconds, as `jigs cancel` does,
  and posts "Stopped." The ticket's status stays as it is.
- **Ordinary comments** on the ticket answer nothing. jigs never posts or
  reads them, though an agent with Linear's MCP tools may still comment.

Starting a second run does not answer a question. The [routine reference](/api/factory/routines#haltforhuman) covers the options.

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
