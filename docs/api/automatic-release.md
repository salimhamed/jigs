# @salimhamed/jigs v0.46.0

Reconcile resources that a completed factory run asked jigs to release automatically.

## Interfaces

### AutomaticReleaseDeps

Injectable operations used by automatic release reconciliation.

#### Properties

##### hasActiveStep()

> **hasActiveStep**: (`runId`) => `Promise`\<`boolean`\>

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<`boolean`\>

##### listRuns()

> **listRuns**: () => `Promise`\<[`CleanupRun`](#cleanuprun)[]\>

###### Returns

`Promise`\<[`CleanupRun`](#cleanuprun)[]\>

##### log()

> **log**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### policy()

> **policy**: (`factory`, `run`, `outcome`) => `CleanupAction`

###### Parameters

###### factory

`Factory`

###### run

[`CleanupRun`](#cleanuprun)

###### outcome

`CleanupOutcome`

###### Returns

`CleanupAction`

##### ready()

> **ready**: () => `boolean`

###### Returns

`boolean`

##### release()

> **release**: (`run`, `action`, `outcome`, `sql`) => `Promise`\<\{ `runDirectory`: \{ `removed`: `boolean`; \}; `worktrees`: `object`[]; \}\>

###### Parameters

###### run

[`CleanupRun`](#cleanuprun)

###### action

`CleanupAction`

###### outcome

`CleanupOutcome`

###### sql

`RegistrySql`

###### Returns

`Promise`\<\{ `runDirectory`: \{ `removed`: `boolean`; \}; `worktrees`: `object`[]; \}\>

##### setTimer()

> **setTimer**: (`fire`, `ms`) => () => `void`

###### Parameters

###### fire

() => `void`

###### ms

`number`

###### Returns

> (): `void`

###### Returns

`void`

##### waitForTerminal()

> **waitForTerminal**: (`runId`, `signal`) => `Promise`\<[`CleanupRun`](#cleanuprun)\>

###### Parameters

###### runId

`string`

###### signal

`AbortSignal`

###### Returns

`Promise`\<[`CleanupRun`](#cleanuprun)\>

##### warn()

> **warn**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### withLock()

> **withLock**: \<`T`\>(`runId`, `action`) => `Promise`\<`T`\>

###### Type Parameters

###### T

`T`

###### Parameters

###### runId

`string`

###### action

(`sql`) => `Promise`\<`T`\>

###### Returns

`Promise`\<`T`\>

##### worktreeCount()

> **worktreeCount**: (`runId`, `sql`) => `Promise`\<`number`\>

###### Parameters

###### runId

`string`

###### sql

`RegistrySql`

###### Returns

`Promise`\<`number`\>

##### writeProgress()

> **writeProgress**: (`runId`, `progress`, `store`) => `Promise`\<`void`\>

###### Parameters

###### runId

`string`

###### progress

`CleanupProgress`

###### store

`CleanupAttributeStore` = `...`

###### Returns

`Promise`\<`void`\>

***

### AutomaticReleaseReport

Counts from one automatic release reconciliation pass.

#### Properties

##### busy

> **busy**: `number`

##### considered

> **considered**: `number`

##### failed

> **failed**: `number`

##### kept

> **kept**: `number`

##### released

> **released**: `number`

***

### CleanupRun

The run fields used to decide and record automatic resource cleanup.

#### Properties

##### attributes

> **attributes**: `Record`\<`string`, `string`\>

##### runId

> **runId**: `string`

##### status

> **status**: `string`

##### workflowName

> **workflowName**: `string`

## Variables

### AUTOMATIC\_RELEASE\_INTERVAL\_MS

> `const` **AUTOMATIC\_RELEASE\_INTERVAL\_MS**: `60000` = `60_000`

Recovery interval for discovering terminal runs that still need cleanup.

## Functions

### automaticReleaseAction()

> **automaticReleaseAction**(`factory`, `workflowName`, `outcome`, `factoryPolicy?`): `CleanupAction`

Resolve the cleanup action for a workflow outcome and its effective release policy.

#### Parameters

##### factory

`Factory`

##### workflowName

`string`

##### outcome

`CleanupOutcome`

##### factoryPolicy?

###### onFailure

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a completed run.

#### Returns

`CleanupAction`

***

### reconcileAutomaticRelease()

> **reconcileAutomaticRelease**(`factory`, `deps`, `options`): `Promise`\<[`AutomaticReleaseReport`](#automaticreleasereport)\>

One idempotent recovery pass; the long-poll watcher only makes this run sooner.

#### Parameters

##### factory

`Factory`

##### deps

[`AutomaticReleaseDeps`](#automaticreleasedeps) = `...`

##### options

###### canStart?

() => `boolean`

#### Returns

`Promise`\<[`AutomaticReleaseReport`](#automaticreleasereport)\>

***

### startAutomaticRelease()

> **startAutomaticRelease**(`factory`, `deps`): `object`

Start notification-fast cleanup with polling recovery and restart reconciliation.

#### Parameters

##### factory

`Factory`

##### deps

[`AutomaticReleaseDeps`](#automaticreleasedeps) = `...`

#### Returns

`object`

##### stop()

> **stop**: () => `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>
