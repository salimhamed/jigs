# @salimhamed/jigs v0.40.1

Read run context and update run resources outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Functions

### createRunDirectory()

> **createRunDirectory**(`metadata`): `Promise`\<`string`\>

Create a working directory that survives retries and pauses in this run.

#### Parameters

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`string`\>

***

### dashboardRunUrl()

> **dashboardRunUrl**(`runId`): `string` \| `undefined`

The run's page on the dashboard this service hosts, or undefined when the
service was started without one. Never a standalone `workflow web` URL: run
against a live World it opens a second queue worker and steals the jobs the
run is waiting on.

#### Parameters

##### runId

`string`

#### Returns

`string` \| `undefined`

***

### registerResource()

> **registerResource**(`resource`): `Promise`\<`RunResource`\>

Register one resource on the active run.

Repeating kind + identity is idempotent. A new URL for that identity
replaces the old URL; concurrent updates are last-committed-wins. Distinct
identities occupy distinct atomic keys.

#### Parameters

##### resource

`RunResource`

#### Returns

`Promise`\<`RunResource`\>

***

### releaseRunResources()

> **releaseRunResources**(`policy`, `metadata`): `Promise`\<`ReleaseReport`\>

The explicit durable step path: persist its choice and share the automatic lock.

#### Parameters

##### policy

###### onFailure

`"release"` \| `"keep"` = `...`

###### onSuccess

`"release"` \| `"keep"` = `...`

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`ReleaseReport`\>

***

### removeRunDirectory()

> **removeRunDirectory**(`metadata`): `Promise`\<`void`\>

Remove this run's working directory after its work is finished, never while paused.

#### Parameters

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`void`\>

***

### resolveReleasePolicy()

> **resolveReleasePolicy**(`metadata`, `definition`): `Promise`\<\{ `onFailure`: `"release"` \| `"keep"`; `onSuccess`: `"release"` \| `"keep"`; \}\>

Definition imports are compiled factory modules, supplied by the generated step wrapper.

#### Parameters

##### metadata

`NamedRunMetadata`

##### definition

`FactoryDefinition`

#### Returns

`Promise`\<\{ `onFailure`: `"release"` \| `"keep"`; `onSuccess`: `"release"` \| `"keep"`; \}\>
