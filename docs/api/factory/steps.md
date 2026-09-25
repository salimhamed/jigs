# @jigs-ai/jigs v0.69.1

Durable steps generated into your factory. Call them from workflow code.
Each wrapper carries its own "use step" directive and stable factory identity.

## Linear and human input

### checkForTicketHumanReply()

> **checkForTicketHumanReply**(`issueId`, `sinceIso`, `postedCommentIds`): `Promise`\<\{ `cursor`: `string`; `reply`: `HumanReply` \| `null`; \}\>

Look for a human reply since the last check, excluding every comment the run posted.

#### Parameters

##### issueId

`string`

##### sinceIso

`string`

##### postedCommentIds

readonly `string`[]

#### Returns

`Promise`\<\{ `cursor`: `string`; `reply`: `HumanReply` \| `null`; \}\>

***

### fetchTicketSnapshot()

> **fetchTicketSnapshot**(`issueId`): `Promise`\<`TicketSnapshot`\>

Read the ticket's current details, comments, and related issues from Linear.

#### Parameters

##### issueId

`string`

#### Returns

`Promise`\<`TicketSnapshot`\>

***

### postTicketHumanInputRequest()

> **postTicketHumanInputRequest**(`issueId`, `halt`): `Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

Post a request for human input on the ticket. Use haltForHuman() to also wait for a reply.

#### Parameters

##### issueId

`string`

##### halt

`Halt`

#### Returns

`Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

***

### postTicketNote()

> **postTicketNote**(`issueId`, `note`): `Promise`\<\{ `commentId`: `string`; \}\>

Post a note on the ticket that asks for nothing and waits for nothing.

#### Parameters

##### issueId

`string`

##### note

`TicketNote`

#### Returns

`Promise`\<\{ `commentId`: `string`; \}\>

***

### resolveLinearIssue()

> **resolveLinearIssue**(`reference`): `Promise`\<`LinearIssueRef`\>

Resolve a Linear ticket identifier or issue ID before claiming it.

#### Parameters

##### reference

`string`

#### Returns

`Promise`\<`LinearIssueRef`\>

***

### setTicketStatus()

> **setTicketStatus**(`issueId`, `stateName`): `Promise`\<`TicketStatusResult`\>

Move a ticket to a named state when this workflow's policy says to.

#### Parameters

##### issueId

`string`

##### stateName

`string`

#### Returns

`Promise`\<`TicketStatusResult`\>

## Pull requests

### commentOnPullRequest()

> **commentOnPullRequest**(`pullRequest`, `body`): `Promise`\<\{ `id`: `number`; \}\>

Add a comment to the pull request's main conversation.

#### Parameters

##### pullRequest

`PullRequestRef`

##### body

`string`

#### Returns

`Promise`\<\{ `id`: `number`; \}\>

***

### fetchPullRequestState()

> **fetchPullRequestState**(`pullRequest`): `Promise`\<`PullRequestSnapshot`\>

Read a pull request's reviews, comments, CI results, approval, and merge state.

#### Parameters

##### pullRequest

`PullRequestRef`

#### Returns

`Promise`\<`PullRequestSnapshot`\>

***

### markPullRequestReady()

> **markPullRequestReady**(`pullRequest`): `Promise`\<`PullRequestSnapshot`\>

Mark a draft pull request ready for review and return its current state.

#### Parameters

##### pullRequest

`PullRequestRef`

#### Returns

`Promise`\<`PullRequestSnapshot`\>

***

### mergePullRequest()

> **mergePullRequest**(`worktree`, `pullRequest`, `expectedHeadSha`): `Promise`\<`MergeOutcome`\>

Merge the pull request with its binding's merge method, pinned to the approved head.

#### Parameters

##### worktree

`Worktree`

##### pullRequest

`PullRequestRef`

##### expectedHeadSha

`string`

#### Returns

`Promise`\<`MergeOutcome`\>

***

### openPullRequest()

> **openPullRequest**(`request`): `Promise`\<`OpenedPullRequest`\>

Open a pull request for a branch that has already been pushed.

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

`Promise`\<`OpenedPullRequest`\>

***

### replyToPullRequestReviewThread()

> **replyToPullRequestReviewThread**(`pullRequest`, `rootCommentId`, `body`): `Promise`\<\{ `id`: `number`; \}\>

Reply to an existing code-review thread on a pull request.

#### Parameters

##### pullRequest

`PullRequestRef`

##### rootCommentId

`number`

##### body

`string`

#### Returns

`Promise`\<\{ `id`: `number`; \}\>

***

### reviewPullRequest()

> **reviewPullRequest**(`pullRequest`, `review`): `Promise`\<\{ `id`: `number`; \}\>

Post a review on a pull request.

#### Parameters

##### pullRequest

`PullRequestRef`

##### review

