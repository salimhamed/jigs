# @jigs-ai/jigs v0.56.2

Compose ticket claiming, review, snapshots and human handoffs inside a workflow.

## Classes

### ClaimConflictError

A ticket-claim failure that identifies the run already holding the ticket.

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new ClaimConflictError**(`resource`, `owningRunId`): [`ClaimConflictError`](#claimconflicterror)

###### Parameters

###### resource

`string`

###### owningRunId

`string`

###### Returns

[`ClaimConflictError`](#claimconflicterror)

###### Overrides

`Error.constructor`

#### Properties

##### owningRunId

> `readonly` **owningRunId**: `string`

##### resource

> `readonly` **resource**: `string`

## Interfaces

### HumanReply

The first human ticket reply that wakes a halted run.

#### Properties

##### author

> **author**: `object`

###### id

> **id**: `string`

###### name

> **name**: `string`

##### body

> **body**: `string`

##### commentId

> **commentId**: `string`

##### createdAt

> **createdAt**: `string`

***

### ReviewTicketOptions

Agent, ticket and durable operations used by the ticket-review loop.

#### Properties

##### claim

> **claim**: [`TicketClaim`](#ticketclaim)

##### cwd

> **cwd**: `string`

##### fetchTicketSnapshot()

> **fetchTicketSnapshot**: (`issueId`) => `Promise`\<[`TicketSnapshot`](#ticketsnapshot)\>

###### Parameters

###### issueId

`string`

###### Returns

`Promise`\<[`TicketSnapshot`](#ticketsnapshot)\>

##### haltForHuman

> **haltForHuman**: [`HaltForHumanFn`](#haltforhumanfn)

##### harness

> **harness**: `Harness`

##### on?

> `optional` **on**: `object`

Optional workflow policy around a human clarification.

###### humanReplied()?

> `optional` **humanReplied**: () => `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

###### needsHuman()?

> `optional` **needsHuman**: () => `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

##### postTicketNote

> **postTicketNote**: [`PostTicketNote`](#postticketnote-2)

##### prompt?

> `optional` **prompt**: [`TicketReviewPrompt`](#ticketreviewprompt)

##### runAgent

> **runAgent**: `RunAgentFn`

##### snapshot

> **snapshot**: [`TicketSnapshot`](#ticketsnapshot)

***

### TicketClaim

A ticket held exclusively by the current workflow run.

#### Properties

##### hook

> **hook**: `Hook`\<`unknown`\>

##### identifier

> **identifier**: `string`

##### issueId

> **issueId**: `string`

##### postedCommentIds

> **postedCommentIds**: `string`[]

Every comment this run has posted on the ticket. A parked run skips these
when it looks for a human's reply.

##### token

> **token**: `string`

## Type Aliases

### BoundReviewTicketOptions

> **BoundReviewTicketOptions** = `Omit`\<[`ReviewTicketOptions`](#reviewticketoptions), `"runAgent"` \| `"haltForHuman"` \| `"fetchTicketSnapshot"` \| `"postTicketNote"`\>

Ticket-review options left after the factory's durable steps are bound.

***

### CheckForTicketHumanReply()

> **CheckForTicketHumanReply** = (`issueId`, `sinceIso`, `postedCommentIds`) => `Promise`\<\{ `cursor`: `string`; `reply`: [`HumanReply`](#humanreply) \| `null`; \}\>

Durable step contract for finding a human reply after a cursor, skipping the run's own comments.

#### Parameters

##### issueId

`string`

##### sinceIso

`string`

##### postedCommentIds

readonly `string`[]

#### Returns

`Promise`\<\{ `cursor`: `string`; `reply`: [`HumanReply`](#humanreply) \| `null`; \}\>

***

### Halt

> **Halt** = `object`

What the ticket comment says, in the words a stranger to the repo reads.
`headline` is one plain sentence naming what jigs paused and why, `where`
names the block it paused in so the footer can say so, `about` restates the
ticket itself, `notes` are plain bullet lines, and `onReply` decides what
the comment asks the human to do: choose between the questions ("continue")
or repair something and let the step run again ("retry").

#### Properties

##### about?

> `optional` **about**: `string`

##### headline

> **headline**: `string`

##### notes?

> `optional` **notes**: `string`[]

##### onReply

> **onReply**: `"continue"` \| `"retry"`

##### questions?

> `optional` **questions**: `HaltQuestion`[]

##### where

> **where**: `string`

***

### HaltForHumanDependencies

> **HaltForHumanDependencies** = `object`

Durable operations required to post and resume a human halt.

#### Properties

##### checkForTicketHumanReply

> **checkForTicketHumanReply**: [`CheckForTicketHumanReply`](#checkfortickethumanreply-1)

##### postTicketHumanInputRequest

> **postTicketHumanInputRequest**: [`PostTicketHumanInputRequest`](#posttickethumaninputrequest-2)

***

### HaltForHumanFn()

> **HaltForHumanFn** = (`claim`, `halt`) => `Promise`\<[`HumanReply`](#humanreply)\>

[haltForHuman](#haltforhuman-1) with its steps already bound — what a block is handed.

#### Parameters

##### claim

[`TicketClaim`](#ticketclaim)

##### halt

[`Halt`](#halt)

#### Returns

`Promise`\<[`HumanReply`](#humanreply)\>

***

### PostTicketHumanInputRequest()

> **PostTicketHumanInputRequest** = (`issueId`, `halt`) => `Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

Durable step contract for posting a question and recording its cursor.

#### Parameters

##### issueId

`string`

##### halt

[`Halt`](#halt)

#### Returns

`Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

***

### PostTicketNote()

> **PostTicketNote** = (`issueId`, `note`) => `Promise`\<\{ `commentId`: `string`; \}\>

Posting a note on the ticket that asks for nothing and suspends nothing.
Declared here rather than written as `typeof postTicketNote` for the same
reason the halt's step contracts are: the block side owns the contract.

#### Parameters

##### issueId

`string`

##### note

[`TicketNote`](#ticketnote)

#### Returns

`Promise`\<\{ `commentId`: `string`; \}\>

***

### TicketComment

> **TicketComment** = `object`

A Linear ticket comment captured in a workflow snapshot.

#### Properties

##### author

> **author**: `string` \| `null`

##### body

> **body**: `string`

##### createdAt

> **createdAt**: `string`

##### id

> **id**: `string`

***

### TicketHandoff

> **TicketHandoff** = `object`

What a ticket review hands the builder: the brief plus the snapshot it
was written from. Both travel together on purpose — the ticket is
authoritative wherever the two conflict, and review or verify steps judge
the work against the snapshot's acceptance criteria, never against the
brief, so a re-planning agent cannot move the goalposts.

`assumptions` is what the review decided for itself rather than asked
about. It is posted to the ticket, so a human can still correct it.

#### Properties

##### assumptions

> **assumptions**: `string`[]

##### brief

> **brief**: `string`

##### snapshot

> **snapshot**: [`TicketSnapshot`](#ticketsnapshot)

***

### TicketLink

> **TicketLink** = `object`

A named external link attached to a Linear ticket.

#### Properties

##### title

> **title**: `string`

##### url

> **url**: `string`

***

### TicketNote

> **TicketNote** = `object`

A comment jigs posts on the ticket that asks for nothing and suspends
nothing. It carries its own words, the way a halt does, so the
renderer owns the layout and every caller owns what it says.

#### Properties

##### closing

> **closing**: `string`

What the reader should do with it.

##### headline

> **headline**: `string`

One plain sentence naming what jigs is about to do, or has stopped doing.

##### notes

> **notes**: `string`[]

The bullet lines under it.

***

### TicketRef

> **TicketRef** = `object`

A compact reference to a related Linear ticket.

#### Properties

##### id

> **id**: `string`

##### identifier

> **identifier**: `string`

##### title

> **title**: `string`

***

### TicketReviewPrompt()

> **TicketReviewPrompt** = (`input`) => `string`

Renders instructions for an agent to turn a ticket into an actionable handoff.

#### Parameters

##### input

[`TicketReviewPromptInput`](#ticketreviewpromptinput)

#### Returns

`string`

***

### TicketReviewPromptInput

> **TicketReviewPromptInput** = `object`

The rendered ticket supplied to a ticket-review prompt.

#### Properties

##### ticket

> **ticket**: `string`

***

### TicketSnapshot

> **TicketSnapshot** = `object`

The fixed ticket state shared by every step in one workflow activation.

#### Properties

##### blockedBy

> **blockedBy**: [`TicketRef`](#ticketref)[]

##### blocks

> **blocks**: [`TicketRef`](#ticketref)[]

##### branchName

> **branchName**: `string`

##### comments

> **comments**: [`TicketComment`](#ticketcomment)[]

##### description

> **description**: `string`

##### fetchedAt

> **fetchedAt**: `string`

##### id

> **id**: `string`

##### identifier

> **identifier**: `string`

##### labels

> **labels**: `string`[]

##### links

> **links**: [`TicketLink`](#ticketlink)[]

##### state

> **state**: `string`

##### subIssues

> **subIssues**: [`TicketRef`](#ticketref)[]

##### title

> **title**: `string`

##### url

> **url**: `string`

## Variables

### NEEDS\_HUMAN\_TOKEN\_PREFIX

> `const` **NEEDS\_HUMAN\_TOKEN\_PREFIX**: `"jigs:needs-human:"` = `"jigs:needs-human:"`

Prefix for marker hooks that tell operators which ticket comment needs an answer.

***

### TICKET\_TOKEN\_PREFIX

> `const` **TICKET\_TOKEN\_PREFIX**: `"linear:ticket:"` = `"linear:ticket:"`

Prefix for the durable hook that gives one run exclusive ownership of a ticket.

***

### ticketReviewPrompt

> `const` **ticketReviewPrompt**: [`TicketReviewPrompt`](#ticketreviewprompt)

The default prompt for reviewing a Linear ticket before implementation begins.

***

### ticketReviewVerdictSchema

> `const` **ticketReviewVerdictSchema**: `ZodObject`\<\{ `about`: `ZodString`; `assumptions`: `ZodArray`\<`ZodString`\>; `brief`: `ZodString`; `questions`: `ZodArray`\<`ZodObject`\<\{ `context`: `ZodOptional`\<`ZodString`\>; `options`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>\>\>; `question`: `ZodString`; \}, `$strict`\>\>; `verdict`: `ZodEnum`\<\{ `needs-human`: `"needs-human"`; `proceed`: `"proceed"`; \}\>; \}, `$strict`\>

Structured verdict returned by the agent that reviews a ticket before work starts.

## Functions

### acquireTicket()

> **acquireTicket**(`reference`, `steps`): `Promise`\<\{ `claim`: [`TicketClaim`](#ticketclaim); `snapshot`: [`TicketSnapshot`](#ticketsnapshot); \}\>

Resolve a ticket reference, claim it, and read its current requirements.
Provisioning and all other protected work deliberately happen after this block.

#### Parameters

##### reference

`string`

##### steps

[`AcquireTicketSteps`](#acquireticketsteps)

#### Returns

`Promise`\<\{ `claim`: [`TicketClaim`](#ticketclaim); `snapshot`: [`TicketSnapshot`](#ticketsnapshot); \}\>

***

### claimTicket()

> **claimTicket**(`issueId`, `identifier`): `Promise`\<[`TicketClaim`](#ticketclaim)\>

Claim a Linear ticket for the lifetime of the current workflow run.

#### Parameters

##### issueId

`string`

##### identifier

`string`

#### Returns

`Promise`\<[`TicketClaim`](#ticketclaim)\>

***

### haltForHuman()

> **haltForHuman**(`claim`, `halt`, `deps`): `Promise`\<[`HumanReply`](#humanreply)\>

Post a ticket question and suspend until a human replies to the claim hook.

#### Parameters

##### claim

[`TicketClaim`](#ticketclaim)

##### halt

[`Halt`](#halt)

##### deps

[`HaltForHumanDependencies`](#haltforhumandependencies)

#### Returns

`Promise`\<[`HumanReply`](#humanreply)\>

***

### needsHumanToken()

> **needsHumanToken**(`issueId`, `commentId`): `string`

Build the marker token for a run's unanswered ticket comment.

#### Parameters

##### issueId

`string`

##### commentId

`string`

#### Returns

`string`

***

### noteOnTicket()

> **noteOnTicket**(`claim`, `note`, `deps`): `Promise`\<`void`\>

Post a note on a claimed ticket and record its comment on the claim, so a
later halt in this run never mistakes it for a human's reply.

#### Parameters

##### claim

[`TicketClaim`](#ticketclaim)

##### note

[`TicketNote`](#ticketnote)

##### deps

###### postTicketNote

[`PostTicketNote`](#postticketnote-2)

#### Returns

`Promise`\<`void`\>

***

### renderTicketSnapshot()

> **renderTicketSnapshot**(`snapshot`): `string`

Render a ticket snapshot as Markdown for an agent prompt.

#### Parameters

##### snapshot

[`TicketSnapshot`](#ticketsnapshot)

#### Returns

`string`

***

### reviewTicket()

> **reviewTicket**(`options`): `Promise`\<[`TicketHandoff`](#tickethandoff)\>

Review a ticket until it is actionable, asking a human when a decision is missing.

#### Parameters

##### options

[`ReviewTicketOptions`](#reviewticketoptions)

#### Returns

`Promise`\<[`TicketHandoff`](#tickethandoff)\>

***

### ticketToken()

> **ticketToken**(`issueId`): `string`

Build the durable hook token for a Linear issue ID.

#### Parameters

##### issueId

`string`

#### Returns

`string`

***

### tokenFromLinearPayload()

> **tokenFromLinearPayload**(`payload`): `string` \| `null`

Derive a claimed ticket's hook token from a Linear comment webhook.

#### Parameters

##### payload

`unknown`

#### Returns

`string` \| `null`

***

### toTicketSnapshot()

> **toTicketSnapshot**(`raw`, `fetchedAt`): [`TicketSnapshot`](#ticketsnapshot)

Normalize a provider response into the stable workflow-side ticket shape.

#### Parameters

##### raw

`RawIssueSnapshot`

##### fetchedAt

`string`

#### Returns

[`TicketSnapshot`](#ticketsnapshot)

## Factory plumbing

### AcquireTicketSteps

Durable ticket lookups required before a workflow starts protected work.

#### Properties

##### fetchTicketSnapshot()

> **fetchTicketSnapshot**: (`issueId`) => `Promise`\<[`TicketSnapshot`](#ticketsnapshot)\>

Read the ticket’s current details and discussion.

###### Parameters

###### issueId

`string`

###### Returns

`Promise`\<[`TicketSnapshot`](#ticketsnapshot)\>

##### resolveLinearIssue()

> **resolveLinearIssue**: (`reference`) => `Promise`\<`LinearIssueRef`\>

Resolve a Linear identifier or issue ID before claiming or reading the ticket.

###### Parameters

###### reference

`string`

###### Returns

`Promise`\<`LinearIssueRef`\>

***

### LinearSteps

Durable wrappers a factory supplies for Linear and agent operations.

#### Properties

##### checkForTicketHumanReply

> **checkForTicketHumanReply**: [`CheckForTicketHumanReply`](#checkfortickethumanreply-1)

##### fetchTicketSnapshot()

> **fetchTicketSnapshot**: (`issueId`) => `Promise`\<[`TicketSnapshot`](#ticketsnapshot)\>

###### Parameters

###### issueId

`string`

###### Returns

`Promise`\<[`TicketSnapshot`](#ticketsnapshot)\>

##### postTicketHumanInputRequest

> **postTicketHumanInputRequest**: [`PostTicketHumanInputRequest`](#posttickethumaninputrequest-2)

##### postTicketNote

> **postTicketNote**: [`PostTicketNote`](#postticketnote-2)

##### runAgent

> **runAgent**: `RunAgentFn`

***

### bindLinearSteps()

> **bindLinearSteps**(`steps`): `object`

Connect Linear clarification and review to the factory's durable steps.

#### Parameters

##### steps

[`LinearSteps`](#linearsteps)

#### Returns

`object`

##### haltForHuman

> **haltForHuman**: [`HaltForHumanFn`](#haltforhumanfn)

##### noteOnTicket()

> **noteOnTicket**: (`claim`, `note`) => `Promise`\<`void`\>

###### Parameters

###### claim

[`TicketClaim`](#ticketclaim)

###### note

[`TicketNote`](#ticketnote)

###### Returns

`Promise`\<`void`\>

##### reviewTicket()

> **reviewTicket**: (`options`) => `Promise`\<[`TicketHandoff`](#tickethandoff)\>

###### Parameters

###### options

[`BoundReviewTicketOptions`](#boundreviewticketoptions)

###### Returns

`Promise`\<[`TicketHandoff`](#tickethandoff)\>

##### runAgentOrHalt()

> **runAgentOrHalt**: \<`T`\>(`claim`, `config`) => `Promise`\<`AgentResult`\<`T`\>\>

###### Type Parameters

###### T

`T` = `undefined`

###### Parameters

###### claim

[`TicketClaim`](#ticketclaim)

###### config

`RunAgentOptions`\<`T`\>

###### Returns

`Promise`\<`AgentResult`\<`T`\>\>
