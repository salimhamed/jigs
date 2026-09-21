# @salimhamed/jigs v0.42.1

Read and update Linear issues outside workflow code.

Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.

## Interfaces

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

### TicketStatusResult

The before-and-after state names from a ticket status update.

#### Properties

##### changed

> **changed**: `boolean`

##### from

> **from**: `string`

##### to

> **to**: `string`

## Type Aliases

### NeedsHumanContext

> **NeedsHumanContext** = `object`

What the comment's footer says about the run that posted it. The factory's
step wrapper builds it: the run id and the workflow name come from the
Workflow SDK's metadata, and the dashboard link from the service's own
configuration — none of it visible to a block. Where the run paused is the
halt's, not the context's: only the block that raised it knows.

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

Who the comment greets. Either may be absent, and they are often the same.

#### Properties

##### assignee

> **assignee**: `LinearUser` \| `null`

##### creator

> **creator**: `LinearUser` \| `null`

## Variables

### checkForTicketHumanReply

> `const` **checkForTicketHumanReply**: `CheckForTicketHumanReply`

Look for a reply since the last check, excluding the run’s own question.

***

### renderNeedsHumanComment

> `const` **renderNeedsHumanComment**: [`RenderNeedsHumanComment`](#renderneedshumancomment)

Render the default human-input request as Linear Markdown.

***

### renderTicketNote

> `const` **renderTicketNote**: [`RenderTicketNote`](#renderticketnote)

Render the default non-blocking ticket note as Linear Markdown.

## Functions

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

### postTicketHumanInputRequest()

> **postTicketHumanInputRequest**(`issueId`, `halt`, `metadata`, `render`): `Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

Post a question or failure on the ticket so a person can help the run continue.

#### Parameters

##### issueId

`string`

##### halt

`Halt`

##### metadata

`NamedRunMetadata`

##### render

[`RenderNeedsHumanComment`](#renderneedshumancomment) = `renderNeedsHumanComment`

#### Returns

`Promise`\<\{ `commentId`: `string`; `postedAt`: `string`; \}\>

***

### postTicketNote()

> **postTicketNote**(`issueId`, `note`, `render`): `Promise`\<`void`\>

Tell ticket participants something the run decided, without waiting for a reply.

#### Parameters

##### issueId

`string`

##### note

`TicketNote`

##### render

[`RenderTicketNote`](#renderticketnote) = `renderTicketNote`

#### Returns

`Promise`\<`void`\>

***

### resolveLinearIssue()

> **resolveLinearIssue**(`reference`): `Promise`\<`LinearIssueRef`\>

Resolve a Linear identifier or issue ID before claiming or reading the ticket.

#### Parameters

##### reference

`string`

#### Returns

`Promise`\<`LinearIssueRef`\>

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
