# @jigs-ai/jigs v0.67.0

Everything a factory's configuration and workflows import from jigs: the factory and workflow
definitions, harness and model descriptors, the data steps hand back, question helpers, and
pure renderers.

Steps and routines come from your factory's generated `#jigs/steps` and `#jigs/routines`.

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

***

### JigsError

An operator-readable failure that is safe to construct inside a workflow.

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new JigsError**(`message`, `hint?`): [`JigsError`](#jigserror)

###### Parameters

###### message

`string`

###### hint?

`string`

###### Returns

[`JigsError`](#jigserror)

###### Overrides

`Error.constructor`

#### Properties

##### hint?

> `readonly` `optional` **hint**: `string`

## Interfaces

### AgentsDefinition

Settings for the agent harnesses this factory runs.

#### Properties

##### env?

> `optional` **env**: `string`[]

Names of service environment variables every agent harness also receives.
A harness otherwise starts with only a small base set, such as `PATH` and
`HOME`, and the variables its own driver needs. Model credentials and
the variables jigs sets itself are refused: name a model credential on
its model source instead.

***

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

### CheckRun

A check or commit status reported on a pull request head.

#### Properties

##### conclusion

> **conclusion**: `string` \| `null`

##### name

> **name**: `string`

##### url

> **url**: `string`

***

### Factory

What a factory repo hands the service: its workflows, keyed by name, and
the schedules that fire them. A schedule is keyed by its own name rather
than nested under a workflow — the name is what runs, status and `jigs
doctor` refer to, and one workflow can carry several.

#### Properties

##### schedules?

> `optional` **schedules**: `Record`\<`string`, [`Schedule`](#schedule)\>

##### webhooks?

> `optional` **webhooks**: `object`

Which provider webhook routes the service mounts. Absent, it mounts none.

###### github

> **github**: `object` = `webhookProviderSchema`

###### github.enabled

> **enabled**: `boolean`

###### linear

> **linear**: `object` = `webhookProviderSchema`

###### linear.enabled

> **enabled**: `boolean`

###### url

> **url**: `string`

##### workflows

> **workflows**: `Record`\<`string`, `AnyWorkflowDefinition`\>

***

### FactoryDefinition

Operating settings and deferred workflow modules declared by a factory.

#### Properties

##### agents?

> `optional` **agents**: [`AgentsDefinition`](#agentsdefinition)

##### bindings?

> `optional` **bindings**: `Record`\<`string`, \{ `copy?`: `string`[]; `hookTimeoutMinutes?`: `number`; `mergeMethod?`: `"squash"` \| `"merge"` \| `"rebase"`; `postCreate?`: `string`[]; `remote`: `string`; \}\>

##### github?

> `optional` **github**: `object`

###### identities?

> `optional` **identities**: (\{ `mode`: `"pat"`; \} \| \{ `appId`: `number`; `coAuthor?`: `string`; `installations`: `Record`\<`string`, `number`\>; `mode`: `"app"`; `operator`: `string`; `privateKeyPath`: `string`; \})[]

###### mergeApproval?

> `optional` **mergeApproval**: `"review"` \| `"label"`

How the operator approves a pull request for merging. Defaults to `label` with a personal
access token and to `review` with a GitHub App.

##### linear?

> `optional` **linear**: `object`

###### identity?

> `optional` **identity**: \{ `mode`: `"key"`; \} \| \{ `mode`: `"app"`; \}

##### release?

> `optional` **release**: `object`

###### onFailure

> **onFailure**: `"release"` \| `"keep"`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

> **onSuccess**: `"release"` \| `"keep"`

What to do with eligible resources after a completed run.

##### schedules?

> `optional` **schedules**: `Record`\<`string`, [`Schedule`](#schedule)\>

##### service

> **service**: `object`

###### dashboardPort

> **dashboardPort**: `number`

###### pollIntervalSeconds?

> `optional` **pollIntervalSeconds**: `object`

Seconds between the service's re-reads of each parked run, per
provider. Each defaults to 300 and may not go below 30. Up to a tenth
of the interval is taken off at random so services do not all poll at
once.

###### pollIntervalSeconds.github?

> `optional` **github**: `number`

###### pollIntervalSeconds.linear?

> `optional` **linear**: `number`

###### port?

> `optional` **port**: `number`

##### webhooks?

> `optional` **webhooks**: `object`

###### github

> **github**: `object` = `webhookProviderSchema`

###### github.enabled

> **enabled**: `boolean`

###### linear

> **linear**: `object` = `webhookProviderSchema`

###### linear.enabled

> **enabled**: `boolean`

###### url

> **url**: `string`

##### workflows

> **workflows**: `Record`\<`string`, () => `Promise`\<\{ `default`: `AnyWorkflowDefinition`; \}\>\>

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

***

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

### PullRequestApproval

The factory's approval signal and how it reads on the pull request.

#### Properties

##### signal

> **signal**: `"review"` \| `"label"`

`review` is an approving review of the head; `label` is the `jigs:approved` label.

##### state

> **state**: [`ApprovalState`](#approvalstate)

***

### PullRequestComment

A comment on the pull request conversation, which hangs off no thread.

#### Properties

##### body

> **body**: `string`

##### createdAt

> **createdAt**: `string`

##### id

> **id**: `number`

##### updatedAt

> **updatedAt**: `string`

##### user

> **user**: `string`

##### userType

> **userType**: `string`

***

### PullRequestMarker

Hidden progress metadata stored in a pull request comment.

#### Properties

##### kind

> **kind**: `MarkerKind`

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

### PullRequestReview

A submitted GitHub review of a pull request.

#### Properties

##### body

> **body**: `string`

##### commitSha?

> `optional` **commitSha**: `string`

##### id

> **id**: `number`

##### state

> **state**: `string`

##### submittedAt

> **submittedAt**: `string`

##### user

> **user**: `string`

***

### PullRequestSnapshot

GitHub facts about a pull request, without a judgment about outstanding work.

#### Properties

##### approval

> **approval**: [`PullRequestApproval`](#pullrequestapproval)

The operator's consent, read the way this factory's `github.mergeApproval` asks for it.

##### ci

> **ci**: `"red"` \| `"green"` \| `"pending"` \| `"none"`

`none`: no check or status has reported on this head yet. It is never green.

##### conversationComments

> **conversationComments**: [`PullRequestComment`](#pullrequestcomment)[]

##### draft

> **draft**: `boolean`

##### failingChecks

> **failingChecks**: [`CheckRun`](#checkrun)[]

##### headSha

> **headSha**: `string`

##### labels

> **labels**: `string`[]

Label names on the pull request; the `label` approval signal reads these.

##### mergeCommitSha

> **mergeCommitSha**: `string` \| `null`

The merge commit, once GitHub has made one.

##### merged

> **merged**: `boolean`

##### mergeState

> **mergeState**: `string`

GitHub's own verdict on whether the pull request can merge right now,
folding in conflicts, required checks and required reviews. `"clean"` is
the only value that permits a merge; `"unknown"` means GitHub has not
finished computing it, so the answer is "not yet, ask again".

##### reviews

> **reviews**: [`PullRequestReview`](#pullrequestreview)[]

##### reviewThreads

> **reviewThreads**: [`ReviewThread`](#reviewthread)[]

##### state

> **state**: `"open"` \| `"closed"`

***

### ReleaseReport

The result of applying a release policy to one run's managed resources.

#### Properties

##### policy

> **policy**: `object`

The policy applied by this release attempt.

###### onFailure

> **onFailure**: `"release"` \| `"keep"`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

> **onSuccess**: `"release"` \| `"keep"`

What to do with eligible resources after a completed run.

##### runDirectory

> **runDirectory**: `ReleasedResource`

The scratch directory's local path, removal flag and reason for the result.

##### worktrees

> **worktrees**: `ReleasedResource` & `object`[]

Results for the run's worktrees, including paths, branches, removal flags, unmerged commit
counts and reasons for anything retained.

***

### ReviewComment

A comment anchored to a file in a pull request review.

#### Properties

##### body

> **body**: `string`

##### createdAt

> **createdAt**: `string`

##### id

> **id**: `number`

##### line

> **line**: `number` \| `null`

##### path

> **path**: `string`

##### rootId

> **rootId**: `number`

##### updatedAt

> **updatedAt**: `string`

##### user

> **user**: `string`

***

### ReviewThread

A pull request review conversation, with its optional file location.

#### Properties

##### comments

> **comments**: [`ReviewComment`](#reviewcomment)[]

##### line

> **line**: `number` \| `null`

##### origin?

> `optional` **origin**: `"conversation"`

##### path

> **path**: `string`

##### rootId

> **rootId**: `number`

***

### RunResource

A durable thing that a run created or otherwise owns a reference to.

#### Properties

##### identity

> **identity**: `string`

The stable name that distinguishes this resource from others of the same kind.

##### kind

> **kind**: `string`

The resource category, such as `worktree` or `run-directory`.

##### url

> **url**: `string`

An absolute URL where a human can inspect the resource.

***

### Schedule

One recurring trigger: a workflow, when to fire it, and the inputs to
 fire it with.

#### Properties

##### cron

> **cron**: `string`

Five fields, evaluated in the service host's local time zone.

##### inputs

> **inputs**: `Record`\<`string`, `unknown`\>

##### workflow

> **workflow**: `string`

***

### ThreadAnswers

Answers routed back to pull-request threads and an optional commit explanation.

#### Properties

##### answers

> **answers**: `object`[]

Replies to post, using `null` to answer feedback on the pull request conversation.

###### body

> **body**: `string`

The Markdown reply body.

###### threadId

> **threadId**: `number` \| `null`

The review thread root to answer, or `null` for conversation feedback.

##### commitExplanation

> **commitExplanation**: `string` \| `null`

A note explaining the pushed commit, or `null` when no explanation should be posted.

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

***

### WorkflowDefinition

A workflow: its function, its input schema, and what a run needs before it
may start.

#### Type Parameters

##### S

`S` *extends* `z.ZodType` = `z.ZodType`

#### Properties

##### inputs

> **inputs**: `S`

##### release?

> `optional` **release**: `object`

###### onFailure

> **onFailure**: `"release"` \| `"keep"`

What to do with eligible resources after a failed or cancelled run.

###### onSuccess

> **onSuccess**: `"release"` \| `"keep"`

What to do with eligible resources after a completed run.

##### requires?

> `optional` **requires**: `WorkflowRequires`

What the workflow needs before a run can start: the agents it runs, the
integrations, bindings and API model sources it uses. The service checks
the CLI of every agent's harness when it starts, and preflight checks
everything listed before every run. List only what the workflow uses.

###### Example

```ts
const agents = {
  builder: harnesses.claude({ model: "opus" }),
  reviewer: harnesses.codex({ model: "gpt-5.6-sol" }),
};

export default defineWorkflow({
  inputs,
  requires: { agents, integrations: ["linear", "github"] },
  workflow: shipTicket,
});
```

##### workflow()

> **workflow**: (`inputs`) => `Promise`\<`unknown`\>

###### Parameters

###### inputs

[`WorkflowInputs`](#workflowinputs)\<`S`\>

###### Returns

`Promise`\<`unknown`\>

***

### Worktree

A provisioned repository worktree and the commit it was cut from.

#### Properties

##### baseSha

> **baseSha**: `string`

##### binding

> **binding**: `string`

The named repository binding in the factory configuration.

##### branch

> **branch**: `string`

##### defaultBranch

> **defaultBranch**: `string`

##### path

> **path**: `string`

## Type Aliases

### AgentResult

> **AgentResult**\<`T`\> = [`ModelResult`](#modelresult)\<`T`\> & `object`

A model result with the session reference an agent harness returned, when it returned one.

#### Type Declaration

##### session?

> `optional` **session**: [`AgentSessionRef`](#agentsessionref)

#### Type Parameters

##### T

`T` = `unknown`

***

### AgentSessionRef

> **AgentSessionRef** = `object`

A session reference: the small piece of data that lets a later `runAgent` call resume the same
harness session. Pass it back as `resume`.

#### Properties

##### descriptor

> **descriptor**: `string`

The harness descriptor the session was recorded on, as [describeHarness](#describeharness) renders it.

##### harness

> **harness**: [`Harness`](#harness-2)\[`"kind"`\]

##### id

> **id**: `string`

***

### ApprovalState

> **ApprovalState** = `"approved"` \| `"changes-requested"` \| `"stale"` \| `"none"`

How the operator's consent reads right now. `stale` is an approval that
named an earlier commit — a different thing to tell an operator than a pull
request nobody has approved.

***

### AskableHarness

> **AskableHarness** = [`ClaudeHarness`](#claudeharness) & [`ToolFree`](#toolfree) \| [`PiHarness`](#piharness) & [`ToolFree`](#toolfree)

A harness `askAgent` can run with no tools: Claude Code or Pi, without MCP
servers or a Pi tool allowlist. Codex has no mode without tools.

***

### AskableModelSource

> **AskableModelSource** = `Exclude`\<[`ModelSource`](#modelsource), [`OpenaiCodexSource`](#openaicodexsource)\>

A model source accepted by a direct model call.

***

### AskAgentOptions

> **AskAgentOptions**\<`T`\> = `object`

Options for one harness turn without tools or a worktree.

#### Type Parameters

##### T

`T` = `undefined`

#### Properties

##### harness

> **harness**: [`AskableHarness`](#askableharness)

##### output?

> `optional` **output**: `z.ZodType`\<`T`\>

##### prompt

> **prompt**: `string`

##### system?

> `optional` **system**: `string`

***

### AskJevOptions

> **AskJevOptions**\<`QUESTIONS`\> = `object`

A decision request in workflow and durable wire form.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* [`JevQuestions`](#jevquestions)

#### Properties

##### model

> **model**: [`OpenrouterSource`](#openroutersource)

##### questions

> **questions**: `QUESTIONS`

##### state

> **state**: [`JevState`](#jevstate)

***

### AskModelOptions

> **AskModelOptions**\<`T`\> = `object`

Options for one API model call.

#### Type Parameters

##### T

`T` = `undefined`

#### Properties

##### model

> **model**: [`AskableModelSource`](#askablemodelsource)

##### output?

> `optional` **output**: `z.ZodType`\<`T`\>

##### prompt

> **prompt**: `string`

##### system?

> `optional` **system**: `string`

***

### BindingDefinition

> **BindingDefinition** = `z.input`\<*typeof* `bindingSchema`\>

A repository this factory works in: its remote, how a worktree cut from it
is provisioned, and the merge method jigs uses there.

#### Example

```ts
bindings: {
  api: {
    remote: "git@github.com:acme/api.git",
    postCreate: ["pnpm install"],
    mergeMethod: "rebase",
  },
},
```

***

### ChangeStatus

> **ChangeStatus** = `"added"` \| `"modified"` \| `"deleted"` \| `"renamed"` \| `"other"`

How a file differs between the base and head trees.

***

### ChoiceQuestion

> **ChoiceQuestion**\<`OPTIONS`\> = `object`

A question answered with one named option.

#### Type Parameters

##### OPTIONS

`OPTIONS` *extends* `Record`\<`string`, `string`\> = `Record`\<`string`, `string`\>

#### Properties

##### instructions

> **instructions**: `string`

##### options

> **options**: `OPTIONS`

##### type

> **type**: `"choice"`

***

### ClaudeHarness

> **ClaudeHarness** = [`JsonOnly`](#jsononly)\<`Omit`\<`ClaudeCodeSettings`, [`ClaudePolicyKey`](#claudepolicykey)\>\> & `object`

A Claude Code harness descriptor: the provider's own settings that are data, minus each
[ClaudePolicyKey](#claudepolicykey), plus the model and jigs' MCP server shape.

#### Type Declaration

##### kind

> **kind**: `"claude"`

##### mcpServers?

> `optional` **mcpServers**: `Record`\<`string`, [`McpServerConfig`](#mcpserverconfig)\>

##### model

> **model**: `string`

***

### ClaudeHarnessSettings

> **ClaudeHarnessSettings** = `Omit`\<[`ClaudeHarness`](#claudeharness), `"kind"`\>

The one argument `harnesses.claude` takes: the model and any Claude Code settings.

***

### ClaudePolicyKey

> **ClaudePolicyKey** = *typeof* `claudePolicyKeys`\[`number`\]

A Claude Code setting a descriptor cannot name, because jigs sets it itself or holds it as
policy.

#### Remarks

jigs sets the working directory, environment, executable and session for every step, and holds
permissions, setting sources and MCP servers as policy. `extraArgs` and `sdkOptions` would
rewrite any of those. `agents`, `settings` and `plugins` would bring in unprobed MCP servers,
environment, permissions and hooks from outside the worktree; they come from the repository's
project settings instead.

***

### CodexHarness

> **CodexHarness** = [`JsonOnly`](#jsononly)\<`Omit`\<`CodexAppServerSettings`, [`CodexPolicyKey`](#codexpolicykey)\>\> & `object`

A Codex harness descriptor: the provider's own settings that are data, minus each
[CodexPolicyKey](#codexpolicykey), plus the model and jigs' MCP server shape.

#### Type Declaration

##### kind

> **kind**: `"codex"`

##### mcpServers?

> `optional` **mcpServers**: `Record`\<`string`, [`McpServerConfig`](#mcpserverconfig)\>

##### model

> **model**: `string`

***

### CodexHarnessSettings

> **CodexHarnessSettings** = `Omit`\<[`CodexHarness`](#codexharness), `"kind"`\>

The one argument `harnesses.codex` takes: the model and any Codex settings.

***

### CodexPolicyKey

> **CodexPolicyKey** = *typeof* `codexPolicyKeys`\[`number`\]

A Codex setting a descriptor cannot name, because jigs sets it itself or holds it as policy.

#### Remarks

jigs sets the working directory, environment, executable, thread and session for every step,
and holds the approval and sandbox policies and MCP servers. `configOverrides` would rewrite
the sandbox and MCP tables.

***

### GitHubDefinition

> **GitHubDefinition** = `z.input`\<*typeof* `githubSchema`\>

Who jigs is on GitHub, the operator's own token or a GitHub App installation, and how the
operator approves a pull request for merging.

#### Remarks

`mergeApproval` defaults to `label` with a token and to `review` with an App. A token cannot use
`review`: jigs opens pull requests as the operator, and GitHub does not let the author approve
their own pull request.

#### Example

```ts
github: { identities: [{ mode: "pat" }], mergeApproval: "label" },
```

***

### Halt

> **Halt** = `object`

What the ticket comment says, in the words a stranger to the repo reads.
`headline` is one plain sentence naming what jigs paused and why, `where`
names the routine it paused in so the footer can say so, `about` restates the
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

> `optional` **questions**: [`HaltQuestion`](#haltquestion)[]

##### where

> **where**: `string`

***

### HaltOption

> **HaltOption** = `z.infer`\<*typeof* [`haltOptionSchema`](#haltoptionschema)\>

One answer choice for a question shown to a human.

***

### HaltQuestion

> **HaltQuestion** = `z.infer`\<*typeof* [`haltQuestionSchema`](#haltquestionschema)\>

A question shown to a human while a run waits for their reply.

***

### Harness

> **Harness** = [`ClaudeHarness`](#claudeharness) \| [`CodexHarness`](#codexharness) \| [`PiHarness`](#piharness)

A serializable agent-program descriptor.

***

### HarnessForOptions

> **HarnessForOptions**\<`H`, `O`\> = \[`Extract`\<keyof `O`, keyof [`ToolFree`](#toolfree)\>\] *extends* \[`never`\] ? `H` & [`ToolFree`](#toolfree) : `H`

The descriptor a harness constructor returns for its options. It is also
[ToolFree](#toolfree), so `askAgent` accepts it, when the options name no tools
or MCP servers.

#### Type Parameters

##### H

`H`

##### O

`O`

***

### HarnessKind

> **HarnessKind** = [`Harness`](#harness-2)\[`"kind"`\]

The stable name of an agent harness.

***

### JevAnswer

> **JevAnswer**\<`QUESTION`\> = `QUESTION` *extends* [`ChoiceQuestion`](#choicequestion)\<infer OPTIONS\> ? `object` : `QUESTION` *extends* [`ScoreQuestion`](#scorequestion) ? `object` : `object`

The calibrated answer shape selected by one question descriptor.

#### Type Parameters

##### QUESTION

`QUESTION` *extends* [`JevQuestion`](#jevquestion)

***

### JevAnswers

> **JevAnswers**\<`QUESTIONS`\> = `{ [KEY in keyof QUESTIONS]: JevAnswer<QUESTIONS[KEY]> }`

Answers narrowed independently for every named question.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* [`JevQuestions`](#jevquestions)

***

### JevQuestion

> **JevQuestion** = [`YesNoQuestion`](#yesnoquestion) \| [`ChoiceQuestion`](#choicequestion) \| [`ScoreQuestion`](#scorequestion)

Any question accepted by `askJev`.

***

### JevQuestions

> **JevQuestions** = `Record`\<`string`, [`JevQuestion`](#jevquestion)\>

Named decision questions evaluated against one shared state.

***

### JevResult

> **JevResult**\<`QUESTIONS`\> = `object`

A typed decision result.

#### Type Parameters

##### QUESTIONS

`QUESTIONS` *extends* [`JevQuestions`](#jevquestions)

#### Properties

##### answers

> **answers**: [`JevAnswers`](#jevanswers)\<`QUESTIONS`\>

***

### JevState

> **JevState** = `string` \| `JevJsonObject` \| `JevJsonValue`[]

JSON-compatible evidence evaluated by a decision model.

***

### JsonOnly

> **JsonOnly**\<`T`\> = `{ [K in keyof T as false extends IsData<Exclude<T[K], undefined>> ? never : K]: T[K] }`

The keys of a settings type whose values are data, so they can cross into a step.

#### Type Parameters

##### T

`T`

***

### JsonValue

> **JsonValue** = `string` \| `number` \| `boolean` \| `null` \| [`JsonValue`](#jsonvalue)[] \| \{\[`key`: `string`\]: [`JsonValue`](#jsonvalue); \}

A value that can be serialized as JSON and embedded in a prompt or comment.

***

### LinearDefinition

> **LinearDefinition** = `z.input`\<*typeof* `linearSchema`\>

Who jigs is on Linear: `key` acts as the user whose `LINEAR_API_KEY` is in
`.env`, `app` acts as a Linear OAuth application from `LINEAR_CLIENT_ID` and
`LINEAR_CLIENT_SECRET`. Defaults to `key`.

#### Example

```ts
linear: { identity: { mode: "app" } },
```

***

### McpHttpServerConfig

> **McpHttpServerConfig** = `object`

Configuration for an MCP server reached over HTTP.

#### Properties

##### headers?

> `optional` **headers**: `Record`\<`string`, `string`\>

##### probe

> **probe**: [`McpToolProbe`](#mcptoolprobe)

##### url

> **url**: `string`

***

### McpServerConfig

> **McpServerConfig** = [`McpStdioServerConfig`](#mcpstdioserverconfig) \| [`McpHttpServerConfig`](#mcphttpserverconfig)

An MCP server an agent harness can expose to the model.

***

### McpStdioServerConfig

> **McpStdioServerConfig** = `object`

Configuration for an MCP server launched as a child process.

#### Properties

##### args?

> `optional` **args**: `string`[]

##### command

> **command**: `string`

##### env?

> `optional` **env**: `Record`\<`string`, `string`\>

##### probe

> **probe**: [`McpToolProbe`](#mcptoolprobe)

***

### McpToolProbe

> **McpToolProbe** = `object`

A harmless MCP tool call used to prove that a configured server is available.

#### Properties

##### arguments?

> `optional` **arguments**: `Record`\<`string`, `unknown`\>

##### tool

> **tool**: `string`

***

### ModelKind

> **ModelKind** = [`ModelSource`](#modelsource)\[`"kind"`\]

The stable name of a model source.

***

### ModelResult

> **ModelResult**\<`T`\> = `object`

Text and structured output returned by a model call.

#### Type Parameters

##### T

`T` = `unknown`

#### Properties

##### output

> **output**: `T`

##### text

> **text**: `string`

***

### ModelSource

> **ModelSource** = [`OpenrouterSource`](#openroutersource) \| [`OpenaiCompatibleSource`](#openaicompatiblesource) \| [`OpenaiCodexSource`](#openaicodexsource)

Any configured source from which a model can answer.

***

### OpenaiCodexSource

> **OpenaiCodexSource** = `object`

The Codex subscription model source used only by the Pi harness.

#### Properties

##### kind

> **kind**: `"openai-codex"`

##### model

> **model**: `string`

***

### OpenaiCompatibleSource

> **OpenaiCompatibleSource** = `object`

An OpenAI-compatible API model source.

#### Properties

##### apiKeyEnv?

> `optional` **apiKeyEnv**: `string`

##### baseUrl

> **baseUrl**: `string`

##### kind

> **kind**: `"openai-compatible"`

##### model

> **model**: `string`

##### name

> **name**: `string`

***

### OpenrouterSource

> **OpenrouterSource** = `object`

An OpenRouter API model source.

#### Properties

##### apiKeyEnv

> **apiKeyEnv**: `string`

##### kind

> **kind**: `"openrouter"`

##### model

> **model**: `string`

***

### OutputJsonSchema

> **OutputJsonSchema** = `Record`\<`string`, `unknown`\>

The serializable JSON Schema sent across the workflow-step boundary.

***

### PiHarness

> **PiHarness** = [`PiOpenaiCompatibleHarness`](#piopenaicompatibleharness) \| [`PiOtherHarness`](#piotherharness)

A Pi harness descriptor backed by a nested model source.

***

### PiHarnessOptions

> **PiHarnessOptions** = `Pick`\<[`PiHarness`](#piharness), `"thinking"` \| `"tools"` \| `"mcpServers"`\> & `object`

Options for `harnesses.pi`. `compat` applies only to an OpenAI-compatible
model source.

#### Type Declaration

##### compat?

> `optional` **compat**: `Partial`\<[`PiOpenaiCompatibleOptions`](#piopenaicompatibleoptions)\>

***

### PiMcpHttpServerConfig

> **PiMcpHttpServerConfig** = `Omit`\<[`McpHttpServerConfig`](#mcphttpserverconfig), `"headers"`\> & `object` & \{ `auth`: `"oauth"`; `bearerTokenEnv?`: `never`; \} \| \{ `auth?`: `false`; `bearerTokenEnv?`: `never`; \} \| \{ `auth?`: `never`; `bearerTokenEnv`: `string`; \}

An HTTP MCP server Pi exposes through an explicit direct-tool allowlist.

#### Type Declaration

##### headers?

> `optional` **headers**: `Record`\<`string`, `string`\>

Maps HTTP header names to step-side source environment variable names.

##### tools

> **tools**: `string`[]

Raw MCP tool names the model may call. This must include the probe tool.

***

### PiMcpServerConfig

> **PiMcpServerConfig** = [`PiMcpStdioServerConfig`](#pimcpstdioserverconfig) \| [`PiMcpHttpServerConfig`](#pimcphttpserverconfig)

An explicitly configured MCP server accepted by the Pi harness.

***

### PiMcpStdioServerConfig

> **PiMcpStdioServerConfig** = `Omit`\<[`McpStdioServerConfig`](#mcpstdioserverconfig), `"env"`\> & `object`

A stdio MCP server Pi exposes through an explicit direct-tool allowlist.

#### Type Declaration

##### env?

> `optional` **env**: `Record`\<`string`, `string`\>

Maps child variable names to step-side source environment variable names.

##### tools

> **tools**: `string`[]

Raw MCP tool names the model may call. This must include the probe tool.

***

### PiOpenaiCompatibleHarness

> **PiOpenaiCompatibleHarness** = `SharedPiHarness` & `object`

A Pi harness descriptor backed by an OpenAI-compatible source, with its compatibility hints.

#### Type Declaration

##### compat

> **compat**: [`PiOpenaiCompatibleOptions`](#piopenaicompatibleoptions)

##### model

> **model**: [`OpenaiCompatibleSource`](#openaicompatiblesource)

***

### PiOpenaiCompatibleOptions

> **PiOpenaiCompatibleOptions** = `object`

Pi-specific compatibility hints for an OpenAI-compatible model.

#### Properties

##### supportsDeveloperRole

> **supportsDeveloperRole**: `boolean`

##### supportsReasoningEffort

> **supportsReasoningEffort**: `boolean`

***

### PiOtherHarness

> **PiOtherHarness** = `SharedPiHarness` & `object`

A Pi harness descriptor backed by any source other than an OpenAI-compatible one.

#### Type Declaration

##### compat?

> `optional` **compat**: `never`

##### model

> **model**: `Exclude`\<[`ModelSource`](#modelsource), [`OpenaiCompatibleSource`](#openaicompatiblesource)\>

***

### PullRequestRef

> **PullRequestRef** = `object`

Identifies a pull request by repository owner, repository name and number.

#### Properties

##### number

> **number**: `number`

The repository-local pull request number.

##### owner

> **owner**: `string`

The GitHub organization or account that owns the repository.

##### repo

> **repo**: `string`

The repository name.

***

### PullRequestWake

> **PullRequestWake** = \{ `headSha`: `string`; `kind`: `"merge-ready"`; `retryNoted`: `boolean`; \} \| \{ `body?`: `string`; `kind`: `"review-comments"`; `threads`: [`ReviewThread`](#reviewthread)[]; \} \| \{ `failing`: [`CheckRun`](#checkrun)[]; `headSha`: `string`; `kind`: `"ci-red"`; `mentionLogin`: `string` \| `null`; \} \| \{ `kind`: `"closed"`; `merged`: `boolean`; \}

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

#### Type Declaration

\{ `headSha`: `string`; `kind`: `"merge-ready"`; `retryNoted`: `boolean`; \}

##### headSha

> **headSha**: `string`

The reviewed commit that the merge must still target.

##### kind

> **kind**: `"merge-ready"`

Identifies a pull request that is ready for an attempted merge.

##### retryNoted

> **retryNoted**: `boolean`

Whether a transient refusal for this commit was already reported.

\{ `body?`: `string`; `kind`: `"review-comments"`; `threads`: [`ReviewThread`](#reviewthread)[]; \}

##### body?

> `optional` **body**: `string`

The changes-requested review summary, when the feedback included one.

##### kind

> **kind**: `"review-comments"`

Identifies unanswered review feedback.

##### threads

> **threads**: [`ReviewThread`](#reviewthread)[]

Inline and conversation threads that still need answers.

\{ `failing`: [`CheckRun`](#checkrun)[]; `headSha`: `string`; `kind`: `"ci-red"`; `mentionLogin`: `string` \| `null`; \}

##### failing

> **failing**: [`CheckRun`](#checkrun)[]

Failed checks reported by the provider.

##### headSha

> **headSha**: `string`

The commit whose checks failed.

##### kind

> **kind**: `"ci-red"`

Identifies a failed build on the current commit.

##### mentionLogin

> **mentionLogin**: `string` \| `null`

The most recent human reviewer to notify when repair cannot continue.

\{ `kind`: `"closed"`; `merged`: `boolean`; \}

##### kind

> **kind**: `"closed"`

Identifies a terminal, closed pull request.

##### merged

> **merged**: `boolean`

Whether the pull request closed by merging.

***

### RebuildContextPrompt()

> **RebuildContextPrompt** = (`input`) => `string`

Renders instructions for rebuilding an agent's working context.

#### Parameters

##### input

[`RebuildContextPromptInput`](#rebuildcontextpromptinput)

#### Returns

`string`

***

### RebuildContextPromptInput

> **RebuildContextPromptInput** = `object`

Material a fresh agent needs to continue work after a session cannot resume.

#### Properties

##### brief

> **brief**: `string`

##### diff

> **diff**: `string`

##### threads

> **threads**: `string`

##### ticket

> **ticket**: `string`

***

### ReleasePolicy

> **ReleasePolicy** = `z.input`\<*typeof* `releaseSchema`\>

Selects whether eligible run resources are released for each terminal outcome.

***

### RunAgentOptions

> **RunAgentOptions**\<`T`\> = `object`

Options for an agent that works inside a directory.

#### Type Parameters

##### T

`T` = `undefined`

#### Properties

##### cwd

> **cwd**: `string`

##### harness

> **harness**: [`Harness`](#harness-2)

##### output?

> `optional` **output**: `z.ZodType`\<`T`\>

##### prompt

> **prompt**: `string`

##### resume?

> `optional` **resume**: [`AgentSessionRef`](#agentsessionref)

The session reference of an earlier run to continue.

***

### ScoreQuestion

> **ScoreQuestion** = `object`

A question scored over ordered levels, from lowest to highest.

#### Properties

##### instructions

> **instructions**: `string`

##### levels

> **levels**: `string`[]

##### type

> **type**: `"score"`

***

### StatusReason

> **StatusReason** = `"merge"` \| `"ci"` \| `"merge-retry"`

Why a `status` note was written, so one note never silences another.
`merge` and `ci` stand a commit down; `merge-retry` only records that the
refusal was already reported, and leaves the commit merge-ready.

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

***

### TicketWorkflowInputs

> **TicketWorkflowInputs**\<`S`\> = [`WorkflowInputs`](#workflowinputs)\<`S`\>

Ticket references are ordinary inputs; resolve them explicitly in a step.

#### Type Parameters

##### S

`S` *extends* `z.ZodType`\<\{ `ticket`: `string`; \}\>

***

### ToolFree

> **ToolFree** = `object`

Marks a descriptor that names no tools or MCP servers.

#### Properties

##### mcpServers?

> `optional` **mcpServers**: `never`

##### tools?

> `optional` **tools**: `never`

***

### WebhooksDefinition

> **WebhooksDefinition** = `z.input`\<*typeof* `webhooksSchema`\>

Where provider webhooks reach the service, and which providers send them.
Without this section the service still wakes parked runs by polling.

#### Example

```ts
webhooks: {
  url: "https://factory.example.ts.net",
  github: { enabled: true },
  linear: { enabled: false },
},
```

***

### WorkflowInputs

> **WorkflowInputs**\<`S`\> = `z.output`\<`S`\> & `Injected`

Parsed workflow inputs with the trigger that started the run.

#### Type Parameters

##### S

`S` *extends* `z.ZodType`

***

### YesNoQuestion

> **YesNoQuestion** = `object`

A calibrated yes-or-no question.

#### Properties

##### instructions

> **instructions**: `string`

##### type

> **type**: `"yes-no"`

## Variables

### haltOptionSchema

> `const` **haltOptionSchema**: `ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>

Validates an answer choice with a nonempty label and an optional recommendation marker.

***

### haltQuestionSchema

> `const` **haltQuestionSchema**: `ZodObject`\<\{ `context`: `ZodOptional`\<`ZodString`\>; `options`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>\>\>; `question`: `ZodString`; \}, `$strict`\>

Validates a question with nonempty text, optional context and optional suggested answers.

***

### harnesses

> `const` **harnesses**: `object`

Constructors for agent-harness descriptors.

#### Type Declaration

##### claude()

> `readonly` **claude**: \<`O`\>(`settings`) => [`HarnessForOptions`](#harnessforoptions)\<[`ClaudeHarness`](#claudeharness), `O`\> = `claudeHarness`

Build a Claude Code harness from the model and any Claude Code settings. Without `tools` or
`mcpServers` it also works with `askAgent`.

###### Type Parameters

###### O

`O` *extends* [`ClaudeHarnessSettings`](#claudeharnesssettings)

###### Parameters

###### settings

`Exactly`\<[`ClaudeHarnessSettings`](#claudeharnesssettings), `O`\>

###### Returns

[`HarnessForOptions`](#harnessforoptions)\<[`ClaudeHarness`](#claudeharness), `O`\>

###### Example

```ts
harnesses.claude({ model: "opus", effort: "high", maxTurns: 40 });
```

##### codex()

> `readonly` **codex**: \<`O`\>(`settings`) => [`CodexHarness`](#codexharness) = `codexHarness`

Build a Codex harness from the model and any Codex settings. Only `runAgent` accepts it: Codex
has no mode without tools.

###### Type Parameters

###### O

`O` *extends* [`CodexHarnessSettings`](#codexharnesssettings)

###### Parameters

###### settings

`Exactly`\<[`CodexHarnessSettings`](#codexharnesssettings), `O`\>

###### Returns

[`CodexHarness`](#codexharness)

###### Example

```ts
harnesses.codex({ model: "gpt-5.6-sol", personality: "pragmatic" });
```

##### pi()

> `readonly` **pi**: \{\<`O`\>(`model`, `options?`): [`HarnessForOptions`](#harnessforoptions)\<[`PiOpenaiCompatibleHarness`](#piopenaicompatibleharness), `O`\>; \<`O`\>(`model`, `options?`): [`HarnessForOptions`](#harnessforoptions)\<[`PiOtherHarness`](#piotherharness), `O`\>; \<`M`, `O`\>(`model`, `options?`): [`HarnessForOptions`](#harnessforoptions)\<[`PiHarness`](#piharness), `O`\>; \} = `piHarness`

###### Call Signature

> \<`O`\>(`model`, `options?`): [`HarnessForOptions`](#harnessforoptions)\<[`PiOpenaiCompatibleHarness`](#piopenaicompatibleharness), `O`\>

Build a Pi harness around a model source. `compat` applies only to an
OpenAI-compatible source; each hint omitted from it defaults to `false`.
Without `tools` or `mcpServers` the harness also works with `askAgent`.

###### Type Parameters

###### O

`O` *extends* [`PiHarnessOptions`](#piharnessoptions) = `Record`\<`never`, `never`\>

###### Parameters

###### model

[`OpenaiCompatibleSource`](#openaicompatiblesource)

###### options?

`O`

###### Returns

[`HarnessForOptions`](#harnessforoptions)\<[`PiOpenaiCompatibleHarness`](#piopenaicompatibleharness), `O`\>

###### Call Signature

> \<`O`\>(`model`, `options?`): [`HarnessForOptions`](#harnessforoptions)\<[`PiOtherHarness`](#piotherharness), `O`\>

Build a Pi harness around a model source. `compat` applies only to an
OpenAI-compatible source; each hint omitted from it defaults to `false`.
Without `tools` or `mcpServers` the harness also works with `askAgent`.

###### Type Parameters

###### O

`O` *extends* `Omit`\<[`PiHarnessOptions`](#piharnessoptions), `"compat"`\> = `Record`\<`never`, `never`\>

###### Parameters

###### model

[`OpenrouterSource`](#openroutersource) | [`OpenaiCodexSource`](#openaicodexsource)

###### options?

`O`

###### Returns

[`HarnessForOptions`](#harnessforoptions)\<[`PiOtherHarness`](#piotherharness), `O`\>

###### Call Signature

> \<`M`, `O`\>(`model`, `options?`): [`HarnessForOptions`](#harnessforoptions)\<[`PiHarness`](#piharness), `O`\>

Build a Pi harness around a model source. `compat` applies only to an
OpenAI-compatible source; each hint omitted from it defaults to `false`.
Without `tools` or `mcpServers` the harness also works with `askAgent`.

###### Type Parameters

###### M

`M` *extends* [`ModelSource`](#modelsource)

###### O

`O` *extends* `Omit`\<[`PiHarnessOptions`](#piharnessoptions), `"compat"`\> & `object` = `Record`\<`never`, `never`\>

###### Parameters

###### model

`M`

###### options?

`O`

###### Returns

[`HarnessForOptions`](#harnessforoptions)\<[`PiHarness`](#piharness), `O`\>

***

### harnessKinds

> `const` **harnessKinds**: \[`"claude"` \| `"codex"` \| `"pi"`, ...("claude" \| "codex" \| "pi")\[\]\]

Every harness kind this release of jigs can build, taken from the keys of
`harnesses`. Use it for a workflow input that names a harness, so a new kind
appears without editing the input.

#### Example

```ts
const inputs = z.object({ harness: z.enum(harnessKinds) });
```

***

### models

> `const` **models**: `object`

Constructors for model-source descriptors.

#### Type Declaration

##### openaiCodex()

> `readonly` **openaiCodex**(`model`): [`OpenaiCodexSource`](#openaicodexsource)

Build a source that runs through the Codex subscription Pi is logged in
to. Only `harnesses.pi` accepts it.

###### Parameters

###### model

`string`

###### Returns

[`OpenaiCodexSource`](#openaicodexsource)

##### openaiCompatible()

> `readonly` **openaiCompatible**(`options`): [`OpenaiCompatibleSource`](#openaicompatiblesource)

Build a source for an OpenAI-compatible server.

###### Parameters

###### options

###### apiKeyEnv?

`string`

###### baseUrl

`string`

###### model

`string`

###### name

`string`

###### Returns

[`OpenaiCompatibleSource`](#openaicompatiblesource)

##### openrouter()

> `readonly` **openrouter**(`model`, `options`): [`OpenrouterSource`](#openroutersource)

Build an OpenRouter source. Its key is read from `OPENROUTER_API_KEY`
unless `apiKeyEnv` names another variable.

###### Parameters

###### model

`string`

###### options

###### apiKeyEnv?

`string`

###### Returns

[`OpenrouterSource`](#openroutersource)

***

### rebuildContextPrompt

> `const` **rebuildContextPrompt**: [`RebuildContextPrompt`](#rebuildcontextprompt)

The default prompt for continuing reviewed work in a fresh agent session.

***

### ticketInputSchema

> `const` **ticketInputSchema**: `ZodUnion`\<readonly \[`ZodUUID`, `ZodString`\]\>

Accept a Linear issue UUID or an uppercase team-and-number ticket identifier.

***

### ticketReviewPrompt

> `const` **ticketReviewPrompt**: [`TicketReviewPrompt`](#ticketreviewprompt)

The default prompt for reviewing a Linear ticket before implementation begins.

***

### ticketReviewVerdictSchema

> `const` **ticketReviewVerdictSchema**: `ZodObject`\<\{ `about`: `ZodString`; `assumptions`: `ZodArray`\<`ZodString`\>; `brief`: `ZodString`; `questions`: `ZodArray`\<`ZodObject`\<\{ `context`: `ZodOptional`\<`ZodString`\>; `options`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>\>\>; `question`: `ZodString`; \}, `$strict`\>\>; `verdict`: `ZodEnum`\<\{ `needs-human`: `"needs-human"`; `proceed`: `"proceed"`; \}\>; \}, `$strict`\>

Structured verdict returned by the agent that reviews a ticket before work starts.

## Functions

### choice()

> **choice**\<`OPTIONS`\>(`instructions`, `options`): [`ChoiceQuestion`](#choicequestion)\<`OPTIONS`\>

Build a question answered with one named option.

#### Type Parameters

##### OPTIONS

`OPTIONS` *extends* `Record`\<`string`, `string`\>

#### Parameters

##### instructions

`string`

##### options

`OPTIONS`

#### Returns

[`ChoiceQuestion`](#choicequestion)\<`OPTIONS`\>

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

### defineFactory()

> **defineFactory**\<`T`\>(`factory`): `T`

Preserve the declaration's inferred keys without loading its workflows.

#### Type Parameters

##### T

`T` *extends* [`FactoryDefinition`](#factorydefinition)

#### Parameters

##### factory

`T`

#### Returns

`T`

***

### defineWorkflow()

> **defineWorkflow**\<`S`\>(`definition`): [`WorkflowDefinition`](#workflowdefinition)\<`S`\>

Declare a workflow as the default export of its file. It returns the
definition unchanged; it exists so TypeScript checks the workflow's
parameter against the input schema.

#### Type Parameters

##### S

`S` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

#### Parameters

##### definition

[`WorkflowDefinition`](#workflowdefinition)\<`S`\>

#### Returns

[`WorkflowDefinition`](#workflowdefinition)\<`S`\>

#### Example

```ts
const inputs = z.object({ binding: z.string() });

export async function hello(input: WorkflowInputs<typeof inputs>) {
  "use workflow";
  // ...
}

export default defineWorkflow({ inputs, workflow: hello });
```

***

### describeHarness()

> **describeHarness**(`harness`): `string`

A harness descriptor as a string that ignores field order: two descriptors that list the same
settings in another order render the same.

#### Parameters

##### harness

[`Harness`](#harness-2)

#### Returns

`string`

***

### interpolate()

> **interpolate**(`template`, `values`): `string`

Replace named `{{ placeholders }}` once, leaving unknown names unchanged.

#### Parameters

##### template

`string`

##### values

`Record`\<`string`, `string`\>

#### Returns

`string`

***

### isPullRequestMergeReady()

> **isPullRequestMergeReady**(`snapshot`): `boolean`

Whether current GitHub facts satisfy the configured approval and merge requirements.

#### Parameters

##### snapshot

[`PullRequestSnapshot`](#pullrequestsnapshot)

#### Returns

`boolean`

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

### pullRequestSnapshotKey()

> **pullRequestSnapshotKey**(`snapshot`): `string`

A comparison key for the facts in a pull request snapshot.

#### Parameters

##### snapshot

[`PullRequestSnapshot`](#pullrequestsnapshot)

#### Returns

`string`

#### Remarks

Collection ordering and incidental fields do not change the key. Compare keys for equality;
the key format is opaque and is not a durable identifier.

***

### renderChangeSummary()

> **renderChangeSummary**(`summary`): `string`

Render a Markdown review summary with commits, totals and up to 60 changed-file rows.

#### Parameters

##### summary

[`ChangeSummary`](#changesummary)

#### Returns

`string`

***

### renderChecks()

> **renderChecks**(`failing`): `string`

Render failed checks as a Markdown list for a pull request note.

#### Parameters

##### failing

[`CheckRun`](#checkrun)[]

#### Returns

`string`

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

### score()

> **score**(`instructions`, `levels`): [`ScoreQuestion`](#scorequestion)

Build a question scored over ordered levels, from lowest to highest.

#### Parameters

##### instructions

`string`

##### levels

`string`[]

#### Returns

[`ScoreQuestion`](#scorequestion)

***

### unreachable()

> **unreachable**(`value`): `never`

Fail an exhaustive branch if an unexpected value reaches it at runtime.

#### Parameters

##### value

`never`

#### Returns

`never`

***

### yesNo()

> **yesNo**(`instructions`): [`YesNoQuestion`](#yesnoquestion)

Build a calibrated yes-or-no question.

#### Parameters

##### instructions

`string`

#### Returns

[`YesNoQuestion`](#yesnoquestion)

## Factory plumbing

### JitCheckError

A failed just-in-time tool check, with repair details for each failure.

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new JitCheckError**(`failures`): [`JitCheckError`](#jitcheckerror)

###### Parameters

###### failures

`object` & `object`[]

###### Returns

[`JitCheckError`](#jitcheckerror)

###### Overrides

`Error.constructor`

#### Properties

##### failures

> `readonly` **failures**: `object` & `object`[]

***

### AgentRequest

> **AgentRequest** = `Omit`\<[`RunAgentOptions`](#runagentoptions), `"output"`\> & `object` \| `Omit`\<[`AskAgentOptions`](#askagentoptions), `"output"`\> & `object`

Serializable agent request passed to a durable step.

***

### ModelRequest

> **ModelRequest** = `Omit`\<[`AskModelOptions`](#askmodeloptions), `"output"`\> & `object`

Serializable API model request passed to a durable step.

#### Type Declaration

##### outputSchema?

> `optional` **outputSchema**: [`OutputJsonSchema`](#outputjsonschema)

***

### unwrapAgentStep()

> **unwrapAgentStep**(`result`): [`AgentResult`](#agentresult)

Convert returned execution failure markers into errors the workflow throws.

#### Parameters

##### result

[`AgentResult`](#agentresult) | \{ `jitFailure`: `object` & `object`[]; \} | \{ `resumeFailed`: `string`; \}

#### Returns

[`AgentResult`](#agentresult)
