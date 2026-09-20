# @salimhamed/jigs v0.40.2

Start the Workflow runtime and the jigs services that depend on it.

## Interfaces

### BindingCloneGateDeps

Injectable binding operations and output used by the clone startup gate.

#### Properties

##### bindings()?

> `optional` **bindings**: () => `BindingClone`[]

###### Returns

`BindingClone`[]

##### ensure()?

> `optional` **ensure**: (`options`) => `Promise`\<`void`\>

###### Parameters

###### options

###### remote

`string`

###### repoDir

`string`

###### Returns

`Promise`\<`void`\>

##### error()?

> `optional` **error**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### exit()?

> `optional` **exit**: (`code`) => `void`

###### Parameters

###### code

`number`

###### Returns

`void`

##### log()?

> `optional` **log**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

***

### HarnessRuntimeGateDeps

Injectable runtime checks and output used by the harness startup gate.

#### Properties

##### error()?

> `optional` **error**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### exit()?

> `optional` **exit**: (`code`) => `void`

###### Parameters

###### code

`number`

###### Returns

`void`

##### log()?

> `optional` **log**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### runtimes()?

> `optional` **runtimes**: () => `Promise`\<`HarnessRuntime`[]\>

###### Returns

`Promise`\<`HarnessRuntime`[]\>

***

### RegistryGateDeps

Injectable database operations and output used by the registry startup gate.

#### Properties

##### ensure()?

> `optional` **ensure**: (`sql`) => `Promise`\<`void`\>

###### Parameters

###### sql

`RegistrySql`

###### Returns

`Promise`\<`void`\>

##### error()?

> `optional` **error**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### exit()?

> `optional` **exit**: (`code`) => `void`

###### Parameters

###### code

`number`

###### Returns

`void`

##### log()?

> `optional` **log**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### sql()?

> `optional` **sql**: () => `RegistrySql`

###### Returns

`RegistrySql`

***

### WorldStartGateDeps

Workflow World operations used by the final service startup gate.

#### Properties

##### error()?

> `optional` **error**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### exit()?

> `optional` **exit**: (`code`) => `void`

###### Parameters

###### code

`number`

###### Returns

`void`

##### getWorld()

> **getWorld**: () => `Promise`\<`ServiceWorld`\>

###### Returns

`Promise`\<`ServiceWorld`\>

##### own()

> **own**: (`world`) => `void`

###### Parameters

###### world

`ServiceWorld`

###### Returns

`void`

## Functions

### default()

> **default**(): `Promise`\<`void`\>

Run the ordered service startup gates, then enable readiness and reconciliation.

#### Returns

`Promise`\<`void`\>

***

### fenceTerminalWorkflowDeliveries()

> **fenceTerminalWorkflowDeliveries**(`world`): `void`

Prevent queued step deliveries from entering runs that are already terminal.

#### Parameters

##### world

`ServiceWorld`

#### Returns

`void`

***

### gateOnBindingClones()

> **gateOnBindingClones**(`deps`): `Promise`\<`boolean`\>

Ensure every configured repository binding has a usable local clone.

#### Parameters

##### deps

[`BindingCloneGateDeps`](#bindingclonegatedeps) = `{}`

#### Returns

`Promise`\<`boolean`\>

***

### gateOnHarnessRuntimes()

> **gateOnHarnessRuntimes**(`deps`): `Promise`\<`boolean`\>

Refuse service startup when a required agent harness is unavailable.

#### Parameters

##### deps

[`HarnessRuntimeGateDeps`](#harnessruntimegatedeps) = `{}`

#### Returns

`Promise`\<`boolean`\>

***

### gateOnWorktreeRegistry()

> **gateOnWorktreeRegistry**(`deps`): `Promise`\<`boolean`\>

Refuse service startup when the worktree registry cannot be prepared.

#### Parameters

##### deps

[`RegistryGateDeps`](#registrygatedeps) = `{}`

#### Returns

`Promise`\<`boolean`\>

***

### gateOnWorldStart()

> **gateOnWorldStart**(`deps`): `Promise`\<`boolean`\>

Start and take ownership of the Workflow World, exiting cleanly on failure.

#### Parameters

##### deps

[`WorldStartGateDeps`](#worldstartgatedeps)

#### Returns

`Promise`\<`boolean`\>
