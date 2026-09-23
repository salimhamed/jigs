# @jigs-ai/jigs v0.52.2

Inspect committed changes and push branches in a Git worktree.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Functions

### pushApprovedChange()

> **pushApprovedChange**(`worktreePath`, `branch`, `approvedCommit`): `Promise`\<\{ `headSha`: `string`; \}\>

Push a reviewed commit only while it is still HEAD and the worktree is clean.

Safe to retry after a successful push. Rejects if HEAD moved or any uncommitted change exists.

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

Push the worktree's current HEAD and register a GitHub branch resource when applicable.

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

Inspect the worktree state used to decide whether a branch is ready to push.

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

Describe committed changes between a base ref and the worktree's current HEAD.

#### Parameters

##### worktreePath

`string`

##### base

`string`

#### Returns

`Promise`\<`ChangeSummary`\>

#### Remarks

Resolves both endpoints once, compares their trees directly and lists commits reachable only
from HEAD. Returns at most 1,000 files and 1,000 commits; `truncated` reports omitted results.

***

### readPatch()

> **readPatch**(`worktreePath`, `base`, `head`, `paths`): `Promise`\<`ChangePatch`\>

Read patches for selected literal paths between two commits.

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

#### Remarks

Pass the resolved `base` and `head` from `readChange` to inspect that exact change. Paths are
deduplicated, empty paths are rejected and all returned patches share a 200,000-character limit.

***

### readWorktreeDiff()

> **readWorktreeDiff**(`worktreePath`, `baseSha`): `Promise`\<`string`\>

Read a raw patch from the merge base of `baseSha` and HEAD, truncating after 200,000 characters.

#### Parameters

##### worktreePath

`string`

##### baseSha

`string`

#### Returns

`Promise`\<`string`\>
