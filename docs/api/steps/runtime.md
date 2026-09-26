# @jigs-ai/jigs v0.76.0

Run directories, resource records and release operations for factory-owned steps.
Workflow code normally calls the generated `#jigs/steps` wrappers.

A run directory is scratch space owned by one run, kept across waits and retries
until released. Every resource a run records shows in `jigs status` with its state;
jigs releases only the kinds it creates itself. The generated `release` step can
release early or return a report; the service applies release policy when runs end.

## Run directories

### createRunDirectory()

> **createRunDirectory**(`metadata`): `Promise`\<`string`\>

Create a working directory that survives retries and pauses in this run.

#### Parameters

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`string`\>

***

### removeRunDirectory()

> **removeRunDirectory**(`metadata`): `Promise`\<`void`\>

Remove this run's working directory after its work is finished, never while paused.

#### Parameters

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`void`\>

## Recorded resources

### registerResource()

> **registerResource**(`resource`): `Promise`\<`RunResource`\>

Register one resource on the active run so `jigs status` shows it.

Repeating kind + identity is idempotent; a new URL for that identity replaces the old one.
The record is observation only: it stays `live` as the run's history and jigs never deletes
what it names. The kinds jigs records itself (`worktree`, `run-directory`, `branch`,
`codex-home`, `pi-home`) are reserved.

#### Parameters

##### resource

`RunResource`

#### Returns

`Promise`\<`RunResource`\>

## Release

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

`"release"` \| `"keep"` = `releaseAction`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `releaseAction`

What to do with eligible resources after a completed run.

#### Returns

`Promise`\<`ReleaseReport`\>

#### Remarks

Without a policy, uses the workflow's `release`, then the factory's, then the default of
releasing successful runs and keeping failed ones. Kept records are final: automatic release
after the run ends only visits records that are still live or failed.

## Advanced run context

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
