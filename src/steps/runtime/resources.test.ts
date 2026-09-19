import { expect, test } from "vitest";
import { resourcesFromAttributes } from "../../blocks/runtime/resources.ts";
import type { JigsError } from "../../errors.ts";
import { registerResourceWith } from "./resources.ts";

const pr = (number: number, url = `https://github.com/acme/api/pull/${number}`) => ({
  kind: "pull-request",
  identity: `acme/api#${number}`,
  url,
});

function memoryRegistration(initial: Record<string, string> = {}) {
  let attributes = { ...initial };
  let writes = 0;
  return {
    deps: {
      readAttributes: async () => ({ ...attributes }),
      writeAttribute: async (key: string, value: string) => {
        writes += 1;
        // The Postgres World applies each one-key change to the current JSONB
        // object atomically. This fake preserves that same merge property.
        attributes = { ...attributes, [key]: value };
      },
    },
    attributes: () => attributes,
    writes: () => writes,
  };
}

test("a retry of the same resource is idempotent", async () => {
  const memory = memoryRegistration();
  await registerResourceWith(pr(1), memory.deps);
  await registerResourceWith(pr(1), memory.deps);
  expect(memory.writes()).toBe(1);
  expect(resourcesFromAttributes(memory.attributes())).toEqual([pr(1)]);
});

test("a same-identity registration updates its URL in place", async () => {
  const memory = memoryRegistration();
  await registerResourceWith(pr(1), memory.deps);
  const moved = pr(1, "https://example.test/reviews/acme-api-1");
  await registerResourceWith(moved, memory.deps);
  expect(Object.keys(memory.attributes())).toHaveLength(1);
  expect(resourcesFromAttributes(memory.attributes())).toEqual([moved]);
});

test("simultaneous distinct registrations preserve both resources", async () => {
  const memory = memoryRegistration();
  await Promise.all([
    registerResourceWith(pr(1), memory.deps),
    registerResourceWith(pr(2), memory.deps),
  ]);
  expect(resourcesFromAttributes(memory.attributes())).toEqual([pr(1), pr(2)]);
});

test("capacity errors account for unrelated and reserved attributes", async () => {
  const occupied = Object.fromEntries(
    Array.from({ length: 62 }, (_, index) => [`user-${index}`, "x"]),
  );
  const memory = memoryRegistration({
    ...occupied,
    $parentRunId: "wrun_parent",
    $rootRunId: "wrun_root",
  });
  let failure: unknown;
  try {
    await registerResourceWith(pr(1), memory.deps);
  } catch (error) {
    failure = error;
  }
  expect((failure as JigsError).message).toContain("64/64 attributes");
  expect((failure as JigsError).message).toContain("0 jigs resources, 2 other reserved, 62 user");
  expect((failure as JigsError).hint).toContain("retry registration separately");
  expect(memory.writes()).toBe(0);
});

test("an existing identity can update while all 64 keys are occupied", async () => {
  const memory = memoryRegistration();
  await registerResourceWith(pr(1), memory.deps);
  const attributes = memory.attributes();
  for (let index = 0; index < 63; index += 1) attributes[`other-${index}`] = "x";

  const moved = pr(1, "https://example.test/new-location");
  await registerResourceWith(moved, memory.deps);
  expect(Object.keys(memory.attributes())).toHaveLength(64);
  expect(resourcesFromAttributes(memory.attributes())).toEqual([moved]);
});

test("a failure after commit is recovered by reading the registered value", async () => {
  const memory = memoryRegistration();
  memory.deps.writeAttribute = async (key, value) => {
    memory.attributes()[key] = value;
    throw new Error("connection dropped after commit");
  };
  await expect(registerResourceWith(pr(1), memory.deps)).resolves.toEqual(pr(1));
  expect(resourcesFromAttributes(memory.attributes())).toEqual([pr(1)]);
});

test("a registration failure says to retry without recreating the resource", async () => {
  const memory = memoryRegistration();
  memory.deps.writeAttribute = async () => {
    throw new Error("database unavailable");
  };
  await expect(registerResourceWith(pr(1), memory.deps)).rejects.toMatchObject({
    message: expect.stringContaining("database unavailable"),
    hint: expect.stringContaining("resource may already exist"),
  });
});
