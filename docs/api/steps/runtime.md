# @jigs-ai/jigs v0.68.1

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

> **releaseRunResources**(`metadata`, `definition`, `explicit?`): `Promise`\<`ReleaseReport`\>

Release this run's resources on its success path and return what was removed or kept.

#### Parameters

##### metadata

`NamedRunMetadata`

##### definition

`FactoryDefinition`

##### explicit?

###### onFailure

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a completed run.

#### Returns

`Promise`\<`ReleaseReport`\>

#### Remarks

Without a policy, uses the workflow's `release`, then the factory's, then the default of
releasing successful runs and keeping failed ones. The success action is recorded first, so
automatic cleanup after the run ends never reverses it.

***

### removeRunDirectory()

> **removeRunDirectory**(`metadata`): `Promise`\<`void`\>

Remove this run's working directory after its work is finished, never while paused.

#### Parameters

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`void`\>
