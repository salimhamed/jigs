# @salimhamed/jigs v0.47.0

Describe run-owned resources, inspect cleanup progress and request release from a workflow.

## Interfaces

### CleanupProgress

Persisted progress for automatic or explicitly requested release of a run's resources.

#### Extended by

- [`CleanupView`](#cleanupview)

#### Properties

##### action?

> `optional` **action**: `CleanupAction`

Whether the resolved policy chose to keep or release resources.

##### detail?

> `optional` **detail**: `string`

A diagnostic message when the release attempt itself failed.

##### failed?

> `optional` **failed**: `number`

The number of managed resources whose release did not complete.

##### kept?

> `optional` **kept**: `number`

The number of managed resources preserved by policy or a safety check.

##### outcome?

> `optional` **outcome**: `CleanupOutcome`

Whether the run completed successfully or ended by failure or cancellation.

##### released?

> `optional` **released**: `number`

The number of managed resources that were removed.

##### status

> **status**: `CleanupStatus`

The current phase or final result of resource release.

##### unknown?

> `optional` **unknown**: `number`

The number of registered resources whose kinds jigs does not release.

***

### CleanupView

Resource-release progress together with the source of the chosen action.

#### Extends

- [`CleanupProgress`](#cleanupprogress)

#### Properties

##### action?

> `optional` **action**: `CleanupAction`

Whether the resolved policy chose to keep or release resources.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`action`](#action)

##### detail?

> `optional` **detail**: `string`

A diagnostic message when the release attempt itself failed.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`detail`](#detail)

##### directive

> **directive**: `CleanupAction` \| `"automatic"`

An explicit action recorded by a workflow, or `automatic` when policy still decides.

##### failed?

> `optional` **failed**: `number`

The number of managed resources whose release did not complete.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`failed`](#failed)

##### kept?

> `optional` **kept**: `number`

The number of managed resources preserved by policy or a safety check.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`kept`](#kept)

##### outcome?

> `optional` **outcome**: `CleanupOutcome`

Whether the run completed successfully or ended by failure or cancellation.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`outcome`](#outcome)

##### released?

> `optional` **released**: `number`

The number of managed resources that were removed.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`released`](#released)

##### status

> **status**: `CleanupStatus`

The current phase or final result of resource release.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`status`](#status)

##### unknown?

> `optional` **unknown**: `number`

The number of registered resources whose kinds jigs does not release.

###### Inherited from

[`CleanupProgress`](#cleanupprogress).[`unknown`](#unknown)

***

### ReleaseReport

The result of applying a release policy to one run's managed resources.

#### Properties

##### policy

> **policy**: `object`

The policy applied by this release attempt.

###### onFailure

> **onFailure**: `"release"` \| `"keep"`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

> **onSuccess**: `"release"` \| `"keep"`

What to do with eligible resources after a completed run.

##### runDirectory

> **runDirectory**: `ReleasedResource`

The scratch directory's local path, removal flag and reason for the result.

##### worktrees

> **worktrees**: `ReleasedResource` & `object`[]

Results for the run's worktrees, including paths, branches, removal flags, unmerged commit
counts and reasons for anything retained.

***

### ReleaseSteps

Durable step functions required by the workflow-side release block.

#### Properties

##### releaseRunResources()

> **releaseRunResources**: (`policy`) => `Promise`\<[`ReleaseReport`](#releasereport)\>

Persist and apply the selected successful-run policy to the active run.

###### Parameters

###### policy

###### onFailure

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a completed run.

###### Returns

`Promise`\<[`ReleaseReport`](#releasereport)\>

##### resolveReleasePolicy()

> **resolveReleasePolicy**: () => `Promise`\<\{ `onFailure`: `"release"` \| `"keep"`; `onSuccess`: `"release"` \| `"keep"`; \}\>

Resolve the workflow, factory or default release policy for the active run.

###### Returns

`Promise`\<\{ `onFailure`: `"release"` \| `"keep"`; `onSuccess`: `"release"` \| `"keep"`; \}\>

***

### RunResource

A durable thing that a run created or otherwise owns a reference to.

#### Properties

##### identity

> **identity**: `string`

The stable name that distinguishes this resource from others of the same kind.

##### kind

> **kind**: `string`

The resource category, such as `worktree` or `run-directory`.

##### url

> **url**: `string`

An absolute URL where a human can inspect the resource.

## Type Aliases

### ReleasePolicy

> **ReleasePolicy** = `z.input`\<*typeof* `releaseSchema`\>

Selects whether eligible run resources are released for each terminal outcome.

## Functions

### bindReleaseSteps()

> **bindReleaseSteps**(`steps`): `object`

Bind durable release steps into the workflow-facing release API.

#### Parameters

##### steps

[`ReleaseSteps`](#releasesteps)

#### Returns

##### release()

> **release**: (`policy?`) => `Promise`\<[`ReleaseReport`](#releasereport)\>

Release resources with an explicit policy, or resolve the run's configured policy.

###### Parameters

###### policy?

###### onFailure

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a completed run.

###### Returns

`Promise`\<[`ReleaseReport`](#releasereport)\>

***

### release()

> **release**(`steps`, `policy?`): `Promise`\<[`ReleaseReport`](#releasereport)\>

Release eligible resources as the workflow's last successful action.

#### Parameters

##### steps

[`ReleaseSteps`](#releasesteps)

##### policy?

###### onFailure

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a completed run.

#### Returns

`Promise`\<[`ReleaseReport`](#releasereport)\>

#### Remarks

Without an argument, resolves the workflow policy, then the factory policy, then the default of
releasing successful runs and keeping failed runs. An explicit choice remains authoritative for
later automatic cleanup. Never call this from `finally` or `catch`, because waits also throw.

***

### unreachable()

> **unreachable**(`value`): `never`

Fail an exhaustive branch if an unexpected value reaches it at runtime.

#### Parameters

##### value

`never`

#### Returns

`never`
