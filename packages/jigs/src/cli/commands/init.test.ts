import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { packageRoot } from "../../build/templates.ts";
import { parseFactoryConfig } from "../../workflow/factory-schema.ts";
import { layoutProblems } from "../output-layout.ts";
import { initFactory } from "./init.ts";

const scaffold = (name: string) => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "jigs-init-")), name);
  return dir;
};

async function init(dir: string) {
  const lines: string[] = [];
  const result = await initFactory({
    cwd: dir,
    out: (line) => lines.push(line),
  });
  expect(layoutProblems(lines)).toEqual([]);
  return { ...result, lines };
}

test("scaffolds a factory that can be installed and built", async () => {
  const dir = scaffold("acme-factory");
  const { created } = await init(dir);

  // The infrastructure and the code a factory starts from, together: the
  // wrappers and the ids test are what e2e builds, so a scaffold that
  // typechecks and pins its ids is a tested property rather than a hope.
  expect(created.sort()).toEqual(
    [
      ".env.example",
      ".gitignore",
      "README.md",
      "docker-compose.yml",
      "jigs.config.test.ts",
      "jigs.config.ts",
      "nitro.config.ts",
      "package.json",
      "workflows/hello/hello.ts",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "vitest.config.ts",
    ].sort(),
  );
  // The SDK, its World and its dashboard are peers of jigs, loaded by name
  // from the factory's own node_modules, so the factory has to carry them.
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  expect(pkg.dependencies.workflow).toBeDefined();
  expect(pkg.dependencies["@workflow/world-postgres"]).toBeDefined();
  expect(pkg.dependencies["@workflow/web"]).toBeDefined();
  expect(pkg.dependencies.express).toBeUndefined();
  // The scaffolded ids test needs its runner.
  expect(pkg.devDependencies.vitest).toBeDefined();
  expect(pkg.scripts.test).toBe("vitest run");
  // Pinned to the version of the CLI scaffolding it: a range would let the
  // scaffold's wrappers and the package they import from drift apart.
  const { version } = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.dependencies["@jigs-ai/jigs"]).toBe(version);
  expect(JSON.stringify(pkg)).not.toContain("link:");
  // Spike finding 5: pnpm 11 reads allowBuilds only from pnpm-workspace.yaml.
  const workspace = readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8");
  expect(workspace).toContain("@swc/core");
  // A second copy of the SDK or the World fails the install, not the run.
  expect(workspace).toContain("strictPeerDependencies: true");
  // A node older than jigs's engines.node fails the install, not the service boot.
  expect(workspace).toContain("engineStrict: true");
  // Keeps a factory from installing a Codex CLI it will never run.
  expect(workspace).toContain("ignoredOptionalDependencies");
  expect(workspace).toContain("'@openai/codex'");
  // jigs can upgrade immediately without disabling the operator's age policy
  // for any other package.
  expect(workspace).toContain("minimumReleaseAgeExclude");
  expect(workspace).toContain("'@jigs-ai/jigs'");
  expect(workspace).not.toContain("minimumReleaseAge:");
});

test("every placeholder a template carries is filled in", async () => {
  const dir = scaffold("zeta");
  const { created } = await init(dir);

  for (const file of created) {
    expect(readFileSync(path.join(dir, file), "utf8"), file).not.toMatch(
      /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/,
    );
  }
});

// Types come from the package, so a fresh clone typechecks before any build;
// code runs from the copies the build writes into .jigs/, so each step's
// durable ID is a path in the factory.
test("the scaffold's imports map takes types from the package and code from .jigs/", async () => {
  const dir = scaffold("iota");
  await init(dir);

  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  expect(pkg.imports).toEqual({
    "#jigs/steps": { types: "@jigs-ai/jigs/factory/steps", default: "./.jigs/steps.ts" },
    "#jigs/routines": { types: "@jigs-ai/jigs/factory/routines", default: "./.jigs/routines.ts" },
  });
  expect(existsSync(path.join(dir, "jigs"))).toBe(false);
});

