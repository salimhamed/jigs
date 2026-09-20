# @salimhamed/jigs v0.40.1

Describe structured questions and JSON values exchanged with a human.

## Type Aliases

### HaltOption

> **HaltOption** = `z.infer`\<*typeof* [`haltOptionSchema`](#haltoptionschema)\>

***

### HaltQuestion

> **HaltQuestion** = `z.infer`\<*typeof* [`haltQuestionSchema`](#haltquestionschema)\>

***

### JsonValue

> **JsonValue** = `string` \| `number` \| `boolean` \| `null` \| [`JsonValue`](#jsonvalue)[] \| \{\[`key`: `string`\]: [`JsonValue`](#jsonvalue); \}

Interpolated into a prompt or a comment; never rendered as one.

## Variables

### haltOptionSchema

> `const` **haltOptionSchema**: `ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>

***

### haltQuestionSchema

> `const` **haltQuestionSchema**: `ZodObject`\<\{ `context`: `ZodOptional`\<`ZodString`\>; `options`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `label`: `ZodString`; `recommended`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strict`\>\>\>; `question`: `ZodString`; \}, `$strict`\>
