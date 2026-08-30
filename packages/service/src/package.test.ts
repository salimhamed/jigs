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
  // src/ and plugins/ are the whole surface: this package is a library, and
  // the pipelines that consume it live in factory repos.
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

test("the runtime a factory supplies is a peer here, and still a devDependency", () => {
  // A factory repo installs the SDK, its World, hono and zod itself: one copy
  // of `workflow` per process is what makes a compiled step id resolve to a
  // registered function. They stay in devDependencies so this repo's own
  // tests and build still resolve them.
  //
  // The compiler decides whether to follow imports into a package by looking
  // for `workflow` in any of its dependency fields — but it reads them through
  // `require.resolve("@jigs/service/package.json")`, which this exports map
  // does not answer, so today it fails open and follows regardless. Adding a
  // "./package.json" export would arm that gate, and then dropping this peer
  // would silently stop compiling every step in this package.
  const peers: Record<string, string> = pkg.peerDependencies;
  expect(Object.keys(peers)).toContain("workflow");
  for (const [name, range] of Object.entries(peers)) {
    expect(pkg.devDependencies[name], name).toBe(range);
    expect(pkg.dependencies[name], name).toBeUndefined();
  }
});

test("the factory template pins the same versions this package peers on", async () => {
  // The template is what a factory installs; a peer bumped here and not there
  // gives the factory two copies of the SDK and a manifest full of step ids
  // nothing registers.
  const template = JSON.parse(
    (
      await readFile(
        path.join(packageDir, "templates", "package.json.tmpl"),
        "utf8",
      )
    ).replaceAll("{{JIGS_REPO}}", "/jigs"),
  );
  for (const [name, range] of Object.entries<string>(pkg.peerDependencies)) {
    expect(template.dependencies[name], name).toBe(range);
  }
});
