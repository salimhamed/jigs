# @jigs-ai/jigs v0.70.0

Low-level agent and model execution functions for factory-owned step wrappers.

Workflow code normally uses `runAgent`, `askAgent`, `askModel` and `askJev` from
`#jigs/routines`. These implementations must run inside `"use step"` code.
See [Models and harnesses](https://salimhamed.github.io/jigs/guide/models-and-harnesses).

## Execution primitives

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
