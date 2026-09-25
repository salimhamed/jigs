# @jigs-ai/jigs v0.59.0

Define a factory and describe its workflows, schedules, bindings and merge policy.

Import this module from factory configuration and workflow code that needs the shared
factory types.

## Classes

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

> `optional` **bindings**: `Record`\<`string`, \{ `copy?`: `string`[]; `hookTimeoutMinutes?`: `number`; `merge?`: \{ `by?`: `"jigs"` \| `"human"`; `method?`: `"squash"` \| `"merge"` \| `"rebase"`; \}; `postCreate?`: `string`[]; `remote`: `string`; \}\>

##### github?

> `optional` **github**: `object`

###### identities?

> `optional` **identities**: (\{ `mode`: `"pat"`; \} \| \{ `appId`: `number`; `coAuthor?`: `string`; `installations`: `Record`\<`string`, `number`\>; `mode`: `"app"`; `operator`: `string`; `privateKeyPath`: `string`; \})[]

##### linear?

> `optional` **linear**: `object`

###### identity?

> `optional` **identity**: \{ `mode`: `"key"`; \} \| \{ `mode`: `"app"`; \}

##### merge?

> `optional` **merge**: `object`

###### approval?

> `optional` **approval**: \{ `kind`: `"review"`; \} \| \{ `kind`: `"label"`; `name`: `string`; \}

The signal that authorizes an automatic merge.

###### Type Declaration

\{ `kind`: `"review"`; \}

\{ `kind`: `"label"`; `name`: `string`; \}

###### by?

> `optional` **by**: `"jigs"` \| `"human"`

Whether jigs merges an eligible pull request or waits for a person to merge it.

###### method?

> `optional` **method**: `"squash"` \| `"merge"` \| `"rebase"`

The GitHub merge method to use when jigs performs the merge.

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

### ReviewThread

A pull request review conversation, with its optional file location.

#### Properties

##### comments

> **comments**: `ReviewComment`[]

##### line

> **line**: `number` \| `null`

##### origin?

> `optional` **origin**: `"conversation"`

##### path

> **path**: `string`

##### rootId

> **rootId**: `number`

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
  builder: harnesses.claude("opus"),
  reviewer: harnesses.codex("gpt-5.6-sol"),
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

##### branch

> **branch**: `string`

##### defaultBranch

> **defaultBranch**: `string`

##### path

> **path**: `string`

## Type Aliases

### BindingDefinition

> **BindingDefinition** = `z.input`\<*typeof* `bindingSchema`\>

A repository this factory works in: its remote, how a worktree cut from it
is provisioned, and any merge settings that differ from the factory's.

#### Example

```ts
bindings: {
  api: {
    remote: "git@github.com:acme/api.git",
    postCreate: ["pnpm install"],
    merge: { by: "jigs", method: "rebase" },
  },
},
```

***

### GitHubDefinition

> **GitHubDefinition** = `z.input`\<*typeof* `githubSchema`\>

Who jigs is on GitHub: the operator's own token, or a GitHub App installation.

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

### MergeDefinition

> **MergeDefinition** = `z.input`\<*typeof* `mergePolicySchema`\>

Who merges, by which of GitHub's three methods, and what signal permits it.

***

### TicketWorkflowInputs

> **TicketWorkflowInputs**\<`S`\> = [`WorkflowInputs`](#workflowinputs)\<`S`\>

Ticket references are ordinary inputs; resolve them explicitly in a step.

#### Type Parameters

##### S

`S` *extends* `z.ZodType`\<\{ `ticket`: `string`; \}\>

***

### WebhooksDefinition

> **WebhooksDefinition** = `z.input`\<*typeof* `webhooksSchema`\>

Where provider webhooks reach the service, and which providers send them.
Without this block the service still wakes parked runs by polling.

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

## Variables

### ticketInputSchema

> `const` **ticketInputSchema**: `ZodUnion`\<readonly \[`ZodUUID`, `ZodString`\]\>

Accept a Linear issue UUID or an uppercase team-and-number ticket identifier.

## Functions

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
