# @jigs-ai/jigs v0.68.1

Inspect committed changes and push branches in a Git worktree.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Functions

### branchContains()

> **branchContains**(`worktree`, `sha`): `Promise`\<`boolean`\>

Whether `sha` is the worktree's HEAD or one of its ancestors. A commit the worktree has never
fetched is not contained.

#### Parameters

##### worktree

`Worktree`

##### sha

`string`

#### Returns

`Promise`\<`boolean`\>

***

### pushApprovedChange()

> **pushApprovedChange**(`worktree`, `approvedCommit`): `Promise`\<\{ `headSha`: `string`; \}\>

Push a reviewed commit only while it is still HEAD and the worktree is clean.

Safe to retry after a successful push. Rejects if HEAD moved or any uncommitted change exists.

#### Parameters

##### worktree

`Worktree`

##### approvedCommit

`string`

#### Returns

`Promise`\<\{ `headSha`: `string`; \}\>

***

### pushBranch()

> **pushBranch**(`worktree`): `Promise`\<\{ `headSha`: `string`; \}\>

Push the worktree's current HEAD and register a GitHub branch resource when applicable.

#### Parameters

##### worktree

`Worktree`

#### Returns

`Promise`\<\{ `headSha`: `string`; \}\>

***

### readBranchState()

> **readBranchState**(`worktree`, `baseSha`): `Promise`\<`BranchState`\>

Inspect branch readiness, counting commits since the worktree's base unless overridden.

#### Parameters

##### worktree

`Worktree`

##### baseSha

`string` = `worktree.baseSha`

#### Returns

`Promise`\<`BranchState`\>

***

### readChange()

> **readChange**(`worktree`, `base`): `Promise`\<`ChangeSummary`\>

Describe committed changes from the worktree's base to HEAD, or supply another base ref.

#### Parameters

##### worktree

`Worktree`

##### base

`string` = `worktree.baseSha`

#### Returns

`Promise`\<`ChangeSummary`\>

#### Remarks

Resolves both endpoints once, compares their trees directly and lists commits reachable only
from HEAD. Returns at most 1,000 files and 1,000 commits; `truncated` reports omitted results.

***

### readPatch()

> **readPatch**(`worktree`, `base`, `head`, `paths`): `Promise`\<`ChangePatch`\>

Read patches for selected literal paths between two commits.

#### Parameters

##### worktree

`Worktree`

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

> **readWorktreeDiff**(`worktree`, `baseSha`): `Promise`\<`string`\>

Read a raw patch from the merge base of `baseSha` and HEAD, truncating after 200,000 characters.
Defaults to the worktree's base commit.

#### Parameters

##### worktree

`Worktree`

##### baseSha

`string` = `worktree.baseSha`

#### Returns

`Promise`\<`string`\>
