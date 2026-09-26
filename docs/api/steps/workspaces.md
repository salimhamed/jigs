# @jigs-ai/jigs v0.77.0

Prepare a run-owned worktree for a configured GitHub binding.

`provisionWorktree` cuts the run's own branch and working copy from the
binding's clone. Call its generated `#jigs/steps` wrapper from workflow code so a resumed
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

The branch name to start from; the run's own branch adds a suffix from its run ID.

***

### provisionWorktree()

> **provisionWorktree**(`request`, `metadata`): `Promise`\<`Worktree`\>

Create this run's own branch and worktree from the default branch, and prepare its files and
dependencies.

#### Parameters

##### request

[`WorktreeRequest`](#worktreerequest)

##### metadata

`RunMetadata`

#### Returns

`Promise`\<`Worktree`\>

#### Remarks

Every run gets a new branch, so a run never picks up another run's work. The returned
`branch` is the one to push and open a pull request from.
