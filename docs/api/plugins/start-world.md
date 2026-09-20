# @salimhamed/jigs v0.40.1

Start the Workflow runtime and the jigs services that depend on it.

## Interfaces

### BindingCloneGateDeps

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

#### Returns

`Promise`\<`void`\>

***

### fenceTerminalWorkflowDeliveries()

> **fenceTerminalWorkflowDeliveries**(`world`): `void`

#### Parameters

##### world

`ServiceWorld`

#### Returns

`void`

***

### gateOnBindingClones()

> **gateOnBindingClones**(`deps`): `Promise`\<`boolean`\>

#### Parameters

##### deps

[`BindingCloneGateDeps`](#bindingclonegatedeps) = `{}`

#### Returns

`Promise`\<`boolean`\>

***

### gateOnHarnessRuntimes()

> **gateOnHarnessRuntimes**(`deps`): `Promise`\<`boolean`\>

#### Parameters

##### deps

[`HarnessRuntimeGateDeps`](#harnessruntimegatedeps) = `{}`

#### Returns

`Promise`\<`boolean`\>

***

### gateOnWorktreeRegistry()

> **gateOnWorktreeRegistry**(`deps`): `Promise`\<`boolean`\>

#### Parameters

##### deps

[`RegistryGateDeps`](#registrygatedeps) = `{}`

#### Returns

`Promise`\<`boolean`\>

***

### gateOnWorldStart()

> **gateOnWorldStart**(`deps`): `Promise`\<`boolean`\>

#### Parameters

##### deps

[`WorldStartGateDeps`](#worldstartgatedeps)

#### Returns

`Promise`\<`boolean`\>
