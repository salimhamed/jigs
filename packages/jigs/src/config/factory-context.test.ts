import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { removeTmpDir, useTestFactory } from "../test-fixtures.ts";
import { parseFactoryConfig } from "../workflow/factory-schema.ts";
import { currentFactoryContext, seedFactoryContext } from "./factory-context.ts";

let parent: string;

beforeEach(() => {
  parent = useTestFactory({
    hub: { url: "https://hub.example.test" },
  });
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("jigs.factory-context")];
  vi.unstubAllEnvs();
  removeTmpDir(parent);
});

test("a seeded context answers with the built configuration and never reads jigs.config.ts", () => {
  const root = currentFactoryContext().root;
  seedFactoryContext(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      github: { operator: "built" },
      workflows: {},
    }),
  );
  writeFileSync(path.join(root, "jigs.config.ts"), 'throw new Error("read from disk");\n');

  const ctx = currentFactoryContext();
  expect(ctx.root).toBe(root);
  expect(ctx.config.github.operator).toBe("built");
});

test("a seeded context outlives a change of working factory", () => {
  seedFactoryContext(
    parseFactoryConfig({
      hub: { url: "https://hub.example.test" },
      workflows: {},
    }),
  );
  const seeded = currentFactoryContext();
  vi.spyOn(process, "cwd").mockReturnValue(path.join(parent, "elsewhere"));

  expect(currentFactoryContext()).toBe(seeded);
});
