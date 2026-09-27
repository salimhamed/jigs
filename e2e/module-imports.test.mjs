import { expect, test } from "vitest";
import { staticModuleSpecifiers } from "./module-imports.mjs";

test("the CLI dependency gate ignores documentation and strings while following real imports", () => {
  const source = [
    '/** @example import { defineWorkflow } from "@jigs-ai/jigs"; */',
    '// import "comment-only";',
    "const example = 'import \"string-only\";';",
    'const template = `import { runAgent } from "template-only";`;',
    'import { program } from "commander";',
    'import "./setup.js";',
    'export { config } from "./config.js";',
    'export * from "./shared.js";',
    'export * as schema from "zod";',
    'export const start = () => import("workflow/runtime");',
  ].join("\n");

  expect(staticModuleSpecifiers(source)).toEqual([
    "commander",
    "./setup.js",
    "./config.js",
    "./shared.js",
    "zod",
  ]);
});
