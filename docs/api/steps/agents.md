# @jigs-ai/jigs v0.67.0

Execute agent and model requests outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Functions

### executeAgent()

> **executeAgent**(`wire`, `metadata`): `Promise`\<`AgentResult` \| \{ `jitFailure`: `object` & `object`[]; \} \| \{ `resumeFailed`: `string`; \}\>

Run or ask an agent harness, checking worktree requirements before a run.

#### Parameters

##### wire

`AgentRequest`

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`AgentResult` \| \{ `jitFailure`: `object` & `object`[]; \} \| \{ `resumeFailed`: `string`; \}\>

***

### executeJev()

> **executeJev**\<`QUESTIONS`\>(`wire`, `metadata`): `Promise`\<`JevResult`\<`QUESTIONS`\>\>

Evaluate typed questions with a decision-capable model.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* `JevQuestions`

#### Parameters

##### wire

`AskJevOptions`\<`QUESTIONS`\>

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`JevResult`\<`QUESTIONS`\>\>

***

### executeModel()

> **executeModel**(`wire`, `metadata`): `Promise`\<`ModelResult`\>

Ask an API-backed model source.

#### Parameters

##### wire

`ModelRequest`

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`ModelResult`\>
