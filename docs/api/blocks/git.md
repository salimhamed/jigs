# @salimhamed/jigs v0.40.1

Read and render bounded descriptions of changes in a Git worktree.

## Interfaces

### ChangePatch

#### Properties

##### patches

> **patches**: `object`[]

###### path

> **path**: `string`

###### text

> **text**: `string`

##### truncated

> **truncated**: `boolean`

***

### ChangeSummary

#### Properties

##### base

> **base**: `string`

Resolved endpoint commits. Files describe the direct difference between their trees.

##### commits

> **commits**: `object`[]

Commits reachable from head but not base, newest first; authorName is Git's raw author name.

###### authorName

> **authorName**: `string`

###### sha

> **sha**: `string`

###### subject

> **subject**: `string`

##### files

> **files**: [`FileChange`](#filechange)[]

##### head

> **head**: `string`

##### truncated

> **truncated**: `boolean`

***

### FileChange

#### Properties

##### additions

> **additions**: `number`

##### deletions

> **deletions**: `number`

##### path

> **path**: `string`

##### status

> **status**: [`ChangeStatus`](#changestatus)

## Type Aliases

### ChangeStatus

> **ChangeStatus** = `"added"` \| `"modified"` \| `"deleted"` \| `"renamed"` \| `"other"`

## Functions

### parseNameStatus()

> **parseNameStatus**(`output`): `Pick`\<[`FileChange`](#filechange), `"status"` \| `"path"`\>[]

Parse git diff --name-status -z; NUL separators preserve unusual filenames.

#### Parameters

##### output

`string`

#### Returns

`Pick`\<[`FileChange`](#filechange), `"status"` \| `"path"`\>[]

***

### parseNumstat()

> **parseNumstat**(`output`): `Pick`\<[`FileChange`](#filechange), `"path"` \| `"additions"` \| `"deletions"`\>[]

Parse git diff --numstat -z. Binary '-' counts contribute zero lines.

#### Parameters

##### output

`string`

#### Returns

`Pick`\<[`FileChange`](#filechange), `"path"` \| `"additions"` \| `"deletions"`\>[]

***

### renderChangeSummary()

> **renderChangeSummary**(`summary`): `string`

#### Parameters

##### summary

[`ChangeSummary`](#changesummary)

#### Returns

`string`
