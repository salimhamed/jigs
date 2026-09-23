# @jigs-ai/jigs v0.52.1

Execute agent and model requests outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Interfaces

### AgentExecutionDependencies

Injectable provider and environment operations used by agent execution.

#### Extends

- `DriverDependencies`

#### Properties

##### resolveDriver()

> **resolveDriver**: \<`K`\>(`kind`) => `Driver`\<`K`\> \| `undefined`

Return the installed driver for a descriptor kind, if this release provides one.

###### Type Parameters

###### K

`K` *extends* `DriverKind`

###### Parameters

###### kind

`K`

###### Returns

`Driver`\<`K`\> \| `undefined`

#### Methods

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

##### factoryEnv()

> **factoryEnv**(): readonly `string`[]

Names the factory declares under `agents.env` in `jigs.config.ts`.

###### Returns

readonly `string`[]

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

> **jitFailures**(`wire`, `env`): `Promise`\<`object` & `object`[] \| `undefined`\>

###### Parameters

###### wire

`AgentRequest`

###### env

`Record`\<`string`, `string`\>

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
