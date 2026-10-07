# Linear conversations

A workflow can hold a conversation with Claude Code in Linear's agent panel.
Someone mentions the factory's [Linear app](/guide/hub-linear) on an issue, or
assigns the issue to it, and Claude answers there. People reply in the same
thread, and Claude answers each reply in the same Claude session and worktree,
until the conversation goes quiet or someone presses stop.

## What people see in Linear

- **Received — working on it.** within about a second. The hub posts it
  before any factory reads the mention.
- **A status line** a few seconds later, such as
  ``Working… (last: ran `pnpm test`)``, replaced as Claude works.
- **Each answer** as a response, as soon as Claude writes it. Linear also
  shows it in the issue's comments.
- **A failure** as an error.
- **Stopped.** after someone presses stop. Claude is interrupted, and replies it
  has not read yet are dropped.
- **An Open button** that links to the run's dashboard. Linear accepts the
  link, but the dashboard listens on `localhost`, so it opens only on the
  factory's machine.

A reply sent while Claude works joins the turn Claude is on, without
interrupting it. A reply sent after an answer starts the next turn, which
continues the same Claude session. If the service restarts mid-turn, the turn
continues where Claude got to instead of starting over.

When no one has replied for the idle time, the conversation ends and Linear
shows nothing new. A later reply in that thread gets "This conversation has
ended; mention @app again to start a new one."

## A conversation workflow

This workflow checks out a repository and lets Claude answer in the session
that started the run. Save it as `workflows/converse/converse.ts`:

```ts
// workflows/converse/converse.ts
import { defineWorkflow, harnesses, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";
import { linearAgentConversation } from "#jigs/routines";
import { provisionWorktree, release } from "#jigs/steps";

const inputs = z.object({
  session: z.string(),
  installationName: z.string(),
  issue: z.object({ id: z.string(), identifier: z.string(), title: z.string(), url: z.string() }),
  comment: z.string().nullable(),
  creator: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
});
const agents = { assistant: harnesses.claude({ model: "opus" }) };

export async function converse(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const worktree = await provisionWorktree({ binding: "app", branch: `linear/${input.session}` });
  const conversation = await linearAgentConversation(input, {
    harness: agents.assistant,
    cwd: worktree.path,
    instructions: `You are helping with ${input.issue.identifier}, "${input.issue.title}" (${input.issue.url}).`,
    idleFor: "2h",
  });
  await release();
  return conversation;
}

export default defineWorkflow({
  inputs,
  requires: { agents, bindings: ["app"], integrations: ["linear"] },
  workflow: converse,
});
```

Register it with a [`linear.agentSessions` trigger](/guide/configuration#linear-agent-sessions):

```ts
import { linear } from "@jigs-ai/jigs";

// In defineFactory's `triggers`.
const triggers = {
  "converse-on-mention": {
    workflow: "converse",
    source: linear.agentSessions({ installationName: "linear-acme", teams: ["ENG"] }),
  },
};
```

Provision the worktree first, then call `linearAgentConversation`, then release.
The routine works in the worktree you give it and never changes it; your
workflow owns the worktree, the issue and anything it delivers, such as a pull
request, and runs on once the conversation ends.

## Options

`linearAgentConversation(session, options)` takes the trigger's inputs and:

- `harness`: a Claude Code harness. Other harnesses are refused, because only
  Claude Code can take a reply in the middle of a turn.
- `cwd`: the directory Claude works in, for the whole conversation.
- `instructions`: optional text that leads the first message Claude reads. The
  first message is the comment that mentioned the app, or a line saying the
  issue was assigned, so put anything else Claude needs to know here.
- `idleFor`: how long a conversation waits for a reply before it ends, as a
  duration such as `"30m"` or milliseconds. Four hours by default.

Claude reads each message as `Name: text`, with the name of the person who
wrote it.

It returns `{ outcome, turns }`. `outcome` is `idle` when no one replied in
time, `stopped` when someone pressed stop, or `failed` with an `error` when a
turn failed; the error is also posted in Linear. A failure the routine cannot
recover from, such as a step that ran out of retries, is posted as an error and
then thrown.

## One run per session

Each mention or assignment starts one Linear agent session, and the trigger
starts one run for it. A run that converses holds the session for the whole
conversation, so a second run for the same session fails with a
`ClaimConflictError` when it calls `linearAgentConversation`.

Every factory assigned a Linear app hears every mention of it. For
conversations, give each factory its own Linear app, or two factories answer
the same mention in the same thread.

Replies in a session's thread, and the mention that opens one, never answer a
[paused ticket run](/guide/waiting-and-events#wait-for-a-person) on the same
issue.

## Known limits

- A stop that arrives just as a turn starts may not reach Claude. About 30
  seconds later the service cancels the run and posts "Stopped." itself. A
  cancelled run releases under your `onFailure` release policy.
- Replies sent while the run tidies up after the conversation ended get no
  answer.
- If the service stops right after Claude's answer was posted, the turn may
  run again and post a second answer.
- An answer Linear rejects on every retry is dropped; Claude's later answers
  still post.
- Linear calls its agent API a Developer Preview, so it may change.
