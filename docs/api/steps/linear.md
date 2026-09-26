# @jigs-ai/jigs v0.73.0

Low-level Linear operations for factory-owned steps. Workflow code calls their
`#jigs/steps` wrappers; higher-level waiting such as `haltForHuman` comes from
`#jigs/routines`.

See [Waiting and external events](https://salimhamed.github.io/jigs/guide/waiting-and-events).

## Resolve and read

### LinearIssueMatch

A matching Linear ticket returned by a project title search.

#### Properties

##### description

> **description**: `string`

##### id

> **id**: `string`

##### identifier

> **identifier**: `string`

##### state

> **state**: `string`

##### title

> **title**: `string`

##### url

> **url**: `string`

***

### fetchTicketSnapshot()

> **fetchTicketSnapshot**(`issueId`): `Promise`\<`TicketSnapshot`\>

Read the ticket’s current details and discussion.

#### Parameters

##### issueId

`string`

#### Returns

`Promise`\<`TicketSnapshot`\>

***

### findIssueInProject()

> **findIssueInProject**(`input`): `Promise`\<[`LinearIssueMatch`](#linearissuematch) \| `null`\>

Find the newest ticket in a project whose title starts with the given text.

#### Parameters

##### input

###### project

`string`

###### titlePrefix

`string`

#### Returns

`Promise`\<[`LinearIssueMatch`](#linearissuematch) \| `null`\>

***

### resolveLinearIssue()

> **resolveLinearIssue**(`reference`): `Promise`\<`LinearIssueRef`\>

Resolve a Linear identifier or issue ID before claiming or reading the ticket.

#### Parameters

##### reference

`string`

#### Returns

`Promise`\<`LinearIssueRef`\>

## Create and update

### CreateIssueInProjectInput

Fields used to create a Linear ticket in a project's first team.

#### Properties

##### description

> **description**: `string`

##### project

> **project**: `string`

##### title

> **title**: `string`

***

### TicketStatusResult

The before-and-after state names from a ticket status update.

#### Properties

##### changed

> **changed**: `boolean`

##### from

> **from**: `string`

##### to

> **to**: `string`

***

### createComment()

> **createComment**(`issueId`, `body`): `Promise`\<\{ `createdAt`: `string`; `id`: `string`; \}\>

Post a comment on a ticket.

#### Parameters

##### issueId

`string`

##### body

`string`

#### Returns

`Promise`\<\{ `createdAt`: `string`; `id`: `string`; \}\>

***

### createIssueInProject()

> **createIssueInProject**(`input`): `Promise`\<\{ `id`: `string`; `identifier`: `string`; `url`: `string`; \}\>

Create a ticket in the project’s first team.

#### Parameters

##### input

[`CreateIssueInProjectInput`](#createissueinprojectinput)

#### Returns

`Promise`\<\{ `id`: `string`; `identifier`: `string`; `url`: `string`; \}\>

***

### setTicketStatus()

> **setTicketStatus**(`issueId`, `stateName`): `Promise`\<[`TicketStatusResult`](#ticketstatusresult)\>

Set a ticket to one of its team's named states.

#### Parameters

##### issueId

`string`

##### stateName

`string`

#### Returns

`Promise`\<[`TicketStatusResult`](#ticketstatusresult)\>

## Human interaction primitives

### checkForTicketHumanReply

> `const` **checkForTicketHumanReply**: `CheckForTicketHumanReply`

Look for a reply since the last check, excluding every comment the run posted.

***

### postTicketHumanInputRequest()

> **postTicketHumanInputRequest**(`issueId`, `halt`, `metadata`, `definition`, `render`): `Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

Post a question or failure on the ticket so a person can help the run continue.

#### Parameters

##### issueId

`string`

##### halt

`Halt`

##### metadata

`NamedRunMetadata`

##### definition

`Pick`\<`FactoryDefinition`, `"linear"`\>

##### render

[`RenderNeedsHumanComment`](#renderneedshumancomment) = `renderNeedsHumanComment`

#### Returns

`Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

#### Remarks

Mentions the factory's `linear.operator`, or the ticket's creator when it is
not set, then the assignee and the halt's `mention` emails, each person once.
A person Linear cannot find is skipped with a warning; the comment always
posts. `definition` is the built factory definition the step wrapper passes
in, so a changed operator takes effect after a rebuild, which `jigs up` does.

***

### postTicketNote()

> **postTicketNote**(`issueId`, `note`, `definition`, `render`): `Promise`\<\{ `commentId`: `string`; \}\>

Tell ticket participants something the run decided, without waiting for a reply.

#### Parameters

##### issueId

`string`

##### note

`TicketNote`

##### definition

`Pick`\<`FactoryDefinition`, `"linear"`\>

##### render

[`RenderTicketNote`](#renderticketnote) = `renderTicketNote`

#### Returns

`Promise`\<\{ `commentId`: `string`; \}\>

#### Remarks

Mentions the same people as [postTicketHumanInputRequest](#posttickethumaninputrequest), with the
note's `mention` emails as the extras.

## Rendering/customization

### NeedsHumanContext

> **NeedsHumanContext** = `object`

What the comment's footer says about the run that posted it. The factory's
step wrapper builds it: the run id and the workflow name come from the
Workflow SDK's metadata, and the dashboard link from the service's own
configuration. None of it is visible to the workflow. Where the run paused
belongs to the halt, not the context: only the routine that raised it knows.

#### Properties

##### dashboardUrl?

> `optional` **dashboardUrl**: `string`

##### runId

> **runId**: `string`

##### workflow?

> `optional` **workflow**: `string`

***

### RenderNeedsHumanComment()

> **RenderNeedsHumanComment** = (`halt`, `context`, `participants`) => `string`

Renders the Linear comment that asks a person to unblock a run.

#### Parameters

##### halt

`Halt`

##### context

[`NeedsHumanContext`](#needshumancontext)

##### participants

[`TicketParticipants`](#ticketparticipants)

#### Returns

`string`

***

### RenderTicketNote()

> **RenderTicketNote** = (`note`, `participants`) => `string`

Renders a non-blocking Linear note for ticket participants.

#### Parameters

##### note

`TicketNote`

##### participants

[`TicketParticipants`](#ticketparticipants)

#### Returns

`string`

***

### TicketParticipants

> **TicketParticipants** = `object`

Who the comment is for. `mentions` is the final list the comment greets, in
order and each person once: the operator (or, without one, the ticket's
creator), the assignee, then any extra people the step was asked to mention.
A custom renderer greets `mentions` rather than working it out again; the
other fields are there for context and may be null.

#### Properties

##### assignee

> **assignee**: `LinearUser` \| `null`

##### creator

> **creator**: `LinearUser` \| `null`

##### mentions

> **mentions**: `LinearUser`[]

##### operator

> **operator**: `LinearUser` \| `null`

The configured operator, or null when none is set or Linear could not find them.

***

### renderNeedsHumanComment

> `const` **renderNeedsHumanComment**: [`RenderNeedsHumanComment`](#renderneedshumancomment)

Render the default human-input request as Linear Markdown.

***

### renderTicketNote

> `const` **renderTicketNote**: [`RenderTicketNote`](#renderticketnote)

Render the default non-blocking ticket note as Linear Markdown.
