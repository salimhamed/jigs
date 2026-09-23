# @jigs-ai/jigs v0.56.0

Start and inspect the recurring schedules declared by a factory.

## Interfaces

### ScheduleDeps

Injectable run operations and logging used by the schedule service.

#### Properties

##### listRuns()?

> `optional` **listRuns**: (`factory`) => `Promise`\<`RunRow`[]\>

###### Parameters

###### factory

`Factory`

###### Returns

`Promise`\<`RunRow`[]\>

##### log()?

> `optional` **log**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### startRun()?

> `optional` **startRun**: (`factory`, `workflowName`, `inputs`, `triggerId`) => `Promise`\<`StartRunResult`\>

###### Parameters

###### factory

`Factory`

###### workflowName

`string`

###### inputs

`unknown`

###### triggerId

`string`

###### Returns

`Promise`\<`StartRunResult`\>

***

### ScheduleView

Operator-facing state for one declared recurring schedule.

#### Properties

##### active

> **active**: `string` \| `null`

##### cron

> **cron**: `string`

##### name

> **name**: `string`

##### next

> **next**: `string` \| `null`

##### workflow

> **workflow**: `string`

## Functions

### fireSchedule()

> **fireSchedule**(`factory`, `name`, `schedule`, `deps`): `Promise`\<`void`\>

One fire: skip while a run of this schedule is still active, then trigger
the workflow like any other launch. Nothing here throws — a ticker
callback that rejects takes the service down with it.

#### Parameters

##### factory

`Factory`

##### name

`string`

##### schedule

`Schedule`

##### deps

[`ScheduleDeps`](#scheduledeps) = `{}`

#### Returns

`Promise`\<`void`\>

***

### listSchedules()

> **listSchedules**(`factory`, `deps`): `Promise`\<[`ScheduleView`](#scheduleview)[]\>

What `GET /api/schedules` answers with. `next` is recomputed from the
 pattern rather than read off a job, so it is the same answer whether the
 schedule is running here or was refused at startup.

#### Parameters

##### factory

`Factory`

##### deps

[`ScheduleDeps`](#scheduledeps) = `{}`

#### Returns

`Promise`\<[`ScheduleView`](#scheduleview)[]\>

***

### scheduleChecks()

> **scheduleChecks**(`factory`): `Check`[]

Doctor's half: the same three validations the ticker refuses on, one
 check per schedule.

#### Parameters

##### factory

`Factory`

#### Returns

`Check`[]

***

### startSchedules()

> **startSchedules**(`factory`, `deps`): `Cron`\<`undefined`\>[]

Starts a job per valid schedule and returns them. A malformed schedule is
logged with its repair and left unscheduled: the service still starts, and
`jigs doctor` reports the same failure on demand.

#### Parameters

##### factory

`Factory`

##### deps

[`ScheduleDeps`](#scheduledeps) = `{}`

#### Returns

`Cron`\<`undefined`\>[]
