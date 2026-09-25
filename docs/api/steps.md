# @jigs-ai/jigs v0.69.1

APIs for implementing a factory-owned custom agent step. Most workflows use
`runAgent` and other generated routines instead.

Call these inside `"use step"` code. `createAgentRunner` provides a live provider
model with jigs policy applied. Driver interfaces are advanced extension contracts.
See [Custom agent steps](https://salimhamed.github.io/jigs/guide/custom-agent-step).

## Agent runner

### AgentRunner

A harness ready to run in a worktree, from [createAgentRunner](#createagentrunner). Pass `model` to the AI
SDK's `generateText`, read the session reference from its result with `sessionFrom`, and call
`close` when the call is done.

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

#### Properties

##### model

> **model**: `LanguageModel`

The live provider model, with jigs' policy already applied.

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

> **run**: [`RunMetadata`](#runmetadata)

The run the step belongs to: `getWorkflowMetadata()` inside the step.

***

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

## Errors

### AgentSessionError

A durable agent session is missing or cannot be resumed by this harness.

#### Extends

- `Error`

#### Properties

##### name

> `readonly` **name**: `"AgentSessionError"` = `"AgentSessionError"`

###### Overrides

`Error.name`

## Advanced driver contracts

### Check

One requirement check with a stable id and a label for reports.

#### Methods

##### run()

> **run**(): `Promise`\<[`CheckResult`](#checkresult)\>

###### Returns

`Promise`\<[`CheckResult`](#checkresult)\>

#### Properties

##### id

> **id**: `string`

##### label

> **label**: `string`

***

### Driver

How jigs runs one harness or model-source kind: its checks, the environment
it may see, and how it asks, runs or opens a provider model. Each kind a
descriptor can name has exactly one driver inside jigs; a factory cannot
register another.

#### Remarks

A factory reads this to know what `createAgentRunner` does before it
hands back a model. The shape is a published contract: changing it is a
breaking release.

#### Type Parameters

##### K

`K` *extends* `HarnessKind` \| `ModelKind`

#### Methods

##### ask()?

> `optional` **ask**(`request`, `context`): `Promise`\<[`ExecutorGeneration`](#executorgeneration)\>

###### Parameters

###### request

`AgentRequest` | `ModelRequest`

###### context

[`DriverContext`](#drivercontext)

###### Returns

`Promise`\<[`ExecutorGeneration`](#executorgeneration)\>

##### decide()?

> `optional` **decide**\<`QUESTIONS`\>(`request`, `context`): `Promise`\<[`DecisionGeneration`](#decisiongeneration)\<`QUESTIONS`\>\>

###### Type Parameters

###### QUESTIONS

`QUESTIONS` *extends* `JevQuestions`

###### Parameters

###### request

`AskJevOptions`\<`QUESTIONS`\>

###### context

[`DriverContext`](#drivercontext)

###### Returns

`Promise`\<[`DecisionGeneration`](#decisiongeneration)\<`QUESTIONS`\>\>

##### descriptorChecks()?

> `optional` **descriptorChecks**(`source`): [`Check`](#check)[]

###### Parameters

###### source

`Extract`\<`OpenrouterSource`, \{ `kind`: `K`; \}\> | `Extract`\<`OpenaiCompatibleSource`, \{ `kind`: `K`; \}\> | `Extract`\<`OpenaiCodexSource`, \{ `kind`: `K`; \}\>

###### Returns

[`Check`](#check)[]

##### envAllowlist()

> **envAllowlist**(`request`): readonly `string`[]

###### Parameters

###### request

[`DriverRequest`](#driverrequest)

###### Returns

readonly `string`[]

##### installationChecks()

> **installationChecks**(): [`Check`](#check)[]

###### Returns

[`Check`](#check)[]

##### jitChecks()?

> `optional` **jitChecks**(`target`): [`Check`](#check)[]

###### Parameters

###### target

[`HarnessTarget`](#harnesstarget)

###### Returns

[`Check`](#check)[]

##### open()?

> `optional` **open**(`target`, `context`): `Promise`\<[`OpenedModel`](#openedmodel)\>

Build the live provider model for a run. Drivers without a provider model implement `run`.

###### Parameters

###### target

[`HarnessTarget`](#harnesstarget)

###### context

[`OpenContext`](#opencontext)

###### Returns

`Promise`\<[`OpenedModel`](#openedmodel)\>

##### requestChecks()

> **requestChecks**(`request`): [`Check`](#check)[]

###### Parameters

###### request

[`DriverRequest`](#driverrequest)

###### Returns

[`Check`](#check)[]

##### resolveExecutable()?

> `optional` **resolveExecutable**(`env`): `string`

###### Parameters

###### env

`ProcessEnv`

###### Returns

`string`

##### run()?

> `optional` **run**(`request`, `context`): `Promise`\<[`ExecutorGeneration`](#executorgeneration)\>

###### Parameters

###### request

`Omit`\<`RunAgentOptions`\<`undefined`\>, `"output"`\> & `object`

###### context

[`DriverContext`](#drivercontext)

###### Returns

`Promise`\<[`ExecutorGeneration`](#executorgeneration)\>

#### Properties

##### displayName

> **displayName**: `string`

##### family

> **family**: `K` *extends* `"claude"` \| `"codex"` \| `"pi"` ? `"harness"` : `"model"`

##### kind

> **kind**: `K`

##### minimumVersion?

> `optional` **minimumVersion**: `string`

##### sessionPointer?

> `optional` **sessionPointer**: `object`

###### field

> **field**: `string`

###### providerKey

> **providerKey**: `string`

##### setsEnv

> **setsEnv**: readonly `string`[]

Names the driver sets in the harness environment itself, such as a private home.

***

### DriverContext

What a driver receives for one call: the run it belongs to, the harness
environment jigs built for it, and, for a structured call, the output spec a
provider model consumes. `deps` is jigs' own wiring, not part of the contract.

#### Properties

##### env

> **env**: `Record`\<`string`, `string`\>

##### metadata

> **metadata**: [`RunMetadata`](#runmetadata)

##### output?

> `optional` **output**: `Output`\<`unknown`, `unknown`, `never`\>

***

### OpenContext

What a driver's `open` receives: the run and the harness environment jigs built.

#### Properties

##### env

> **env**: `Record`\<`string`, `string`\>

##### metadata

> **metadata**: [`RunMetadata`](#runmetadata)

***

### OpenedModel

A live provider model and what closing it releases.

#### Methods

##### close()

> **close**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

#### Properties

##### model

> **model**: `LanguageModel`

***

### CheckResult

> **CheckResult** = \{ `detail?`: `string`; `ok`: `true`; \} \| \{ `ok`: `false`; `reason`: `string`; `repair`: `string`; \}

A check's outcome: a pass with an optional `detail`, or a failure with its repair.

***

### DecisionGeneration

> **DecisionGeneration**\<`QUESTIONS`\> = `object`

What a driver's `decide` returns: one answer per question.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* `JevQuestions` = `JevQuestions`

#### Properties

##### answers

> **answers**: `JevAnswers`\<`QUESTIONS`\>

***

### DriverRequest

> **DriverRequest** = `AgentRequest` \| `ModelRequest` \| `AskJevOptions`\<`JevQuestions`\> \| [`HarnessTarget`](#harnesstarget)

Any request a driver's checks and environment allowlist are asked about.

***

### ExecutorGeneration

> **ExecutorGeneration** = `ModelGeneration` & `object`

What a driver's call returns: the reply text, provider metadata and any structured output.

#### Type Declaration

##### output?

> `optional` **output**: `unknown`

***

### HarnessTarget

> **HarnessTarget** = `object`

A harness to open in a worktree, resuming a session when one is given.

#### Properties

##### cwd

> **cwd**: `string`

##### harness

> **harness**: `Harness`

##### resume?

> `optional` **resume**: `AgentSessionRef`

***

### RunRequest

> **RunRequest** = `Extract`\<`AgentRequest`, \{ `cwd`: `string`; \}\>

An agent request that runs in a worktree.

## Runtime metadata

### RunMetadata

> **RunMetadata** = `Pick`\<`WorkflowMetadata`, `"workflowRunId"`\>

The run a step belongs to: `getWorkflowMetadata()` inside the step.
