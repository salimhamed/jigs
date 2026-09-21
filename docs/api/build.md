# @salimhamed/jigs v0.44.1

Generate and build the service files that host a factory.

## Variables

### GENERATED\_CLEANUP\_FILE

> `const` **GENERATED\_CLEANUP\_FILE**: `"automatic-release.ts"` = `"automatic-release.ts"`

Generated automatic-release plugin filename within the factory's `.jigs` directory.

***

### GENERATED\_DIR

> `const` **GENERATED\_DIR**: `".jigs"` = `".jigs"`

Where `prepare()` writes the generated sources, relative to the factory
 root. `nitro.ts` imports them to point its route and plugin at the same
 files.

***

### GENERATED\_ENTRY\_FILE

> `const` **GENERATED\_ENTRY\_FILE**: `"server.ts"` = `"server.ts"`

Generated Nitro route filename within the factory's `.jigs` directory.

***

### GENERATED\_SCHEDULES\_FILE

> `const` **GENERATED\_SCHEDULES\_FILE**: `"schedules.ts"` = `"schedules.ts"`

Generated schedule plugin filename within the factory's `.jigs` directory.

## Functions

### generateFactoryIntegration()

> **generateFactoryIntegration**(`factoryRoot`): `string`

Refresh only the generated integration; custom factory code lives elsewhere.

#### Parameters

##### factoryRoot

`string`

#### Returns

`string`

***

### prepare()

> **prepare**(`factoryRoot`): `string`

Writes everything a factory's Nitro build needs but does not keep in git,
under `<factoryRoot>/.jigs/`, and returns the entry's absolute path. The
file is rewritten in full, so running this twice is running it once.

#### Parameters

##### factoryRoot

`string`

#### Returns

`string`