###### body

`string`

###### comments?

`object`[]

###### event

`"comment"` \| `"approve"` \| `"request-changes"`

#### Returns

`Promise`\<\{ `id`: `number`; \}\>

## Git changes

### pushApprovedChange()

> **pushApprovedChange**(`worktree`, `approvedCommit`): `Promise`\<\{ `headSha`: `string`; \}\>

Recheck approval and push only the reviewed commit, including on retries.

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

Push the worktree's branch to its remote, including any newly committed changes.

#### Parameters

##### worktree

`Worktree`

#### Returns

`Promise`\<\{ `headSha`: `string`; \}\>

***

### readBranchState()

> **readBranchState**(`worktree`, `baseSha?`): `Promise`\<\{ `commits`: `number`; `dirty`: `boolean`; `headSha`: `string`; \}\>

Check commits since the base, the branch's current commit, and uncommitted changes.

#### Parameters

##### worktree

`Worktree`

##### baseSha?

`string`

#### Returns

`Promise`\<\{ `commits`: `number`; `dirty`: `boolean`; `headSha`: `string`; \}\>

***

### readChange()

> **readChange**(`worktree`, `base?`): `Promise`\<`ChangeSummary`\>

Read committed file changes and subjects up to HEAD, defaulting to the worktree's base.

#### Parameters

##### worktree

`Worktree`

##### base?

`string`

#### Returns

`Promise`\<`ChangeSummary`\>

***

### readPatch()

> **readPatch**(`worktree`, `base`, `head`, `paths`): `Promise`\<`ChangePatch`\>

Read capped patches for literal named paths between the summary's commits.

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

***

### readWorktreeDiff()

> **readWorktreeDiff**(`worktree`, `baseSha?`): `Promise`\<`string`\>

Read committed changes, defaulting to the worktree's base commit. Large diffs are truncated.

#### Parameters

##### worktree

`Worktree`

##### baseSha?

`string`

#### Returns

`Promise`\<`string`\>

## Agent execution

### executeAgent()

> **executeAgent**(`request`): `Promise`\<`AgentResult` \| \{ `jitFailure`: `object` & `object`[]; \} \| \{ `resumeFailed`: `string`; \}\>

Execute an agent in a working directory. Use runAgent() to pass an output schema and parse its answer.

#### Parameters

##### request

`AgentRequest`

#### Returns

`Promise`\<`AgentResult` \| \{ `jitFailure`: `object` & `object`[]; \} \| \{ `resumeFailed`: `string`; \}\>

***

### executeJev()

> **executeJev**\<`QUESTIONS`\>(`request`): `Promise`\<`JevResult`\<`QUESTIONS`\>\>

Execute typed decision questions against one shared state.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* `JevQuestions`

#### Parameters

##### request

`AskJevOptions`\<`QUESTIONS`\>

#### Returns

`Promise`\<`JevResult`\<`QUESTIONS`\>\>

***

### executeModel()

> **executeModel**(`request`): `Promise`\<`ModelResult`\>

Execute a model request without tools. Use askModel() to pass an output schema and parse its answer.

#### Parameters

##### request

`ModelRequest`

#### Returns

`Promise`\<`ModelResult`\>

## Workspaces and resources

### createRunDirectory()

> **createRunDirectory**(): `Promise`\<`string`\>

Prepare this run's scratch directory, preserving it when the run resumes.

#### Returns

`Promise`\<`string`\>

***

### provisionWorktree()

> **provisionWorktree**(`request`): `Promise`\<`Worktree`\>

Prepare a worktree for this run, reusing it when the run resumes.

#### Parameters

##### request

`WorktreeRequest`

#### Returns

`Promise`\<`Worktree`\>

***

### registerResource()

> **registerResource**(`resource`): `Promise`\<`RunResource`\>

Record a resource on this run independently of the workflow's return value.

#### Parameters

##### resource

`RunResource`

#### Returns

`Promise`\<`RunResource`\>

#### Remarks

Register anything a person may need to find in `jigs status`. Kind and identity
together name the record; registering again updates its URL. Create external
resources in a separate step when creation is not safe to repeat, then register
them here so registration retries cannot repeat creation. A record alone never
permits deletion.

***

### release()

> **release**(`policy?`): `Promise`\<`ReleaseReport`\>

Release this run's resources now and return the report. The service already does this when
the run ends; call it to release early, to read the report, or to pass this run's policy.

#### Parameters

##### policy?

###### onFailure

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

`"release"` \| `"keep"` = `...`

What to do with eligible resources after a completed run.

#### Returns

`Promise`\<`ReleaseReport`\>

***

### removeRunDirectory()

> **removeRunDirectory**(): `Promise`\<`void`\>

Remove this run's scratch directory after its work is complete.

#### Returns

`Promise`\<`void`\>
