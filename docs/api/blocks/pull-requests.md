# @salimhamed/jigs v0.40.1

Compose pull request creation, review, approval and merge gates inside a workflow.

## Interfaces

### MarkerLedger

What a scope has already done on this pull request, read off the comments.

#### Properties

##### answered

> **answered**: `ReadonlySet`\<`string`\>

Sources this scope answered or completed: a comment version, or a commit.

##### settled

> **settled**: `Readonly`\<`Record`\<[`StatusReason`](#statusreason), `ReadonlySet`\<`string`\>\>\>

Commits this scope wrote a status note about, kept apart by why.

***

### MergeRefusal

Why a merge did not happen, and whether a later wake could change it.

#### Properties

##### reason

> **reason**: `string`

##### transient

> **transient**: `boolean`

Whether the same head could still merge. A transient refusal is a state
jigs is waiting out — a check still running, a merge state GitHub has not
finished computing, an approval waiting to be granted again — so the
commit stays merge-ready and the next wake asks again. A terminal one is
the pull request as it stands refusing the merge, so the commit is stood
down until a new commit or a change to the repository moves it.

***

### PostPullRequestNoteOptions

#### Properties

##### body

> **body**: `string`

##### commentOnPullRequest()

> **commentOnPullRequest**: (`pr`, `body`) => `Promise`\<\{ `id`: `number`; \}\>

Post a comment on the pull request conversation and return its id.

###### Parameters

###### pr

[`PullRequestRef`](#pullrequestref)

###### body

`string`

###### Returns

`Promise`\<\{ `id`: `number`; \}\>

##### headSha

> **headSha**: `string`

The commit the note is about: a red head, or a head it could not merge.

##### pr

> **pr**: [`PullRequestRef`](#pullrequestref)

##### reason

> **reason**: [`StatusReason`](#statusreason)

What the note says about that commit, so one note never silences another.
`merge` and `ci` stand it down; `merge-retry` only records that jigs
already reported a refusal it is waiting out.

##### scope

> **scope**: `string`

***

### PostReviewAnswersOptions

#### Properties

##### answers

> **answers**: [`ThreadAnswers`](#threadanswers)

##### commentOnPullRequest()

> **commentOnPullRequest**: (`pr`, `body`) => `Promise`\<\{ `id`: `number`; \}\>

Post a comment on the pull request conversation and return its id.

###### Parameters

###### pr

[`PullRequestRef`](#pullrequestref)

###### body

`string`

###### Returns

`Promise`\<\{ `id`: `number`; \}\>

##### committedSha?

> `optional` **committedSha**: `string`

The commit the round pushed, when it pushed one; the explanation names it.

##### pr

> **pr**: [`PullRequestRef`](#pullrequestref)

##### replyToPullRequestReviewThread()

> **replyToPullRequestReviewThread**: (`pr`, `rootId`, `body`) => `Promise`\<\{ `id`: `number`; \}\>

Reply to a review thread and return the posted comment id.

###### Parameters

###### pr

[`PullRequestRef`](#pullrequestref)

###### rootId

`number`

###### body

`string`

###### Returns

`Promise`\<\{ `id`: `number`; \}\>

##### scope

> **scope**: `string`

The continuation identity these answers belong to.

##### threads

> **threads**: `ReviewThread`[]

***

### PullRequestMarker

#### Properties

##### kind

> **kind**: [`MarkerKind`](#markerkind)

`reply` answers the thing named by `source`, `completion` records work
finished for it, and `status` is a note about a commit — a stand-down
after a refused merge, a CI failure jigs could not repair, or a merge
refused for a state that will pass.

##### reason?

> `optional` **reason**: [`StatusReason`](#statusreason)

Required on a `status` marker, meaningless on any other.

##### run

> **run**: `string`

The run that wrote it. Provenance for a reader; never matched on.

##### scope

> **scope**: `string`

The continuation identity. It survives run replacement, so a later run
answering for the same scope sees this work as its own and does not redo
it. Another scope's marker means "some jigs workflow wrote this", never
"my work is done".

##### source?

> `optional` **source**: `string`

What this answers: a comment as `id@updatedAt`, or a commit sha.

***

### PullRequestState

#### Properties

##### done

> **done**: `boolean`

##### ownComments

> **ownComments**: `number`

Comments on the pull request that any jigs workflow wrote.

##### wakes

> **wakes**: [`PullRequestWake`](#pullrequestwake)[]

***

### ThreadAnswers

Answers routed back to pull-request threads and an optional commit explanation.

#### Properties

##### answers

> **answers**: `object`[]

###### body

> **body**: `string`

###### threadId

> **threadId**: `number` \| `null`

##### commitExplanation

> **commitExplanation**: `string` \| `null`

## Type Aliases

### ApprovalSignal

> **ApprovalSignal** = `z.output`\<*typeof* [`approvalSignalSchema`](#approvalsignalschema)\>

***

### ApprovalState

> **ApprovalState** = `"approved"` \| `"changes-requested"` \| `"stale"` \| `"none"`

How the operator's consent reads right now. `stale` is an approval that
named an earlier commit — a different thing to tell an operator than a pull
request nobody has approved.

***

### Attend

> **Attend**\<`T`\> = \{ `listen`: `true`; \} \| \{ `finished`: `T`; \}

#### Type Parameters

##### T

`T`

***

### MarkerKind

> **MarkerKind** = `"reply"` \| `"completion"` \| `"status"`

***

### MergePolicy

> **MergePolicy** = `z.output`\<*typeof* [`mergePolicySchema`](#mergepolicyschema)\>

***

### PullRequestGateFn()

> **PullRequestGateFn** = (`pr`, `scope`, `approval`) => `AsyncGenerator`\<[`PullRequestWake`](#pullrequestwake), `void`, `undefined`\>

[pullRequestGate](#pullrequestgate) with its step already bound.

#### Parameters

##### pr

[`PullRequestRef`](#pullrequestref)

##### scope

`string`

##### approval

[`ApprovalSignal`](#approvalsignal)

#### Returns

`AsyncGenerator`\<[`PullRequestWake`](#pullrequestwake), `void`, `undefined`\>

***

### PullRequestRef

> **PullRequestRef** = `object`

#### Properties

##### number

> **number**: `number`

##### owner

> **owner**: `string`

##### repo

> **repo**: `string`

***

### PullRequestWake

> **PullRequestWake** = \{ `headSha`: `string`; `kind`: `"merge-ready"`; `retryNoted`: `boolean`; \} \| \{ `body?`: `string`; `kind`: `"review-comments"`; `threads`: `ReviewThread`[]; \} \| \{ `failing`: `CheckRun`[]; `headSha`: `string`; `kind`: `"ci-red"`; `mentionLogin`: `string` \| `null`; \} \| \{ `kind`: `"closed"`; `merged`: `boolean`; \}

What is outstanding on the pull request right now. Every wake describes
current state, so the same state yields the same wake until the consumer
leaves evidence on the pull request that it is done with it:

- `review-comments`: feedback with no answer carrying this scope's marker.
- `ci-red`: the current head is red, with no marked stand-down for it.
- `merge-ready`: GitHub reports the pull request mergeable and the
  configured approval signal is present, with no marked stand-down for it.
  `retryNoted` says a refusal jigs is waiting out was already reported for
  this head, so the retry is silent.
- `closed`: terminal.

***

### StatusReason

> **StatusReason** = `"merge"` \| `"ci"` \| `"merge-retry"`

Why a `status` note was written, so one note never silences another.
`merge` and `ci` stand a commit down; `merge-retry` only records that the
refusal was already reported, and leaves the commit merge-ready.

## Variables

### approvalSignalSchema

> `const` **approvalSignalSchema**: `ZodDiscriminatedUnion`\<\[`ZodObject`\<\{ `kind`: `ZodLiteral`\<`"review"`\>; \}, `$strict`\>, `ZodObject`\<\{ `kind`: `ZodLiteral`\<`"label"`\>; `name`: `ZodString`; \}, `$strict`\>\], `"kind"`\>

***

### mergePolicySchema

> `const` **mergePolicySchema**: `ZodObject`\<\{ `approval`: `ZodDefault`\<`ZodDiscriminatedUnion`\<\[`ZodObject`\<\{ `kind`: `ZodLiteral`\<`"review"`\>; \}, `$strict`\>, `ZodObject`\<\{ `kind`: `ZodLiteral`\<`"label"`\>; `name`: `ZodString`; \}, `$strict`\>\], `"kind"`\>\>; `by`: `ZodDefault`\<`ZodEnum`\<\{ `human`: `"human"`; `jigs`: `"jigs"`; \}\>\>; `method`: `ZodDefault`\<`ZodEnum`\<\{ `merge`: `"merge"`; `rebase`: `"rebase"`; `squash`: `"squash"`; \}\>\>; \}, `$strict`\>

***

### PULL\_REQUEST\_TOKEN\_PREFIX

> `const` **PULL\_REQUEST\_TOKEN\_PREFIX**: `"github:pr:"` = `"github:pr:"`

## Functions

### approvalState()

> **approvalState**(`snapshot`, `approval`): [`ApprovalState`](#approvalstate)

Is the operator's consent recorded on the pull request, as this factory
asked for it?

- `review`: the latest review each person left is the one that counts, and
  at least one of them approves this exact commit with none requesting
  changes. An approval names a commit, so a push withdraws it.
- `label`: the label is on the pull request. It means "merge whenever
  ready", so it survives later pushes and jigs never removes it.

#### Parameters

##### snapshot

`PullRequestSnapshot`

##### approval

\{ `kind`: `"review"`; \} | \{ `kind`: `"label"`; `name`: `string`; \}

#### Returns

[`ApprovalState`](#approvalstate)

***

### attend()

> **attend**\<`T`\>(`wakes`, `onWake`, `describe?`): `Promise`\<`T`\>

#### Type Parameters

##### T

`T`

#### Parameters

##### wakes

`AsyncGenerator`\<[`PullRequestWake`](#pullrequestwake), `void`, `undefined`\>

##### onWake

(`wake`) => [`Attend`](#attend)\<`T`\> \| `Promise`\<[`Attend`](#attend)\<`T`\>\>

##### describe?

`string`

#### Returns

`Promise`\<`T`\>

***

### bindPullRequestSteps()

> **bindPullRequestSteps**(`steps`): `object`

Connect pull-request waiting to the factory's durable state reader.

#### Parameters

##### steps

###### fetchPullRequestState

`FetchPrState`

#### Returns

`object`

##### pullRequestGate

> **pullRequestGate**: [`PullRequestGateFn`](#pullrequestgatefn) = `gate`

***

### carriesMarker()

> **carriesMarker**(`body`): `boolean`

Whether jigs wrote this comment, whatever scope wrote it. This is the whole
self guard: the author login cannot serve, because a factory running on its
operator's token posts as the operator.

#### Parameters

##### body

`string`

#### Returns

`boolean`

***

### classifyPullRequestState()

> **classifyPullRequestState**(`snapshot`, `scope`, `approval`): [`PullRequestState`](#pullrequeststate)

What this scope still owes the pull request, derived from the snapshot, the
markers in it, and the approval signal the factory configured. Pure: two
identical snapshots classify identically, and a snapshot whose comments
already carry this scope's answers yields nothing.

#### Parameters

##### snapshot

`PullRequestSnapshot`

##### scope

`string`

##### approval

\{ `kind`: `"review"`; \} | \{ `kind`: `"label"`; `name`: `string`; \}

#### Returns

[`PullRequestState`](#pullrequeststate)

***

### commentSource()

> **commentSource**(`comment`): `string`

What a comment is, as a marker names it. The edit time is part of it: a
reviewer who edits a comment has said something new, and an answer to the
old text no longer answers it.

#### Parameters

##### comment

###### id

`number`

###### updatedAt

`string`

#### Returns

`string`

***

### currentRunId()

> **currentRunId**(): `string`

The run a marker records as its provenance.

#### Returns

`string`

***

### defaultPullRequestScope()

> **defaultPullRequestScope**(`subject`): `string`

The scope a caller gets when it names none: this workflow's function name
and the subject it was given — a ticket key, or the pull request itself.
Pass an explicit scope to continue another workflow's work, or to review a
pull request independently of the run delivering it.

#### Parameters

##### subject

`string`

#### Returns

`string`

***

### finished()

> **finished**\<`T`\>(`value`): [`Attend`](#attend)\<`T`\>

#### Type Parameters

##### T

`T`

#### Parameters

##### value

`T`

#### Returns

[`Attend`](#attend)\<`T`\>

***

### isApprovalSatisfied()

> **isApprovalSatisfied**(`snapshot`, `approval`): `boolean`

[approvalState](#approvalstate-1) as the single question a merge asks of it.

#### Parameters

##### snapshot

`PullRequestSnapshot`

##### approval

\{ `kind`: `"review"`; \} | \{ `kind`: `"label"`; `name`: `string`; \}

#### Returns

`boolean`

***

### isPullRequestMergeReady()

> **isPullRequestMergeReady**(`snapshot`, `approval`): `boolean`

May this pull request merge now? [mergeRefusal](#mergerefusal-1) for why it may not.

#### Parameters

##### snapshot

`PullRequestSnapshot`

##### approval

\{ `kind`: `"review"`; \} | \{ `kind`: `"label"`; `name`: `string`; \}

#### Returns

`boolean`

***

### listen()

> **listen**(): [`Attend`](#attend)\<`never`\>

#### Returns

[`Attend`](#attend)\<`never`\>

***

### markBody()

> **markBody**(`body`, `markers`): `string`

The body as posted: the text a human reads, then the markers. At least one,
always — an unmarked comment of jigs' own reads as human feedback and buys
itself a revision round.

#### Parameters

##### body

`string`

##### markers

[`PullRequestMarker`](#pullrequestmarker)[]

#### Returns

`string`

***

### mergeRefusal()

> **mergeRefusal**(`snapshot`, `expectedHeadSha`, `approval`): [`MergeRefusal`](#mergerefusal) \| `null`

Why this pull request cannot merge at `expectedHeadSha`, or `null` when it
can. The single verdict behind both the gate, which asks about the head it
just read, and the merge step, which asks again about the head it pinned.

`mergeable_state` is the authority that will accept or refuse the merge call,
and it already folds in conflicts, required checks and required reviews, so
jigs re-derives none of that. Anything other than `clean` — `unknown`
included, which only means GitHub is still computing it — is "not yet, ask
again on the next wake", with `dirty` the exception: a conflicting branch
needs a new commit, and no amount of asking makes one.

`mergeable_state` is not enough on its own: a repository that requires no
checks is `clean` with no build at all, including in the seconds before CI
registers, so a label-approved pull request could merge ahead of its own
build. `ci` closes that: it is green only when there is at least one check
and every one of them passed. The cost is deliberate — jigs never merges a
repository with no CI, and such a repository needs `merge.by: "human"`.

#### Parameters

##### snapshot

`PullRequestSnapshot`

##### expectedHeadSha

`string`

##### approval

\{ `kind`: `"review"`; \} | \{ `kind`: `"label"`; `name`: `string`; \}

#### Returns

[`MergeRefusal`](#mergerefusal) \| `null`

***

### parseMarkers()

> **parseMarkers**(`body`): [`PullRequestMarker`](#pullrequestmarker)[]

Every marker in one comment body, in the order they appear.

#### Parameters

##### body

`string`

#### Returns

[`PullRequestMarker`](#pullrequestmarker)[]

***

### postPullRequestNote()

> **postPullRequestNote**(`options`): `Promise`\<`void`\>

Posts a note about a commit — a merge jigs could not make, CI it could not
repair — marked with the commit it settles, so the next wake does not ask
for the same attempt again. A note that cannot be posted is logged and the
wake ends; the state it describes is still there to be reassessed.

#### Parameters

##### options

[`PostPullRequestNoteOptions`](#postpullrequestnoteoptions)

#### Returns

`Promise`\<`void`\>

***

### postReviewAnswers()

> **postReviewAnswers**(`options`): `Promise`\<`void`\>

Posts each answer where it belongs, marked with the sources it answers. A
synthetic conversation thread has no inline anchor, so its answer lands on
the conversation. Posting stops at the first failure: what is still
unanswered comes back on the next wake.

#### Parameters

##### options

[`PostReviewAnswersOptions`](#postreviewanswersoptions)

#### Returns

`Promise`\<`void`\>

***

### pullRequestGate()

> **pullRequestGate**(`pr`, `fetchState`, `scope`, `approval`): `AsyncGenerator`\<[`PullRequestWake`](#pullrequestwake), `void`, `undefined`\>

#### Parameters

##### pr

[`PullRequestRef`](#pullrequestref)

##### fetchState

`FetchPrState`

##### scope

`string`

##### approval

\{ `kind`: `"review"`; \} | \{ `kind`: `"label"`; `name`: `string`; \}

#### Returns

`AsyncGenerator`\<[`PullRequestWake`](#pullrequestwake), `void`, `undefined`\>

***

### pullRequestScope()

> **pullRequestScope**(`workflow`, `subject`): `string`

The default continuation identity: the workflow, and what it is working on.

#### Parameters

##### workflow

`string`

##### subject

`string`

#### Returns

`string`

***

### pullRequestToken()

> **pullRequestToken**(`pr`): `string`

#### Parameters

##### pr

[`PullRequestRef`](#pullrequestref)

#### Returns

`string`

***

### readLedger()

> **readLedger**(`bodies`, `scope`): [`MarkerLedger`](#markerledger)

#### Parameters

##### bodies

`Iterable`\<`string`\>

##### scope

`string`

#### Returns

[`MarkerLedger`](#markerledger)

***

### readPullRequestLedger()

> **readPullRequestLedger**(`snapshot`, `scope`): [`MarkerLedger`](#markerledger)

What this scope has already done here, as the pull request records it.

#### Parameters

##### snapshot

`PullRequestSnapshot`

##### scope

`string`

#### Returns

[`MarkerLedger`](#markerledger)

***

### renderChecks()

> **renderChecks**(`failing`): `string`

#### Parameters

##### failing

`CheckRun`[]

#### Returns

`string`

***

### renderMarker()

> **renderMarker**(`marker`): `string`

The hidden line jigs appends to everything it posts on a pull request.

#### Parameters

##### marker

[`PullRequestMarker`](#pullrequestmarker)

#### Returns

`string`

***

### tokenFromGitHubPayload()

> **tokenFromGitHubPayload**(`payload`): `string` \| `null`

#### Parameters

##### payload

`unknown`

#### Returns

`string` \| `null`
