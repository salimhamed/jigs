import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { locateTemplates, packageRoot } from "./templates.ts";

test("the templates ship inside this package, found from its own root", () => {
  const root = packageRoot();
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  // The bin name outlives the package name: it is what `pnpm dlx` runs.
  expect(manifest.bin.jigs).toBeDefined();
  // `files` is what `pnpm pack` ships; a templates/ missing from it would
  // scaffold nothing from an installed CLI.
  expect(manifest.files).toContain("templates");

  const templates = locateTemplates();
  expect(templates).toBe(path.join(root, "templates"));
  expect(existsSync(path.join(templates, "package.json.tmpl"))).toBe(true);
});
