# @jigs-ai/jigs v0.59.0

Provision a repository worktree outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Interfaces

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

***

### WorktreeRequest

The binding and branch used to provision a run's worktree.

#### Properties

##### binding

> **binding**: `string`

##### branch

> **branch**: `string`

## Functions

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
