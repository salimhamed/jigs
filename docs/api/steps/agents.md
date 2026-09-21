# @salimhamed/jigs v0.41.3

Execute agent and model requests outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Interfaces

### AgentExecutionDependencies

Injectable provider and environment operations used by agent execution.

#### Extends

- `DriverDependencies`

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

###### Inherited from

`DriverDependencies.withCodexAppServer`

#### Methods

##### ensureCodexHome()

> **ensureCodexHome**(`runId`): `string`

###### Parameters

###### runId

`string`

###### Returns

`string`

###### Inherited from

`DriverDependencies.ensureCodexHome`

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

###### Inherited from

`DriverDependencies.generateText`

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

Production dependencies for executing harness requests.

## Functions

### executeAgent()

> **executeAgent**(`wire`, `metadata`, `deps`): `Promise`\<`AgentResult` \| \{ `jitFailure`: `object` & `object`[]; \} \| \{ `resumeFailed`: `string`; \}\>

Run or ask an agent harness, checking worktree requirements before a run.

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

### executeJev()

> **executeJev**(`_wire`): `Promise`\<`never`\>

Reserved durable wrapper target for judge/evaluate/verify requests.

#### Parameters

##### \_wire

`unknown`

#### Returns

`Promise`\<`never`\>

***

### executeModel()

> **executeModel**(`wire`, `metadata`, `deps`): `Promise`\<`ModelResult`\>

Ask an API-backed model source.

#### Parameters

##### wire

`ModelRequest`

##### metadata

`RunMetadata`

##### deps

[`AgentExecutionDependencies`](#agentexecutiondependencies) = `defaultAgentExecutionDependencies`

#### Returns

`Promise`\<`ModelResult`\>
