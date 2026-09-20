# @salimhamed/jigs v0.40.1

Read, commit and push changes in a Git worktree.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Functions

### pushApprovedChange()

> **pushApprovedChange**(`worktreePath`, `branch`, `approvedCommit`): `Promise`\<\{ `headSha`: `string`; \}\>

Recheck approval on every attempt and push only the reviewed commit.

#### Parameters

##### worktreePath

`string`

##### branch

`string`

##### approvedCommit

`string`

#### Returns

`Promise`\<\{ `headSha`: `string`; \}\>

***

### pushBranch()

> **pushBranch**(`worktreePath`, `branch`): `Promise`\<\{ `headSha`: `string`; \}\>

Push the worktree branch to its remote.

#### Parameters

##### worktreePath

`string`

##### branch

`string`

#### Returns

`Promise`\<\{ `headSha`: `string`; \}\>

***

### readBranchState()

> **readBranchState**(`worktreePath`, `baseSha`): `Promise`\<\{ `commits`: `number`; `dirty`: `boolean`; `headSha`: `string`; \}\>

Check for new commits and uncommitted changes before pushing a branch.

#### Parameters

##### worktreePath

`string`

##### baseSha

`string`

#### Returns

`Promise`\<\{ `commits`: `number`; `dirty`: `boolean`; `headSha`: `string`; \}\>

***

### readChange()

> **readChange**(`worktreePath`, `base`): `Promise`\<`ChangeSummary`\>

Read the direct base-to-head tree difference and commits unique to head.

#### Parameters

##### worktreePath

`string`

##### base

`string`

#### Returns

`Promise`\<`ChangeSummary`\>

***

### readPatch()

> **readPatch**(`worktreePath`, `base`, `head`, `paths`): `Promise`\<`ChangePatch`\>

Read literal named paths between two commits, with a shared text budget.

#### Parameters

##### worktreePath

`string`

##### base

`string`

##### head

`string`

##### paths

`string`[]

#### Returns

`Promise`\<`ChangePatch`\>

***

### readWorktreeDiff()

> **readWorktreeDiff**(`worktreePath`, `baseSha`): `Promise`\<`string`\>

Read committed changes since the base commit. Large diffs are truncated.

#### Parameters

##### worktreePath

`string`

##### baseSha

`string`

#### Returns

`Promise`\<`string`\>
