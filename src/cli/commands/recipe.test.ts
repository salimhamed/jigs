import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { initFactory } from "./init.ts";
import { addRecipe, recipeNames } from "./recipe.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function factory() {
  const cwd = mkdtempSync(path.join(tmpdir(), "jigs-recipe-"));
  roots.push(cwd);
  const lines: string[] = [];
  return { cwd, lines, out: (line: string) => lines.push(line) };
}

test("lists ship, installs its source and registers its workflow", async () => {
  const deps = factory();
  await initFactory(deps);
  deps.lines.length = 0;
  expect(recipeNames()).toContain("ship");
  expect(addRecipe("ship", deps).created).toEqual([
    "blocks/delivery/README.md",
    "blocks/delivery/approval.types.test.ts",
    "blocks/delivery/delivery.test.ts",
    "blocks/delivery/delivery.ts",
    "blocks/delivery/doc-examples.types.test.ts",
    "blocks/delivery/outputs.ts",
    "blocks/delivery/prompt-contexts.types.test.ts",
    "blocks/delivery/prompts.test.ts",
    "blocks/delivery/prompts.ts",
    "blocks/delivery/review.ts",
    "blocks/delivery/types.ts",
    "blocks/tickets/linear.ts",
    "workflows/ship.test.ts",
    "workflows/ship.ts",
  ]);
  expect(deps.lines.slice(-4)).toEqual([
    'registered ship in jigs.config.ts by adding ship: () => import("./workflows/ship.ts")',
    "",
    "next:",
    "  pnpm exec jigs up       # build and restart with ship; doctor lists what it still needs",
  ]);
  expect(readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8")).toContain(
    '  workflows: {\n    hello: () => import("./workflows/hello.ts"),\n    ship: () => import("./workflows/ship.ts"),\n  },',
  );
});

test("keeps edited files when a recipe is added again", async () => {
  const deps = factory();
  await initFactory(deps);
  addRecipe("ship", deps);
  writeFileSync(path.join(deps.cwd, "workflows/ship.ts"), "// factory customization\n");
  const config = readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8");
  const result = addRecipe("ship", deps);
  expect(result.created).toEqual([]);
  expect(deps.lines).toContain("ship is already registered in jigs.config.ts");
  expect(readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8")).toBe(config);
  expect(result.skipped).toHaveLength(14);
  expect(deps.lines).toContain("kept    workflows/ship.ts");
  expect(readFileSync(path.join(deps.cwd, "workflows/ship.ts"), "utf8")).toBe(
    "// factory customization\n",
  );
});

test("refuses a config it cannot edit, before copying, and gives the line to add", async () => {
  const deps = factory();
  writeFileSync(
    path.join(deps.cwd, "jigs.config.ts"),
    "const workflows = {};\nexport default { workflows };\n",
  );
  expect(() => addRecipe("ship", deps)).toThrow(
    expect.objectContaining({
      message: expect.stringContaining("Cannot register ship in jigs.config.ts"),
      hint: expect.stringContaining('ship: () => import("./workflows/ship.ts"),'),
    }),
  );
  expect(existsSync(path.join(deps.cwd, "workflows/ship.ts"))).toBe(false);
});

test("rejects unknown names and paths, and requires a factory root", () => {
  const deps = factory();
  expect(() => addRecipe("ship", deps)).toThrow("no jigs.config.ts");
  for (const name of ["unknown", "../templates", "ship/../ship"]) {
    expect(() => addRecipe(name, deps)).toThrow("unknown recipe");
  }
});
