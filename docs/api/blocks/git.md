# @salimhamed/jigs v0.41.3

Describe and render committed Git changes for review.

## Interfaces

### ChangePatch

Patches for selected paths between two resolved commits.

#### Properties

##### patches

> **patches**: `object`[]

Patch text for each selected path, in first-requested order.

###### path

> **path**: `string`

The literal path that was selected.

###### text

> **text**: `string`

The Git patch for this path, which may be empty or truncated.

##### truncated

> **truncated**: `boolean`

Whether the shared text limit cut off any patch text.

***

### ChangeSummary

A bounded description of the committed changes between two Git refs.

#### Properties

##### base

> **base**: `string`

The resolved base commit.

##### commits

> **commits**: `object`[]

Commits reachable from head but not base, newest first.

###### authorName

> **authorName**: `string`

The author name recorded by Git, without mailmap rewriting.

###### sha

> **sha**: `string`

The full commit SHA.

###### subject

> **subject**: `string`

The first line of the commit message.

##### files

> **files**: [`FileChange`](#filechange)[]

Files that differ directly between the base and head trees.

##### head

> **head**: `string`

The resolved head commit.

##### truncated

> **truncated**: `boolean`

Whether file or commit limits caused results to be omitted.

***

### FileChange

One file changed between the base and head trees.

#### Properties

##### additions

> **additions**: `number`

The number of added lines, or zero for a binary file.

##### deletions

> **deletions**: `number`

The number of deleted lines, or zero for a binary file.

##### path

> **path**: `string`

The changed path. Renames use the path in the head tree.

##### status

> **status**: [`ChangeStatus`](#changestatus)

How the path differs between the two trees.

## Type Aliases

### ChangeStatus

> **ChangeStatus** = `"added"` \| `"modified"` \| `"deleted"` \| `"renamed"` \| `"other"`

How a file differs between the base and head trees.

## Functions

### parseNameStatus()

> **parseNameStatus**(`output`): `Pick`\<[`FileChange`](#filechange), `"status"` \| `"path"`\>[]

Parse NUL-delimited Git name-status output without losing unusual filenames.

#### Parameters

##### output

`string`

#### Returns

`Pick`\<[`FileChange`](#filechange), `"status"` \| `"path"`\>[]

***

### parseNumstat()

> **parseNumstat**(`output`): `Pick`\<[`FileChange`](#filechange), `"path"` \| `"additions"` \| `"deletions"`\>[]

Parse NUL-delimited Git line counts, treating binary-file counts as zero.

#### Parameters

##### output

`string`

#### Returns

`Pick`\<[`FileChange`](#filechange), `"path"` \| `"additions"` \| `"deletions"`\>[]

***

### renderChangeSummary()

> **renderChangeSummary**(`summary`): `string`

Render a Markdown review summary with commits, totals and up to 60 changed-file rows.

#### Parameters

##### summary

[`ChangeSummary`](#changesummary)

#### Returns

`string`
