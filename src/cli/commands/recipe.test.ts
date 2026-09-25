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

test("lists linear-ticket-to-pr, installs its source and registers its workflow", async () => {
  const deps = factory();
  await initFactory(deps);
  deps.lines.length = 0;
  expect(recipeNames()).toContain("linear-ticket-to-pr");
  expect(addRecipe("linear-ticket-to-pr", deps).created).toEqual([
    "workflows/linear-ticket-to-pr.test.ts",
    "workflows/linear-ticket-to-pr.ts",
    "workflows/linear-ticket-to-pr/delivery/README.md",
    "workflows/linear-ticket-to-pr/delivery/approval.types.test.ts",
    "workflows/linear-ticket-to-pr/delivery/delivery.test.ts",
    "workflows/linear-ticket-to-pr/delivery/delivery.ts",
    "workflows/linear-ticket-to-pr/delivery/doc-examples.types.test.ts",
    "workflows/linear-ticket-to-pr/delivery/outputs.ts",
    "workflows/linear-ticket-to-pr/delivery/prompt-contexts.types.test.ts",
    "workflows/linear-ticket-to-pr/delivery/prompts.test.ts",
    "workflows/linear-ticket-to-pr/delivery/prompts.ts",
    "workflows/linear-ticket-to-pr/delivery/review.ts",
    "workflows/linear-ticket-to-pr/delivery/types.ts",
    "workflows/linear-ticket-to-pr/tickets/linear.ts",
  ]);
  expect(deps.lines.slice(-4)).toEqual([
    'registered linear-ticket-to-pr in jigs.config.ts by adding "linear-ticket-to-pr": () => import("./workflows/linear-ticket-to-pr.ts")',
    "",
    "next:",
    "  pnpm exec jigs up       # build and restart with linear-ticket-to-pr; doctor lists what it still needs",
  ]);
  expect(readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8")).toContain(
    '  workflows: {\n    hello: () => import("./workflows/hello/hello.ts"),\n    "linear-ticket-to-pr": () => import("./workflows/linear-ticket-to-pr.ts"),\n  },',
  );
});

test("keeps edited files when a recipe is added again", async () => {
  const deps = factory();
  await initFactory(deps);
  addRecipe("linear-ticket-to-pr", deps);
  writeFileSync(
    path.join(deps.cwd, "workflows/linear-ticket-to-pr.ts"),
    "// factory customization\n",
  );
  const config = readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8");
  const result = addRecipe("linear-ticket-to-pr", deps);
  expect(result.created).toEqual([]);
  expect(deps.lines).toContain("linear-ticket-to-pr is already registered in jigs.config.ts");
  expect(readFileSync(path.join(deps.cwd, "jigs.config.ts"), "utf8")).toBe(config);
  expect(result.skipped).toHaveLength(14);
  expect(deps.lines).toContain("kept    workflows/linear-ticket-to-pr.ts");
  expect(readFileSync(path.join(deps.cwd, "workflows/linear-ticket-to-pr.ts"), "utf8")).toBe(
    "// factory customization\n",
  );
});

test("refuses a config it cannot edit, before copying, and gives the line to add", async () => {
  const deps = factory();
  writeFileSync(
    path.join(deps.cwd, "jigs.config.ts"),
    "const workflows = {};\nexport default { workflows };\n",
  );
  expect(() => addRecipe("linear-ticket-to-pr", deps)).toThrow(
    expect.objectContaining({
      message: expect.stringContaining("Cannot register linear-ticket-to-pr in jigs.config.ts"),
      hint: expect.stringContaining(
        '"linear-ticket-to-pr": () => import("./workflows/linear-ticket-to-pr.ts"),',
      ),
    }),
  );
  expect(existsSync(path.join(deps.cwd, "workflows/linear-ticket-to-pr.ts"))).toBe(false);
});

test("rejects unknown names and paths, and requires a factory root", () => {
  const deps = factory();
  expect(() => addRecipe("linear-ticket-to-pr", deps)).toThrow("no jigs.config.ts");
  for (const name of ["unknown", "../templates", "linear-ticket-to-pr/../linear-ticket-to-pr"]) {
    expect(() => addRecipe(name, deps)).toThrow("unknown recipe");
  }
});
