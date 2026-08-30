import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// This package is consumed by factory repos as source, and the Workflow SDK
// derives durable step ids from the package name, version and export subpath a
// directive-bearing file is reached through. So this package carries no
// directives at all: the "use step" wrappers live in the factory, ids are
// factory-local paths, and no version of anything is a memoization key. Every
// assertion below guards a failure that is otherwise silent — no error, just
// wrong ids, in someone else's repo.

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

test("the version stays pinned to 0.0.0 until AGE-334 retires the pin", () => {
  // No emitted id carries this version any more — the guard below is what
  // keeps it that way. The pin outlives its reason by one ticket: it is
  // removed on AGE-334, with the fixture ids re-recorded there.
  expect(pkg.version).toBe("0.0.0");
});

test("no compiled source carries a workflow directive — templates scaffold them into the factory", async () => {
  // The wrappers live in the factory repo, which is what keeps this package's
  // version out of every memoization key. A directive sneaking back in here
  // compiles clean and resurrects a version-bearing id, so this is the guard
  // that has to hold. src/ and plugins/ are what this package compiles;
  // templates/ ships as factory-local source and is meant to carry directives.
  const scanned = [
    ...(await sourceFiles("src")),
    ...(await sourceFiles("plugins")),
  ];
  const directed: string[] = [];
  for (const file of scanned) {
    const source = await readFile(path.join(packageDir, file), "utf8");
    if (directive.test(source)) directed.push(file);
  }
  expect(directed).toEqual([]);
});

test("every subpath the scaffolded wrappers reach is in the exports map", async () => {
  // templates/steps/jigs.ts.tmpl is what `jigs init` writes into a factory,
  // and a factory resolves it through this map alone. A subpath dropped here
  // is a wrapper that cannot resolve in every factory that already has one.
  const scaffold = await readFile(
    path.join(packageDir, "templates", "steps", "jigs.ts.tmpl"),
    "utf8",
  );
  const reached = new Set(
    [...scaffold.matchAll(/from "@jigs\/service(\/[^"]*)?"/g)].map(
      (match) => `.${match[1] ?? ""}`,
    ),
  );
  for (const subpath of reached) {
    expect(Object.keys(pkg.exports), subpath).toContain(subpath);
  }
});

test("every exports target is raw TypeScript that exists on disk", () => {
  // This package has no build step — the factory's compiler consumes these
  // files as source — so a target that is not .ts, or has moved, resolves to
  // nothing at all.
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
  // would silently stop the compiler following the factory's imports into
  // this package's workflow-side code.
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