// Both spellings of a relative parent import: `from "../x"` and the dynamic
// `import("../x")` the one deliberate exception in jigs.config.ts uses. A
// pattern matching only the first passes the scaffold for the wrong reason.
const RELATIVE_PARENT_IMPORT = /(?:from|import\s*\()\s*["']\.\.\//;

test("the relative-import guard catches both import spellings", () => {
  expect('import { a } from "../../shared/steps.ts";').toMatch(RELATIVE_PARENT_IMPORT);
  expect('const a = await import("../../shared/steps.ts");').toMatch(RELATIVE_PARENT_IMPORT);
  expect('import { a } from "#jigs/steps";').not.toMatch(RELATIVE_PARENT_IMPORT);
  expect('const a = await import("./workflows/hello/hello.ts");').not.toMatch(
    RELATIVE_PARENT_IMPORT,
  );
});

// The factory code scaffolded beside the map has to be written in it, or the
// e2e build is the only factory in existence never resolving a # specifier.
test("the scaffolded factory code imports through the root-anchored map", async () => {
  const dir = scaffold("kappa");
  await init(dir);

  const authored = ["workflows/hello/hello.ts"];
  for (const file of authored) {
    const source = readFileSync(path.join(dir, file), "utf8");
    expect(source, file).not.toMatch(RELATIVE_PARENT_IMPORT);
    expect(source, file).toMatch(/["']#jigs\/(?:steps|routines)["']/);
  }
  // The deferred loaders are registrations rather than import sites, and stay
  // relative on purpose.
  expect(readFileSync(path.join(dir, "jigs.config.ts"), "utf8")).toContain(
    'import("./workflows/hello/hello.ts")',
  );
});

test("the tsconfig compiles the code this factory starts with", async () => {
  const dir = scaffold("epsilon");
  await init(dir);

  const tsconfig = readFileSync(path.join(dir, "tsconfig.json"), "utf8");
  const { include, exclude } = JSON.parse(tsconfig) as { include: string[]; exclude: string[] };
  // A recipe's tests sit in nested workflow directories.
  expect(include).toEqual(expect.arrayContaining(["workflows/**/*.ts"]));
  expect(exclude).toEqual(["node_modules", ".jigs"]);
  expect(tsconfig).toContain('"jigs.config.test.ts"');
  expect(tsconfig).toContain('"erasableSyntaxOnly": true');
});

test("the docker project and ports are suggested in .env.example, never committed", async () => {
  const dir = scaffold("alpha");
  const a = await init(dir);

  const compose = readFileSync(path.join(dir, "docker-compose.yml"), "utf8");
  expect(compose).toContain(`name: \${COMPOSE_PROJECT_NAME}`);
  expect(compose).toContain(`"127.0.0.1:\${JIGS_POSTGRES_PORT}:5432"`);
  expect(readFileSync(path.join(dir, "jigs.config.ts"), "utf8")).not.toContain(
    String(a.servicePort),
  );
  const example = readFileSync(path.join(dir, ".env.example"), "utf8");
  expect(example).toContain("COMPOSE_PROJECT_NAME=alpha\n");
  expect(example).toContain(`JIGS_SERVICE_PORT=${a.servicePort}\n`);
  expect(example).toContain(`JIGS_DASHBOARD_PORT=${a.dashboardPort}\n`);
  expect(example).toContain(`JIGS_POSTGRES_PORT=${a.postgresPort}\n`);

  // One offset under 100 shared by three ranges 100 apart, so no factory's
  // service port can be another's dashboard or World port. Two scaffolds
  // landing on different offsets is not the property: the offset is a hash
  // bucket of the path, and any two paths share one about 1% of the time.
  const offset = a.servicePort - 8990;
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(offset).toBeLessThan(100);
  expect(a.dashboardPort).toBe(9090 + offset);
  expect(a.postgresPort).toBe(5440 + offset);

  // Derived from the path, never drawn fresh.
  const again = await init(dir);
  expect(again.created).toEqual([]);
  expect(again.servicePort).toBe(a.servicePort);
  expect(again.dashboardPort).toBe(a.dashboardPort);
  expect(again.postgresPort).toBe(a.postgresPort);

  // A different path is a different derivation, and the project name follows
  // the directory rather than the ports.
  const other = scaffold("beta");
  const b = await init(other);
  expect(readFileSync(path.join(other, ".env.example"), "utf8")).toContain(
    "COMPOSE_PROJECT_NAME=beta\n",
  );
  for (const port of [a.servicePort, b.servicePort]) {
    expect(a.dashboardPort).not.toBe(port);
    expect(b.dashboardPort).not.toBe(port);
    expect(a.postgresPort).not.toBe(port);
    expect(b.postgresPort).not.toBe(port);
  }
});

test("an existing file is kept, never overwritten", async () => {
  const dir = scaffold("gamma");
  await init(dir);
  writeFileSync(
    path.join(dir, "jigs.config.ts"),
    "export default { hub: { url: 'https://hub.example.test' }, workflows: {} }; // edited",
  );

  const again = await init(dir);

  expect(again.created).toEqual([]);
  expect(again.skipped).toContain("jigs.config.ts");
  expect(readFileSync(path.join(dir, "jigs.config.ts"), "utf8")).toContain("// edited");
});

test("the next steps are printed, not run", async () => {
  const dir = scaffold("delta");
  const { lines } = await init(dir);

  const printed = lines.join("\n");
  const next = lines.indexOf("Next, in this directory");
  // Only the file list and one blank line come before the next steps.
  expect(lines.slice(0, next - 1).every((l) => l.startsWith("created "))).toBe(true);
  expect(lines[next - 1]).toBe("");
  const steps = lines.slice(next + 1).map((l) => l.trim());
  expect(steps.map((l) => l.split("  ")[0])).toEqual([
    "pnpm install",
    "cp .env.example .env",
    "pnpm exec jigs up",
    "pnpm exec jigs run hello",
    "pnpm exec jigs doctor",
  ]);
  expect(printed).not.toContain("--no-doctor");
  // `jigs up` owns the machine-touching commands now, one step at a time.
  expect(printed).not.toContain("docker compose");
  expect(printed).not.toContain("pnpm exec bootstrap");
  // Printing them is the whole point: nothing was executed.
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  expect(existsSync(path.join(dir, ".env"))).toBe(false);
});

test("the scaffold leaves GitHub to its hub and the approval to its default", async () => {
  const dir = scaffold("github-factory");
  await init(dir);
  const config = readFileSync(path.join(dir, "jigs.config.ts"), "utf8");
  expect(config).toContain('// github: { operator: "your-github-login" },');
  expect(config).not.toContain("merge");
});

const evaluate = (literal: string): unknown => new Function(`return ${literal}`)();

// The scaffolded config is TypeScript that imports jigs, so it is read the way
// `jigs bind` reads it: as the settings object, with the wrapper stripped.
const scaffoldedConfig = (dir: string) => {
  const text = readFileSync(path.join(dir, "jigs.config.ts"), "utf8");
  const body = text.slice(
    text.indexOf("defineFactory({") + "defineFactory(".length,
    text.lastIndexOf(")"),
  );
  return evaluate(body.replace(/workflows:\s*\{[^}]*\},?/s, "")) as Record<string, unknown>;
};

test("the scaffold's config is what jigs accepts, so the first `jigs up` loads", async () => {
  const dir = scaffold("accepted");
  await init(dir);
  const parsed = parseFactoryConfig({
    hub: { url: "https://hub.example.test" },
    ...scaffoldedConfig(dir),
  });
  expect(parsed.github).toEqual({ mergeApproval: "review" });
  expect(parsed.linear).toEqual({});
});
