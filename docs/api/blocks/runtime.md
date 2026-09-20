# @salimhamed/jigs v0.40.1

Compose run resource registration and release policy inside a workflow.

## Interfaces

### CleanupProgress

#### Extended by

- [`CleanupView`](#cleanupview)

#### Properties

##### action?

> `optional` **action**: `CleanupAction`

##### detail?

> `optional` **detail**: `string`

##### failed?

> `optional` **failed**: `number`

##### kept?

> `optional` **kept**: `number`

##### outcome?

> `optional` **outcome**: `CleanupOutcome`

##### released?

> `optional` **released**: `number`

##### status

> **status**: `CleanupStatus`

##### unknown?

> `optional` **unknown**: `number`

***

### CleanupView

#### Extends

- [`CleanupProgress`](#cleanupprogress)

#### Properties

##### action?

> `optional` **action**: `CleanupAction`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`action`](#action)

##### detail?

> `optional` **detail**: `string`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`detail`](#detail)

##### directive

> **directive**: `CleanupAction` \| `"automatic"`

##### failed?

> `optional` **failed**: `number`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`failed`](#failed)

##### kept?

> `optional` **kept**: `number`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`kept`](#kept)

##### outcome?

> `optional` **outcome**: `CleanupOutcome`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`outcome`](#outcome)

##### released?

> `optional` **released**: `number`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`released`](#released)

##### status

> **status**: `CleanupStatus`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`status`](#status)

##### unknown?

> `optional` **unknown**: `number`

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`unknown`](#unknown)

***

### ReleaseReport

#### Properties

##### policy

> **policy**: `object`

###### onFailure

> **onFailure**: `"release"` \| `"keep"`

###### onSuccess

> **onSuccess**: `"release"` \| `"keep"`

##### runDirectory

> **runDirectory**: `ReleasedResource`

##### worktrees

> **worktrees**: `ReleasedResource` & `object`[]

***

### ReleaseSteps

#### Properties

##### releaseRunResources()

> **releaseRunResources**: (`policy`) => `Promise`\<[`ReleaseReport`](#releasereport)\>

###### Parameters

###### policy

###### onFailure

`"release"` \| `"keep"` = `...`

###### onSuccess

`"release"` \| `"keep"` = `...`

###### Returns

`Promise`\<[`ReleaseReport`](#releasereport)\>

##### resolveReleasePolicy()

> **resolveReleasePolicy**: () => `Promise`\<\{ `onFailure`: `"release"` \| `"keep"`; `onSuccess`: `"release"` \| `"keep"`; \}\>

###### Returns

`Promise`\<\{ `onFailure`: `"release"` \| `"keep"`; `onSuccess`: `"release"` \| `"keep"`; \}\>

***

### RunResource

A durable thing a run created or otherwise owns a reference to.

#### Properties

##### identity

> **identity**: `string`

##### kind

> **kind**: `string`

##### url

> **url**: `string`

## Type Aliases

### ReleasePolicy

> **ReleasePolicy** = `z.input`\<*typeof* `releaseSchema`\>

## Functions

### bindReleaseSteps()

> **bindReleaseSteps**(`steps`): `object`

#### Parameters

##### steps

[`ReleaseSteps`](#releasesteps)

#### Returns

`object`

##### release()

> **release**: (`policy?`) => `Promise`\<[`ReleaseReport`](#releasereport)\>

###### Parameters

###### policy?

###### onFailure

`"release"` \| `"keep"` = `...`

###### onSuccess

`"release"` \| `"keep"` = `...`

###### Returns

`Promise`\<[`ReleaseReport`](#releasereport)\>

***

### release()

> **release**(`steps`, `policy?`): `Promise`\<[`ReleaseReport`](#releasereport)\>

Release as the last successful action. Never call in finally or catch: waits throw too.

#### Parameters

##### steps

[`ReleaseSteps`](#releasesteps)

##### policy?

###### onFailure

`"release"` \| `"keep"` = `...`

###### onSuccess

`"release"` \| `"keep"` = `...`

#### Returns

`Promise`\<[`ReleaseReport`](#releasereport)\>

***

### unreachable()

> **unreachable**(`value`): `never`

#### Parameters

##### value

`never`

#### Returns

`never`
