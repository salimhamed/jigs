# @salimhamed/jigs v0.40.1

Reconcile resources that a completed factory run asked jigs to release automatically.

## Interfaces

### AutomaticReleaseDeps

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

## Functions

### automaticReleaseAction()

> **automaticReleaseAction**(`factory`, `workflowName`, `outcome`, `factoryPolicy?`): `CleanupAction`

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

###### onSuccess

`"release"` \| `"keep"` = `...`

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
