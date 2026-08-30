import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// This package is consumed by factory repos as source, so its package.json is
// load-bearing at compile time in a way nothing else here is: the Workflow SDK
// derives durable step ids from the package name, version and export subpath a
// step file is reached through. Every assertion below guards a failure that is
// otherwise silent — no error, just wrong ids, in someone else's repo.

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(
  await readFile(path.join(packageDir, "package.json"), "utf8"),
);
const exportTargets: string[] = Object.values(pkg.exports).flatMap((entry) =>
  typeof entry === "string" ? [entry] : Object.values(entry as object),
);

const directive = /^\s*["']use (step|workflow)["']/m;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(packageDir, dir), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(`${dir}/${entry.name}`)
        : [`${dir}/${entry.name}`],
    ),
  );
  return files.flat().filter((file) => file.endsWith(".ts"));
}

test("the version is pinned to 0.0.0 — bumping it orphans every in-flight run", () => {
  // The version is half of a step id, and step ids are the memoization keys in
  // Postgres. A bump silently renames every step, so runs mid-flight replay
  // against ids that no longer exist. There is no migration; never bump this.
  expect(pkg.version).toBe("0.0.0");
});

test("every file carrying a workflow directive is an exact exports target", async () => {
  // A step file reached through no export subpath, or through a wildcard the
  // SDK cannot match by exact string, compiles fine and fails only at runtime
  // in the factory repo. Adding a step file means adding an exports entry.
  // src/ and plugins/ are the factory-facing surface; pipelines/ is this app's
  // own workflows, which factory repos replace rather than import.
  const scanned = [
    ...(await sourceFiles("src")),
    ...(await sourceFiles("plugins")),
  ];
  const missing: string[] = [];
  for (const file of scanned) {
    const source = await readFile(path.join(packageDir, file), "utf8");
    if (!directive.test(source)) continue;
    if (!exportTargets.includes(`./${file}`)) missing.push(file);
  }
  expect(missing).toEqual([]);
});

test("every exports target is raw TypeScript that exists on disk", () => {
  // Compiled output would strip the directives, and a target that has moved
  // resolves to nothing at all.
  for (const target of exportTargets) {
    expect(target).toMatch(/\.ts$/);
    expect(existsSync(path.join(packageDir, target))).toBe(true);
  }
});
