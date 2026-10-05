# Slack

A factory talks to Slack through a Slack app that its
[hub](/guide/configuration#hub) holds and assigns to it. The app always posts
as its own bot. The hub receives the app's events and hands the factory its bot
token, so the factory's `.env` holds no Slack token. This page sets the app up
and connects it to the factory.

## 1. Set up the app in the hub

In the hub, add a Slack app and follow its page: it lists the Request URL,
Redirect URL and bot events to set in the app's settings at
[api.slack.com/apps](https://api.slack.com/apps), with Socket Mode and token
rotation off. Install the app in your workspace with **Add to Slack**, then
assign it to the factory.

The hub asks the workspace for these bot scopes:

| Bot scope | What jigs uses it for |
| --- | --- |
| `channels:history` | Reading messages in public channels the bot is in. |
| `groups:history` | Reading messages in private channels the bot is in. |
| `chat:write` | Posting messages and thread replies. |
| `users:read` | Looking up the names of the people who wrote a message. |
| `users:read.email` | Looking up their email addresses. |

Some workspaces require an admin to approve new apps. If yours does, Slack asks
for approval when you install.

## 2. Invite the bot to channels

The bot only sees channels it is a member of. In each channel the factory
should watch, public or private, type `/invite @<bot name>`. jigs never reads
direct messages.

## 3. Configure the factory

Add a `slack` section to `jigs.config.ts`:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
slack: {},
```

The hub keeps the events that arrive while the service is down. The service
also polls every
[`service.pollIntervalSeconds.slack`](/guide/configuration#service) seconds.

A workflow that uses Slack declares it:

```ts
import type { WorkflowDefinition } from "@jigs-ai/jigs";

const requires = {
  integrations: ["slack"],
} satisfies WorkflowDefinition["requires"];
```

Run `pnpm exec jigs up` to rebuild and restart the service.

## Start runs from messages

An event trigger starts one run per message. Pick one of two sources:

| Source | Starts a run for |
| --- | --- |
| `slack.messages({ channels })` | Every top-level message in the channels. |
| `slack.mentions({ channels })` | Only top-level messages that mention the bot, such as `@<name>'s jigs`. |

List channels by ID, such as `C0123ABCD`, not by name. Slack shows a channel's
ID at the bottom of its details. The bot must be a member of each one.

```ts
// jigs.config.ts
import { defineFactory, slack } from "@jigs-ai/jigs";

export default defineFactory({
  hub: { url: "https://hub.example.com" },
  service: { dashboardPort: 3456 },
  workflows: { answer: () => import("./workflows/answer/answer.ts") },
  slack: {},
  triggers: {
    "answer-questions": {
      workflow: "answer",
      source: slack.mentions({ channels: ["C0123ABCD"] }),
    },
  },
});
```

Each run gets the inputs `{ channel, ts }`, the message's channel and
timestamp, merged over the trigger's own `inputs`. They are a reference: the
run reads the message itself. `jigs status` shows them as
`slack <channel> <ts>` from the moment the run starts, so you can tell which
post a run is for. The workflow's inputs must accept them:

```ts
// workflows/answer/answer.ts
import { defineWorkflow, type WorkflowInputs } from "@jigs-ai/jigs";
import { z } from "zod";

const inputs = z.object({ channel: z.string(), ts: z.string() });

export async function answer(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  return { channel: input.channel, ts: input.ts };
}

export default defineWorkflow({
  inputs,
  requires: { integrations: ["slack"] },
  workflow: answer,
});
```

Every new top-level post counts: from a person, from another bot or app (such
as a Workflow Builder announcement), with or without files. The factory's own
posts never start a run, and neither do thread replies (even one also sent to
the channel), edits, deletes, joins, topic changes or other channel events.
Direct messages are never read.

Each message starts at most one run, whether it arrives through the hub, by
polling or both, and however often Slack sends it again. A new trigger starts
with messages posted after the service first runs it. After the service was
down, it starts runs only for messages from the last 60 minutes; set the
trigger's `lookbackMinutes` to change that. At most 20 of a trigger's runs are
active at once, and later messages wait their turn; set `maxActive` to change
that.

When a channel cannot be read, for example because the bot was removed from
it, polling skips that channel and keeps reading the trigger's other channels.
The service log names the channel and how to fix it: invite the bot back or
remove the channel from the trigger. Messages posted there while it was skipped
start runs only if the hub delivered them.

## Read a message

`fetchSlackMessage({ channel, ts })` reads a message, its permalink and its
thread's replies, oldest first. Each post names its author, with their display
name, their email, whether they are a bot, and `isOwnBot` for the factory's own
bot. `ts` must be a top-level message; a reply's `ts` reads as gone. A deleted
message reads as `{ gone: true }`, so the workflow can end quietly:

```ts
import { fetchSlackMessage } from "#jigs/steps";

export async function readMessage(channel: string, ts: string) {
  const message = await fetchSlackMessage({ channel, ts });
  if (message.gone) return null;
  return `${message.author.name}: ${message.text}`;
}
```

Like every step, a read is recorded, so a resumed run sees the same message it
saw before. Read again to see what changed.

## Post a message

`postSlackMessage({ channel, text, threadTs })` posts plain Slack `mrkdwn`
text as the factory's bot. With `threadTs` it replies in the thread under that
message; without it, it posts a new message in the channel. It returns the new
message's `ts`.

A post is tried once. If Slack's answer is lost, the step fails rather than
risk posting twice.

## Wait for a reply

`waitForSlackReply({ channel, threadTs, lastRead })` parks the run until someone
replies in the thread under `threadTs`, and ends `replied` with every reply
posted after `lastRead`, oldest first. `threadTs` must be the thread's top-level
message, never a reply.

`lastRead` is the ts of the newest post the workflow has read: usually the
last reply in its latest `fetchSlackMessage`, or `threadTs` when the thread had
no replies. Never pass the question the workflow just posted, or a reply
posted while the run was working is missed. A reply already in the thread
returns at once, so it may not answer the question just asked.

The result's `outcome` says how the wait ended. With `replied`, `replies` is
never empty, and each reply has its text and author. The outcome is
`timed-out` instead when `until` passes, and `gone` when the thread's top-level
message was deleted, before or during the wait:

```ts
import { waitForSlackReply } from "#jigs/routines";
import { fetchSlackMessage, postSlackMessage } from "#jigs/steps";

export async function askInThread(channel: string, ts: string, question: string) {
  const thread = await fetchSlackMessage({ channel, ts });
  if (thread.gone) return "the message was deleted";
  const lastRead = thread.replies.at(-1)?.ts ?? ts;
  await postSlackMessage({ channel, threadTs: ts, text: question });
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = await waitForSlackReply({ channel, threadTs: ts, lastRead, until });
  if (result.outcome === "timed-out") return "no reply within a day";
  if (result.outcome === "gone") return "the message was deleted";
  return result.replies.map((reply) => `${reply.author.name}: ${reply.text}`).join("\n");
}
```

Any person's reply counts. Replies from bots, including the factory's own, never
do. Without `until`, the wait has no time limit: it ends with a reply, or when
you cancel the run with `jigs cancel`. With `until`, an ISO 8601 timestamp, it
ends `timed-out` once that time passes with no reply. The thread is always
read once first, so a reply already there still wins when `until` is in the
past. A reply heard through the hub wakes the run within seconds.
The service also re-reads the thread every
[`service.pollIntervalSeconds.slack`](/guide/configuration#service) seconds,
and `jigs poke` re-reads it at once. Only one run can wait on a thread at a
time.

## Call other Slack methods

`callSlack(method, params)` calls any
[Slack Web API method](https://api.slack.com/methods) as the factory's bot and
returns Slack's response. Use it to react to a message, update or pin one, or
anything else jigs has no step for. Call it from your own `"use step"`
function. Arguments that are not strings, such as `blocks`, are sent as JSON.

When Slack answers with an error, `callSlack` throws a `SlackApiError` whose
`code` is Slack's error, such as `already_reacted`. A step can run more than
once, so a call that is not safe to repeat should treat the error a repeat gets
as success. Here a deleted message, `message_not_found`, is tolerated too:

```ts
// workflows/deploys/steps.ts
import { callSlack, SlackApiError } from "@jigs-ai/jigs/steps/slack";

export async function addReaction(channel: string, timestamp: string, name: string) {
  "use step";
  try {
    await callSlack("reactions.add", { channel, timestamp, name });
  } catch (error) {
    const tolerated = ["already_reacted", "message_not_found"];
    if (!(error instanceof SlackApiError && tolerated.includes(error.code))) throw error;
  }
}
```

Workflow code calls it like any step: `await addReaction(channel, ts, "eyes")`.

A method may need a bot scope jigs does not use, such as `reactions:write` for
`reactions.add`. Add it to the app's bot scopes in the hub, install the app
again, and list it in `slack.scopes` so `jigs doctor` checks the bot holds it:

```ts factory-options
// Inside defineFactory({ ... }) in jigs.config.ts
slack: { scopes: ["reactions:write"] },
```

## Example: answer questions in a channel

This workflow starts for each message that mentions the bot. A Jev decision
model decides whether it is a question about the codebase, and whether it is
clear enough to answer. If not clear, the workflow asks in the thread and waits.
Then an agent researches the code and the answer is posted in the thread.

```ts
// workflows/answer/answer.ts
import { defineWorkflow, harnesses, models, type WorkflowInputs, yesNo } from "@jigs-ai/jigs";
import { z } from "zod";
import { askJev, runAgent, waitForSlackReply } from "#jigs/routines";
import { fetchSlackMessage, postSlackMessage, provisionWorktree } from "#jigs/steps";

const inputs = z.object({ channel: z.string(), ts: z.string() });
const agents = { researcher: harnesses.claude({ model: "sonnet" }) };
const decisionModel = models.openrouter("typesafe/jev-1.13");

export async function answer(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  const { channel, ts } = input;
  const message = await fetchSlackMessage({ channel, ts });
  if (message.gone) return { answered: false };

  const { answers } = await askJev({
    model: decisionModel,
    state: { message: message.text },
    questions: {
      aboutCode: yesNo("Is this a question about the codebase?"),
      clear: yesNo("Is it clear enough to answer without asking anything back?"),
    },
  });
  if (answers.aboutCode.probability < 0.7) return { answered: false };

  let question = message.text;
  if (answers.clear.probability < 0.5) {
    const lastRead = message.replies.at(-1)?.ts ?? ts;
    await postSlackMessage({
      channel,
      threadTs: ts,
      text: "Which part of the codebase do you mean?",
    });
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await waitForSlackReply({ channel, threadTs: ts, lastRead, until });
    if (result.outcome !== "replied") return { answered: false };
    for (const reply of result.replies) {
      question += `\n\n${reply.author.name} added: ${reply.text}`;
    }
  }

  const worktree = await provisionWorktree({ binding: "app", branch: `answer/${input.triggerId}` });
  const research = await runAgent({
    harness: agents.researcher,
    cwd: worktree.path,
    prompt: `Answer this question about the code. Do not change files.\n\n${question}`,
  });
  await postSlackMessage({ channel, threadTs: ts, text: research.text });
  return { answered: true };
}

export default defineWorkflow({
  inputs,
  requires: { agents, bindings: ["app"], integrations: ["slack"], models: [decisionModel] },
  workflow: answer,
});
```

Register it with the `slack.mentions` trigger from
[Start runs from messages](#start-runs-from-messages). The decision model needs
`OPENROUTER_API_KEY` in `.env`; see
[Models and harnesses](/guide/models-and-harnesses#jev-decisions).

## Checks

`jigs doctor`, and `jigs up`, check that the hub has assigned the factory a
Slack app, that it hands out the app's bot token, and that the workspace
granted every scope above, plus any listed in `slack.scopes`. Each failure
names what to fix in the hub.

Before every run of a workflow that requires `slack`, preflight checks the bot
token and the same scopes. If the bot lacks one, including one listed in
`slack.scopes`, the run stops before it starts.
