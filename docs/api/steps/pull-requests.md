# @jigs-ai/jigs v0.68.1

Read and update GitHub pull requests outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Type Aliases

### MergeOutcome

> **MergeOutcome** = \{ `mergeCommitSha`: `string` \| `null`; `merged`: `true`; \} \| `object` & `MergeRefusal`

What GitHub did, and when it did not, why — and whether asking again could
change the answer, which is what decides between standing the commit down
and leaving it merge-ready.

#### Type Declaration

\{ `mergeCommitSha`: `string` \| `null`; `merged`: `true`; \}

##### mergeCommitSha

> **mergeCommitSha**: `string` \| `null`

The merge commit, or `null` when GitHub has not reported it yet.

##### merged

> **merged**: `true`

Confirms that GitHub reports the pull request merged.

`object` & `MergeRefusal`

***

### OpenedPullRequest

> **OpenedPullRequest** = `PullRequestRef` & `object`

A newly opened or adopted pull request and its browser URL.

#### Type Declaration

##### url

> **url**: `string`

The pull request's browser URL.

## Variables

### fetchPullRequestState

> `const` **fetchPullRequestState**: `FetchPrState`

Read the pull request’s checks, reviews, open review threads and approval.

## Functions

### commentOnPullRequest()

> **commentOnPullRequest**(`pr`, `body`): `Promise`\<\{ `id`: `number`; \}\>

Post a comment on the pull request conversation and return its id.

#### Parameters

##### pr

`PullRequestRef`

##### body

`string`

#### Returns

`Promise`\<\{ `id`: `number`; \}\>

***

### markPullRequestReady()

> **markPullRequestReady**(`pr`): `Promise`\<`PullRequestSnapshot`\>

Mark a draft pull request ready and return its freshly read state.

#### Parameters

##### pr

`PullRequestRef`

#### Returns

`Promise`\<`PullRequestSnapshot`\>

***

### mergePullRequest()

> **mergePullRequest**(`worktree`, `pr`, `expectedHeadSha`): `Promise`\<[`MergeOutcome`](#mergeoutcome)\>

Merge the pull request with the worktree binding's `mergeMethod`, pinned to the head the
caller judged ready.

The title is re-read here rather than carried in from `describePullRequest`:
a reviewer who corrects it — to satisfy a conventional-commit check on the
target repo, usually — does so between the pull request opening and this
merge, and a title captured at open time would ship the one they corrected
away. After any ambiguous answer the pull request is read again, and this
reports `merged` only if GitHub says so.

#### Parameters

##### worktree

`Worktree`

##### pr

`PullRequestRef`

##### expectedHeadSha

`string`

#### Returns

`Promise`\<[`MergeOutcome`](#mergeoutcome)\>

***

### openPullRequest()

> **openPullRequest**(`request`): `Promise`\<[`OpenedPullRequest`](#openedpullrequest)\>

Open a pull request from the worktree's branch into its repository's default branch.

The lookup comes first because this is one step: a create that succeeded
before the assignment failed, or whose response was lost, leaves a pull
request GitHub will refuse to open twice. The retry adopts that pull request
and re-attempts only what did not finish.

#### Parameters

##### request

###### body

`string`

###### draft?

`boolean`

###### title

`string`

###### worktree

`Worktree`

#### Returns

`Promise`\<[`OpenedPullRequest`](#openedpullrequest)\>

***

### replyToPullRequestReviewThread()

> **replyToPullRequestReviewThread**(`pr`, `rootId`, `body`): `Promise`\<\{ `id`: `number`; \}\>

Reply to a review thread and return the posted comment id.

#### Parameters

##### pr

`PullRequestRef`

##### rootId

`number`

##### body

`string`

#### Returns

`Promise`\<\{ `id`: `number`; \}\>

***

### reviewPullRequest()

> **reviewPullRequest**(`pr`, `review`): `Promise`\<\{ `id`: `number`; \}\>

Post a pull request review and return its id. GitHub refuses an approval from
the pull request's own author with 422 Unprocessable Entity; Jigs lets
GitHub's GithubApiError surface unchanged.

#### Parameters

##### pr

`PullRequestRef`

##### review

`PullRequestReviewRequest`

#### Returns

`Promise`\<\{ `id`: `number`; \}\>
