import { expect, test } from "vitest";
import { z } from "zod";
import { ticketReviewVerdictSchema } from "../linear/review.ts";
import { dropNullOptionals, toOutputJsonSchema } from "./output-schema.ts";

const shape = z.object({
  note: z.string().optional(),
  mood: z.enum(["good", "bad"]),
  owner: z.string().nullable(),
  email: z.email().optional(),
  items: z.array(
    z.object({
      label: z.string().min(1),
      hint: z.string().optional(),
    }),
  ),
});

// Every object in the emitted schema, wherever it sits.
function objects(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(objects);
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  const nested = Object.entries(record)
    .filter(([keyword]) => keyword !== "enum" && keyword !== "required")
    .flatMap(([, value]) => objects(value));
  return record.properties !== undefined ? [record, ...nested] : nested;
}

function at(node: unknown, path: string): Record<string, unknown> {
  return path
    .split(".")
    .reduce<Record<string, unknown>>(
      (current, key) => current[key] as Record<string, unknown>,
      node as Record<string, unknown>,
    );
}

function isNullable(schema: unknown): boolean {
  const branches = (schema as { anyOf?: { type?: string }[] }).anyOf;
  return Array.isArray(branches) && branches.some((branch) => branch.type === "null");
}

test("every object lists all its properties as required and forbids extras", () => {
  const wire = toOutputJsonSchema(shape);
  const found = objects(wire);
  expect(found).toHaveLength(2);
  for (const object of found) {
    expect(object.required).toEqual(Object.keys(object.properties as object));
    expect(object.additionalProperties).toBe(false);
  }
});

test("optional properties become nullable at every level", () => {
  const wire = toOutputJsonSchema(shape);
  expect(isNullable(at(wire, "properties.note"))).toBe(true);
  expect(isNullable(at(wire, "properties.email"))).toBe(true);
  expect(isNullable(at(wire, "properties.mood"))).toBe(false);
  const item = at(wire, "properties.items.items.properties");
  expect(isNullable(item.hint)).toBe(true);
  expect(isNullable(item.label)).toBe(false);
});

test("an already-nullable property is not wrapped twice", () => {
  const owner = at(toOutputJsonSchema(shape), "properties.owner");
  expect(owner.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
});

test("keywords strict mode rejects are stripped", () => {
  const serialized = JSON.stringify(toOutputJsonSchema(shape));
  for (const keyword of ["format", "pattern", "minLength", "maxLength", "default"]) {
    expect(serialized).not.toContain(`"${keyword}"`);
  }
});

test("the enum's values survive the strict rewrite", () => {
  const mood = at(toOutputJsonSchema(shape), "properties.mood");
  expect(mood.enum).toEqual(["good", "bad"]);
});

test("the ticket-review verdict converts to a strict-valid schema", () => {
  const wire = toOutputJsonSchema(ticketReviewVerdictSchema);
  const option = at(wire, "properties.questions.items.properties.options.anyOf.0.items");
  expect(option.required).toEqual(["label", "recommended"]);
  expect(option.additionalProperties).toBe(false);
  expect(isNullable((option.properties as Record<string, unknown>).recommended)).toBe(true);
  for (const object of objects(wire)) {
    expect(object.required).toEqual(Object.keys(object.properties as object));
    expect(object.additionalProperties).toBe(false);
  }
});

test("a null the model sent for an optional field parses back as absent", () => {
  const reply = {
    verdict: "proceed",
    brief: "ship it",
    about: "the ticket",
    questions: [
      {
        question: "which runner?",
        context: null,
        options: [
          { label: "ci", recommended: true },
          { label: "local", recommended: null },
        ],
      },
    ],
    assumptions: [],
  };
  const parsed = ticketReviewVerdictSchema.parse(
    dropNullOptionals(ticketReviewVerdictSchema, reply),
  );
  const [question] = parsed.questions;
  expect(question?.context).toBeUndefined();
  expect(question && "context" in question).toBe(false);
  expect(question?.options?.[1]).toEqual({ label: "local" });
  expect(question?.options?.[0]?.recommended).toBe(true);
});

test("a null for a genuinely nullable field is left alone", () => {
  expect(dropNullOptionals(shape, { mood: "good", owner: null, items: [] })).toMatchObject({
    owner: null,
  });
});
