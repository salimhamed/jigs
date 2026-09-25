# @jigs-ai/jigs v0.63.0

Build a factory's own agent step. `createAgentRunner` opens a harness the way the built-in
agent step does and hands back the live provider model.

Call these inside a factory-owned `"use step"` function, never from a workflow.

## Classes

### AgentSessionError

A durable agent session is missing or cannot be resumed by this harness.

#### Extends

- `Error`

#### Properties

##### name

> `readonly` **name**: `"AgentSessionError"` = `"AgentSessionError"`

###### Overrides

`Error.name`

## Interfaces

### AgentRunner

A harness ready to run in a worktree, from [createAgentRunner](#createagentrunner). Pass `model` to the AI
SDK's `generateText`, read the session reference from its result with `sessionFrom`, and call
`close` when the call is done.

#### Properties

##### model

> **model**: `LanguageModel`

The live provider model, with jigs' policy already applied.

#### Methods

##### close()

> **close**(): `Promise`\<`void`\>

Release the worktree lock and stop what the harness started. Safe to call twice.

###### Returns

`Promise`\<`void`\>

##### sessionFrom()

> **sessionFrom**(`result`): `AgentSessionRef` \| `undefined`

The session reference in a `generateText` result, for a later step to resume.

###### Parameters

###### result

###### providerMetadata?

`Record`\<`string`, `Record`\<`string`, `unknown`\>\> \| `null`

###### Returns

`AgentSessionRef` \| `undefined`

***

### AgentRunnerOptions

Where [createAgentRunner](#createagentrunner) runs a harness, and the session it resumes.

#### Properties

##### cwd

> **cwd**: `string`

The worktree the agent works in.

##### resume?

> `optional` **resume**: `AgentSessionRef`

A session reference from an earlier call to resume.

##### run

> **run**: `RunMetadata`

The run the step belongs to: `getWorkflowMetadata()` inside the step.

## Functions

### createAgentRunner()

> **createAgentRunner**(`harness`, `options`): `Promise`\<[`AgentRunner`](#agentrunner)\>

Open a Claude Code or Codex harness inside a factory's own step, the way the built-in agent
step does: the environment allowlist with the factory's `agents.env`, the request and
just-in-time checks, the worktree lock, Codex's private home and app server, and the Claude
spawn hook. The returned `model` is the live provider, ready for `generateText`.

#### Parameters

##### harness

`Harness`

##### options

[`AgentRunnerOptions`](#agentrunneroptions)

#### Returns

`Promise`\<[`AgentRunner`](#agentrunner)\>

#### Remarks

Call it inside a `"use step"` function, never in a workflow. The step can hand the provider a
function, such as a tool-approval hook or a logger, because a step runs where functions are
allowed; pass it through the AI SDK call.

It throws `JitCheckError` when a just-in-time check fails, and [AgentSessionError](#agentsessionerror) when
`resume` names a session this harness cannot resume. Pi has no provider model, so a Pi
descriptor throws: run Pi with `runAgent`.

#### Example

```ts
import type { AgentSessionRef, Harness } from "@jigs-ai/jigs";
import { createAgentRunner } from "@jigs-ai/jigs/steps";
import { generateText } from "ai";
import { getWorkflowMetadata } from "workflow";

export async function runWithTemperature(request: {
  harness: Harness;
  cwd: string;
  prompt: string;
  resume?: AgentSessionRef | undefined;
}) {
  "use step";
  const runner = await createAgentRunner(request.harness, {
    cwd: request.cwd,
    run: getWorkflowMetadata(),
    resume: request.resume,
  });
  try {
    const result = await generateText({ model: runner.model, prompt: request.prompt, temperature: 0 });
    return { text: result.text, session: runner.sessionFrom(result) };
  } finally {
    await runner.close();
  }
}
```
