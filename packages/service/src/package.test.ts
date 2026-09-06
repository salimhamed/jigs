import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import tsdownConfig from "../tsdown.config.ts";

// A factory builds against this package's compiled dist/, and the Workflow SDK
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
const optionalPeers = new Set(
  Object.entries<{ optional?: boolean }>(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional === true)
    .map(([name]) => name),
);

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

test("no compiled source carries a workflow directive — the factory writes its own", async () => {
  // The wrappers live in the factory repo, which is what keeps this package's
  // version out of every memoization key. A directive sneaking back in here
  // compiles clean and resurrects a version-bearing id, so this is the guard
  // that has to hold. src/ is what this package compiles; templates/ is
  // infrastructure only and carries no TypeScript of its own.
  const directed: string[] = [];
  for (const file of await sourceFiles("src")) {
    const source = await readFile(path.join(packageDir, file), "utf8");
    if (directive.test(source)) directed.push(file);
  }
  expect(directed).toEqual([]);
});

test("every subpath the fixture factory's wrappers reach is in the exports map", async () => {
  // A factory resolves this package through the exports map alone, so a
  // subpath dropped here is a wrapper that cannot resolve in every factory
  // that already has one. The fixture factory is the one factory in this repo,
  // and its wrappers are the closest thing left to a worked example.
  const wrappers = await readFile(
    path.join(
      packageDir,
      "..",
      "..",
      "e2e",
      "fixture-factory",
      "steps",
      "jigs.ts",
    ),
    "utf8",
  );
  const reached = new Set(
    [...wrappers.matchAll(/from "@jigs\/service(\/[^"]*)?"/g)].map(
      (match) => `.${match[1] ?? ""}`,
    ),
  );
  for (const subpath of reached) {
    expect(Object.keys(pkg.exports), subpath).toContain(subpath);
  }
});

test("every exports target is a dist file tsdown emits from a source file that exists", () => {
  // A factory resolves this package through dist/ alone, so a target has to be
  // something the build writes. Checked against the build's entry list rather
  // than a built dist/, so this holds before the first build too.
  const entries = (tsdownConfig as { entry: Record<string, string> }).entry;
  for (const target of exportTargets) {
    const match = /^\.\/dist\/(.+)\.(js|d\.ts)$/.exec(target);
    expect(match, target).not.toBeNull();
    const source = entries[match?.[1] ?? ""];
    expect(source, target).toBeDefined();
    expect(existsSync(path.join(packageDir, source ?? ""))).toBe(true);
  }
});

test("every tsdown entry is reachable through the exports map", () => {
  // The inverse: an entry with no subpath is compiled output nothing can
  // import, which is a subpath someone forgot to export.
  const entries = (tsdownConfig as { entry: Record<string, string> }).entry;
  for (const key of Object.keys(entries)) {
    expect(exportTargets, key).toContain(`./dist/${key}.js`);
  }
});

test("the runtime a factory supplies is a peer here, and still a devDependency", () => {
  // A factory repo installs the SDK, its World, hono and zod itself: one copy
  // of `workflow` per process is what makes a compiled step id resolve to a
  // registered function. They stay in devDependencies so this repo's own
  // tests and build still resolve them.
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
    // nitro is the one optional peer: it is only here so the emitted
    // declarations reference its types instead of inlining them, and a factory
    // holds it as a devDependency, the way this package does.
    const section = optionalPeers.has(name)
      ? "devDependencies"
      : "dependencies";
    expect(template[section][name], name).toBe(range);
  }
});
