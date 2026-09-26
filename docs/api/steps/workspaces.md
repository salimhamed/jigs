# @jigs-ai/jigs v0.70.0

Prepare a run-owned worktree for a configured GitHub binding.

`provisionWorktree` creates or reuses the run's working copy from the binding's
clone. Call its generated `#jigs/steps` wrapper from workflow code so a resumed
workflow receives the recorded workspace information. The low-level function
here belongs inside a factory-owned `"use step"` implementation.

## Worktrees

### WorktreeRequest

The binding and branch used to provision a run's worktree.

#### Properties

##### binding

> **binding**: `string`

##### branch

> **branch**: `string`

***

### provisionWorktree()

> **provisionWorktree**(`request`, `metadata`, `deps`): `Promise`\<`Worktree`\>

Create or reuse a worktree for this run and prepare its files and dependencies.

#### Parameters

##### request

[`WorktreeRequest`](#worktreerequest)

##### metadata

`RunMetadata`

##### deps

[`ProvisionWorktreeDependencies`](#provisionworktreedependencies) = `{}`

#### Returns

`Promise`\<`Worktree`\>

## Advanced implementation/testing

### ProvisionWorktreeDependencies

Injectable registry and ownership operations used while provisioning a worktree.

#### Properties

##### readOwner()?

> `optional` **readOwner**: (`runId`) => `Promise`\<`OwnerState`\>

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<`OwnerState`\>

##### sql?

> `optional` **sql**: `RegistrySql`

##### withLock()?

> `optional` **withLock**: \<`T`\>(`runId`, `action`) => `Promise`\<`T`\>

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
