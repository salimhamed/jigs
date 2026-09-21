# @salimhamed/jigs v0.44.2

Execute agent and model requests outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Interfaces

### AgentExecutionDependencies

Injectable provider and environment operations used by agent execution.

#### Extends

- `DriverDependencies`

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

##### ensurePiHome()

> **ensurePiHome**(`runId`, `source`): `string`

###### Parameters

###### runId

`string`

###### source

`ModelSource`

###### Returns

`string`

###### Inherited from

`DriverDependencies.ensurePiHome`

##### evaluate()

> **evaluate**\<`QUESTIONS`\>(`options`): `Promise`\<`EvaluationGeneration`\>

###### Type Parameters

###### QUESTIONS

`QUESTIONS` *extends* `Record`\<`string`, `EvaluationModelV4Question`\>

###### Parameters

###### options

###### model

`EvaluationModel`

###### questions

`QUESTIONS`

###### state

`JevState`

###### Returns

`Promise`\<`EvaluationGeneration`\>

###### Inherited from

`DriverDependencies.evaluate`

##### executePi()

> **executePi**(`options`): `Promise`\<`ExecutorGeneration`\>

###### Parameters

###### options

`PiExecutionOptions`

###### Returns

`Promise`\<`ExecutorGeneration`\>

###### Inherited from

`DriverDependencies.executePi`

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

`SharedV4ProviderOptions`

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

##### withCodexAppServer()

> **withCodexAppServer**\<`T`\>(`fn`): `Promise`\<`T`\>

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

> **executeJev**\<`QUESTIONS`\>(`wire`, `metadata`, `deps`): `Promise`\<`JevResult`\<`QUESTIONS`\>\>

Evaluate typed questions with a decision-capable model.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* `JevQuestions`

#### Parameters

##### wire

`AskJevOptions`\<`QUESTIONS`\>

##### metadata

`RunMetadata`

##### deps

[`AgentExecutionDependencies`](#agentexecutiondependencies) = `defaultAgentExecutionDependencies`

#### Returns

`Promise`\<`JevResult`\<`QUESTIONS`\>\>

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
