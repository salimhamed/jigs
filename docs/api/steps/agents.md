# @salimhamed/jigs v0.41.2

Execute agent and model requests outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Interfaces

### AgentExecutionDependencies

Injectable provider and environment operations used by agent execution.

#### Properties

##### withCodexAppServer()

> **withCodexAppServer**: \<`T`\>(`fn`) => `Promise`\<`T`\>

###### Type Parameters

###### T

`T`

###### Parameters

###### fn

(`provider`) => `Promise`\<`T`\>

###### Returns

`Promise`\<`T`\>

#### Methods

##### ensureCodexHome()

> **ensureCodexHome**(`runId`): `string`

###### Parameters

###### runId

`string`

###### Returns

`string`

##### generateText()

> **generateText**(`options`): `Promise`\<`ExecutorGeneration`\>

###### Parameters

###### options

###### model

`LanguageModel`

###### output?

`Output`\<`unknown`, `unknown`, `never`\>

###### prompt

`string`

###### providerOptions?

`Record`\<`string`, `Record`\<`string`, `string`\>\>

###### system?

`string`

###### Returns

`Promise`\<`ExecutorGeneration`\>

##### jitFailures()

> **jitFailures**(`wire`): `Promise`\<`object` & `object`[] \| `undefined`\>

###### Parameters

###### wire

`AgentRequest`

###### Returns

`Promise`\<`object` & `object`[] \| `undefined`\>

## Variables

### defaultAgentExecutionDependencies

> `const` **defaultAgentExecutionDependencies**: [`AgentExecutionDependencies`](#agentexecutiondependencies)

Production dependencies for executing Claude Code and Codex requests.

## Functions

### executeAgent()

> **executeAgent**(`wire`, `metadata`, `deps`): `Promise`\<`AgentResult` \| \{ `jitFailure`: `object` & `object`[]; \} \| \{ `resumeFailed`: `string`; \}\>

Run an agent in its worktree, checking required tools before it starts.

#### Parameters

##### wire

`AgentRequest`

##### metadata

`RunMetadata`

##### deps

[`AgentExecutionDependencies`](#agentexecutiondependencies) = `defaultAgentExecutionDependencies`

#### Returns

`Promise`\<`AgentResult` \| \{ `jitFailure`: `object` & `object`[]; \} \| \{ `resumeFailed`: `string`; \}\>

***

### executeModel()

> **executeModel**(`wire`, `metadata`, `deps`): `Promise`\<`ModelResult`\>

Ask a model a question without giving it a worktree or tools.

#### Parameters

##### wire

`ModelRequest`

##### metadata

`RunMetadata`

##### deps

[`AgentExecutionDependencies`](#agentexecutiondependencies) = `defaultAgentExecutionDependencies`

#### Returns

`Promise`\<`ModelResult`\>
