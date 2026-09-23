# @salimhamed/jigs v0.49.0

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

Persist an explicit success action, release under the run lock and return the result.

#### Parameters

##### policy

###### onFailure

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a completed run.

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

Resolve the workflow policy, then the factory policy, then the built-in release/keep default.

#### Parameters

##### metadata

`NamedRunMetadata`

##### definition

`FactoryDefinition`

#### Returns

`Promise`\<\{ `onFailure`: `"release"` \| `"keep"`; `onSuccess`: `"release"` \| `"keep"`; \}\>
