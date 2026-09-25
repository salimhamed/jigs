import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { generateIntegration } from "./generate.ts";

const roots: string[] = [];
function factory() {
  const root = mkdtempSync(path.join(tmpdir(), "jigs-generate-"));
  roots.push(root);
  writeFileSync(path.join(root, "jigs.config.ts"), "export default {};");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("generation comes from the factory's installed package, even from a subdirectory", async () => {
  const root = factory();
  const packageDir = path.join(root, "node_modules/@jigs-ai/jigs");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@jigs-ai/jigs",
      type: "module",
      exports: { "./build": "./build.js" },
    }),
  );
  writeFileSync(
    path.join(packageDir, "build.js"),
    `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
export function generateFactoryIntegration(root) {
  writeFileSync(path.join(root, 'jigs-generated.ts'), '// this factory installed me');
}
`,
  );
  const nested = path.join(root, "workflows");
  mkdirSync(nested);
  const lines: string[] = [];
  await generateIntegration({ cwd: nested, out: (line) => lines.push(line) });
  expect(readFileSync(path.join(root, "jigs-generated.ts"), "utf8")).toBe(
    "// this factory installed me",
  );
  expect(lines).toEqual(["generated jigs/steps.ts and jigs/routines.ts — review and commit them"]);
});

test("generation explains when the factory has not installed jigs", async () => {
  await expect(generateIntegration({ cwd: factory(), out: () => {} })).rejects.toThrow(
    /not installed/,
  );
});
