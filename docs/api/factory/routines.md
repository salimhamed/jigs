# @jigs-ai/jigs v0.75.0

Workflow operations bound to your factory's durable step wrappers.
Routines compose recorded steps and waits; they have no recorded result of their own.

## Agents and models

### agentSession()

> `const` **agentSession**: (`options`) => [`AgentSession`](#agentsession)

One agent across several turns: resumes the session it holds, or starts fresh when it cannot.

#### Parameters

##### options

###### cwd

`string`

###### harness

`Harness`

###### name

`string`

Names the session in log lines.

#### Returns

[`AgentSession`](#agentsession)

#### Remarks

Each turn supplies an incremental `resume` prompt and a complete `fresh` prompt.
A prompt may be a function, evaluated only when selected. A missing session or
changed harness descriptor starts fresh. The helper is rebuilt on replay;
recorded `AgentSessionRef` data restores the session reference.

***

### askAgent()

> `const` **askAgent**: \<`T`\>(`config`) => `Promise`\<`AgentResult`\<`T`\>\> = `agents.askAgent`

Ask an agent harness without tools or a worktree.

#### Type Parameters

##### T

`T` = `undefined`

#### Parameters

##### config

`AskAgentOptions`\<`T`\>

#### Returns

`Promise`\<`AgentResult`\<`T`\>\>

***

### askJev()

> `const` **askJev**: \<`QUESTIONS`\>(`config`) => `Promise`\<`JevResult`\<`QUESTIONS`\>\> = `agents.askJev`

Ask a decision model named questions and receive calibrated typed answers.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* `JevQuestions`

#### Parameters

##### config

`AskJevOptions`\<`QUESTIONS`\>

#### Returns

`Promise`\<`JevResult`\<`QUESTIONS`\>\>

***

### askModel()

> `const` **askModel**: \<`T`\>(`config`) => `Promise`\<`ModelResult`\<`T`\>\> = `agents.askModel`

Ask a model without tools and validate its answer against your output schema.

#### Type Parameters

##### T

`T` = `undefined`

#### Parameters

##### config

`AskModelOptions`\<`T`\>

#### Returns

`Promise`\<`ModelResult`\<`T`\>\>

***

### runAgent()

> `const` **runAgent**: \<`T`\>(`config`) => `Promise`\<`AgentResult`\<`T`\>\> = `agents.runAgent`

Run an agent with tools and validate its answer against your output schema.

#### Type Parameters

##### T

`T` = `undefined`

#### Parameters

##### config

`RunAgentOptions`\<`T`\>

#### Returns

`Promise`\<`AgentResult`\<`T`\>\>

## Agent and model requests/results

### AgentSession

One agent across several turns of a workflow.

#### Remarks

`run` resumes the harness session the agent session holds. When that session is gone, or it was
recorded on a different harness descriptor, `run` starts fresh with the `fresh` prompt instead.

#### Methods

##### run()

###### Call Signature

> **run**\<`T`\>(`turn`): `Promise`\<`T`\>

With `output`, the answer is validated against it and returned parsed.

###### Type Parameters

###### T

`T`

###### Parameters

###### turn

[`AgentSessionTurn`](#agentsessionturn) & `object`

###### Returns

`Promise`\<`T`\>

###### Call Signature

> **run**(`turn`): `Promise`\<`void`\>

###### Parameters

###### turn

[`AgentSessionTurn`](#agentsessionturn)

###### Returns

`Promise`\<`void`\>

#### Properties

##### harness

> `readonly` **harness**: `Harness`

***

### AgentSessionTurn

The two ways to state one turn of an agent session.

#### Properties

##### fresh

> **fresh**: `string` \| () => `Promise`\<`string`\>

Sent to an agent starting from nothing: everything it needs. A function is called only when
the session starts fresh, so gathering its context costs nothing on a resume.

##### resume

> **resume**: `string` \| () => `Promise`\<`string`\>

Sent to an agent that already holds the earlier turns: only what is new. A function is called
only when the resume is taken.

## Linear tickets

### claimTicket()

> **claimTicket**(`issueId`, `identifier`): `Promise`\<`TicketClaim`\>

Claim a Linear ticket for the lifetime of the current workflow run.

#### Parameters

##### issueId

`string`

##### identifier

`string`

#### Returns

`Promise`\<`TicketClaim`\>

## Linear and human input

### haltForHuman()

> `const` **haltForHuman**: (`claim`, `halt`) => `Promise`\<`HumanReply`\> = `linear.haltForHuman`

Ask for help on the Linear ticket and wait for a human reply.

#### Parameters

##### claim

`TicketClaim`

##### halt

`Halt`

#### Returns

`Promise`\<`HumanReply`\>

#### Remarks

Posts the question on the claimed Linear ticket and waits for a verified human
reply. Polling and optional webhooks recheck the ticket. Answer on the ticket
to continue the same run; `jigs poke` only requests a recheck. The comment
mentions the operator (or the ticket's creator) and the assignee; list more
emails in the halt's `mention`.

***

### noteOnTicket()

> `const` **noteOnTicket**: (`claim`, `note`) => `Promise`\<`void`\> = `linear.noteOnTicket`

Post a note on a claimed ticket that asks for nothing and waits for nothing.

#### Parameters

##### claim

`TicketClaim`

##### note

`TicketNote`

#### Returns

`Promise`\<`void`\>

***

### reviewTicket()

> `const` **reviewTicket**: (`options`) => `Promise`\<`TicketHandoff`\> = `linear.reviewTicket`

Clarify a Linear ticket and prepare an implementation brief.

#### Parameters

##### options

###### claim

`TicketClaim`

###### cwd

`string`

###### harness

`Harness`

###### mention?

`string`[]

More people, by Linear email, for the review's note and questions to mention.

###### on?

\{ `humanReplied?`: () => `Promise`\<`void`\>; `needsHuman?`: () => `Promise`\<`void`\>; \}

Optional workflow policy around a human clarification.

###### on.humanReplied?

() => `Promise`\<`void`\>

###### on.needsHuman?

() => `Promise`\<`void`\>

###### prompt?

`TicketReviewPrompt`

###### snapshot

`TicketSnapshot`

#### Returns

`Promise`\<`TicketHandoff`\>

***

### runAgentOrHalt()

> `const` **runAgentOrHalt**: \<`T`\>(`claim`, `config`, `options?`) => `Promise`\<`AgentResult`\<`T`\>\> = `linear.runAgentOrHalt`

Run an agent, asking a human to fix missing capabilities before retrying.
A third argument, `{ mention }`, lists more emails for the request to mention.

#### Type Parameters

##### T

`T` = `undefined`

#### Parameters

##### claim

`TicketClaim`

##### config

`RunAgentOptions`\<`T`\>

##### options?

`RunAgentOrHaltOptions`

#### Returns

`Promise`\<`AgentResult`\<`T`\>\>

***

### acquireTicket()

> **acquireTicket**(`reference`): `Promise`\<\{ `claim`: `TicketClaim`; `snapshot`: `TicketSnapshot`; \}\>

Resolve a Linear ticket, claim it, and read its requirements, before any protected work.

#### Parameters

##### reference

`string`

#### Returns

`Promise`\<\{ `claim`: `TicketClaim`; `snapshot`: `TicketSnapshot`; \}\>

## Pull requests

### postPullRequestNote()

> `const` **postPullRequestNote**: (`options`) => `Promise`\<`void`\> = `pullRequests.postPullRequestNote`

Post a note about a commit, once per head and reason.

#### Parameters

##### options

###### body

`string`

The Markdown note body.

###### headSha

`string`

The commit the note is about: a red head, or a head it could not merge.

###### pr

`PullRequestRef`

The pull request receiving the note.

###### reason

`StatusReason`

Labels the update so CI and merge notes for the same commit stay independent.

###### scope

`string`

The continuation identity that owns the note.

#### Returns

`Promise`\<`void`\>

#### Remarks

Reads current comments and skips a note already marked with this scope, head and reason.
Use `ci` for a CI update, `merge` for a merge refusal, or `merge-retry` for a temporary
refusal. The reason does not change readiness or schedule more work. Posting failures
are logged and return without throwing; the workflow decides whether to try again.

***

### postReviewAnswers()

> `const` **postReviewAnswers**: (`options`) => `Promise`\<`void`\> = `pullRequests.postReviewAnswers`

Post one revision round's answers, each marked with what it answers.

#### Parameters

##### options

###### answers

`ThreadAnswers`

Replies and optional commit explanation produced for this revision round.

###### committedSha?

`string`

The commit the round pushed, when it pushed one; the explanation names it.

###### pr

`PullRequestRef`

The pull request receiving the answers.

###### scope

`string`

The continuation identity these answers belong to.

###### threads

`ReviewThread`[]

The wake's known threads, used to reject invented anchors and route each answer.

#### Returns

`Promise`\<`void`\>

#### Remarks

Marks each answer with its source and scope to identify the feedback it addresses.
Inline review threads and conversation comments use their respective GitHub reply endpoints.
Each call posts the supplied answers; the workflow decides which feedback needs a reply.
Posting stops and logs the error on the first failure. Read fresh facts before deciding
whether to try again. Include `committedSha` and a non-null `commitExplanation` to
explain a pushed commit after posting the replies.

***

### watchPullRequest()

> `const` **watchPullRequest**: (`pr`) => `AsyncGenerator`\<`PullRequestSnapshot`, `void`, `undefined`\> = `pullRequests.watchPullRequest`

Read current pull request facts, then yield changed snapshots until it closes.

#### Parameters

##### pr

`PullRequestRef`

#### Returns

`AsyncGenerator`\<`PullRequestSnapshot`, `void`, `undefined`\>

#### Remarks

Reads once immediately, then rereads on service polls, webhooks and `jigs poke`.
Duplicate wakes and reordered collections with unchanged facts do not yield again.
Snapshots include comments regardless of author or jigs markers; the workflow
owns decisions, action limits and merging. A closed snapshot is yielded once.
Leaving the loop releases the watch. Only one run may watch a pull request;
a second owner receives `ClaimConflictError`.

## Git changes

### committedWork()

> **committedWork**: (`worktree`, `options?`) => `Promise`\<\{ `commits`: `number`; `dirty`: `boolean`; `headSha`: `string`; \}\>

Read branch state, failing unless there is a new commit and no uncommitted work.

#### Parameters

##### worktree

`Worktree`

##### options?

###### since?

`string`

A commit SHA to count new commits from. Defaults to the worktree's base commit.

#### Returns

`Promise`\<\{ `commits`: `number`; `dirty`: `boolean`; `headSha`: `string`; \}\>

#### Remarks

Counts commits since the worktree base, or `options.since` when supplied.
Returns the head SHA, commit count and clean state; fails with a repair hint
if the agent left no new commit or uncommitted changes.
