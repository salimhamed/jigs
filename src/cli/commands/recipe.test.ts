import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("lists ship and installs its source, reporting manual registration", async () => {
  const deps = factory();
  await initFactory(deps);
  deps.lines.length = 0;
  const config = readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8");
  expect(recipeNames()).toContain("ship");
  expect(addRecipe("ship", deps).created).toEqual([
    "blocks/tickets/linear.ts",
    "workflows/ship.test.ts",
    "workflows/ship.ts",
  ]);
  expect(deps.lines).toContain('  ship: () => import("./workflows/ship.ts"),');
  expect(deps.lines).toContain("created workflows/ship.ts");
  expect(readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8")).toBe(config);
});

test("keeps edited files when a recipe is added again", async () => {
  const deps = factory();
  await initFactory(deps);
  addRecipe("ship", deps);
  writeFileSync(path.join(deps.cwd, "workflows/ship.ts"), "// factory customization\n");
  const result = addRecipe("ship", deps);
  expect(result.created).toEqual([]);
  expect(result.skipped).toHaveLength(3);
  expect(deps.lines).toContain("kept    workflows/ship.ts");
  expect(readFileSync(path.join(deps.cwd, "workflows/ship.ts"), "utf8")).toBe(
    "// factory customization\n",
  );
});

test("rejects unknown names and paths, and requires a factory root", () => {
  const deps = factory();
  expect(() => addRecipe("ship", deps)).toThrow("no jigs.config.ts");
  for (const name of ["unknown", "../templates", "ship/../ship"]) {
    expect(() => addRecipe(name, deps)).toThrow("unknown recipe");
  }
});
