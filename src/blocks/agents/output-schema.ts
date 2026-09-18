// Workflow-side: the wire form of an output schema, and the reverse trip a
// reply takes before the zod parse. Pure — bundled into the workflow sandbox.

import { z } from "zod";

export type OutputJsonSchema = Record<string, unknown>;

// OpenAI's strict structured output accepts a subset of JSON Schema and
// rejects the schema outright for anything outside it. Dropping a constraint
// only weakens what the model is told: parseOutput still validates the reply
// against the original zod schema.
const UNSUPPORTED_KEYWORDS = new Set([
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "default",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "contentEncoding",
  "contentMediaType",
]);

// Values that are not themselves schemas and must survive the walk untouched.
const OPAQUE_KEYWORDS = new Set(["enum", "const", "required"]);

// Keywords holding a map of named subschemas rather than one subschema.
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  const branches = schema.anyOf ?? schema.oneOf;
  return Array.isArray(branches) && branches.some(allowsNull);
}

function nullable(schema: unknown): unknown {
  return allowsNull(schema) ? schema : { anyOf: [schema, { type: "null" }] };
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (!isRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(keyword)) continue;
    if (OPAQUE_KEYWORDS.has(keyword)) {
      out[keyword] = value;
    } else if (SCHEMA_MAPS.has(keyword) && isRecord(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, strictNode(sub)]),
      );
    } else {
      out[keyword] = strictNode(value);
    }
  }

  const properties = out.properties;
  if (isRecord(properties)) {
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) properties[name] = nullable(properties[name]);
    }
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

/**
 * The zod schema as JSON Schema a strict structured-output harness accepts:
 * every property required, the ones zod marks optional made nullable,
 * `additionalProperties: false` on every object, unsupported keywords gone.
 */
export function toOutputJsonSchema(output: z.ZodType): OutputJsonSchema {
  // The Claude CLI rejects zod's $schema meta-declaration outright ("no
  // schema with key or ref"); neither harness needs it.
  const { $schema: _dropped, ...schema } = z.toJSONSchema(output) as OutputJsonSchema;
  return strictNode(schema) as OutputJsonSchema;
}

function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}

function unwrap(schema: z.ZodType): z.ZodType {
  const inner = (schema.def as { innerType?: z.ZodType }).innerType;
  return inner === undefined ? schema : unwrap(inner);
}

/**
 * Undoes {@link toOutputJsonSchema}'s nullable rewrite: a `null` the model sent for
 * a property zod marks optional becomes `undefined`, so the field parses as
 * absent rather than as a type error.
 */
export function dropNullOptionals(schema: z.ZodType, value: unknown): unknown {
  if (value === null && !accepts(schema, null) && accepts(schema, undefined)) return undefined;

  const inner = unwrap(schema);
  const def = inner.def as {
    type: string;
    shape?: Record<string, z.ZodType>;
    element?: z.ZodType;
    valueType?: z.ZodType;
    options?: z.ZodType[];
  };

  switch (def.type) {
    case "object": {
      if (!isRecord(value) || def.shape === undefined) return value;
      const out: Record<string, unknown> = { ...value };
      for (const [key, field] of Object.entries(def.shape)) {
        if (!(key in out)) continue;
        const next = dropNullOptionals(field, out[key]);
        if (next === undefined) delete out[key];
        else out[key] = next;
      }
      return out;
    }
    case "array":
      return Array.isArray(value) && def.element !== undefined
        ? value.map((item) => dropNullOptionals(def.element as z.ZodType, item))
        : value;
    case "record": {
      if (!isRecord(value) || def.valueType === undefined) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          dropNullOptionals(def.valueType as z.ZodType, item),
        ]),
      );
    }
    case "union": {
      for (const option of def.options ?? []) {
        const next = dropNullOptionals(option, value);
        if (accepts(option, next)) return next;
      }
      return value;
    }
    default:
      return value;
  }
}
