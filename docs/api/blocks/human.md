# @salimhamed/jigs v0.50.0

Use these schemas and types for provider-neutral questions and JSON values exchanged with a human.

## Type Aliases

### HaltOption

> **HaltOption** = `z.infer`\<*typeof* [`haltOptionSchema`](#haltoptionschema)\>

One answer choice for a question shown to a human.

***

### HaltQuestion

> **HaltQuestion** = `z.infer`\<*typeof* [`haltQuestionSchema`](#haltquestionschema)\>

A question shown to a human while a run waits for their reply.

***

### JsonValue

> **JsonValue** = `string` \| `number` \| `boolean` \| `null` \| [`JsonValue`](#jsonvalue)[] \| \{\[`key`: `string`\]: [`JsonValue`](#jsonvalue); \}

A value that can be serialized as JSON and embedded in a prompt or comment.

## Variables

### haltOptionSchema

> `const` **haltOptionSchema**: `ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>

Validates an answer choice with a nonempty label and an optional recommendation marker.

***

### haltQuestionSchema

> `const` **haltQuestionSchema**: `ZodObject`\<\{ `context`: `ZodOptional`\<`ZodString`\>; `options`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>\>\>; `question`: `ZodString`; \}, `$strict`\>

Validates a question with nonempty text, optional context and optional suggested answers.
