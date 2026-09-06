import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { packageRoot } from "../config/templates.ts";
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
  return { ...result, lines };
}

test("scaffolds a factory that can be installed and built", async () => {
  const dir = scaffold("acme-factory");
  const { created } = await init(dir);

  // The infrastructure and the code a factory starts from, together: the
  // wrappers and the ids test are what e2e builds, so a scaffold that
  // typechecks and pins its ids is a tested property rather than a hope.
  expect(created.sort()).toEqual([
    ".env.example",
    ".gitignore",
    ".npmrc",
    "README.md",
    "docker-compose.yml",
    "jigs.config.test.ts",
    "jigs.config.ts",
    "jigs.yml",
    "nitro.config.ts",
    "package.json",
    "pipelines/ship.ts",
    "pnpm-workspace.yaml",
    "steps/describe-pr.ts",
    "steps/jigs.ts",
    "tsconfig.json",
  ]);
  // The SDK, its World and its dashboard are peers of @jigs/service, loaded by
  // name from the factory's own node_modules, so the factory has to carry them.
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  expect(pkg.dependencies.workflow).toBeDefined();
  expect(pkg.dependencies["@workflow/world-postgres"]).toBeDefined();
  expect(pkg.dependencies["@workflow/web"]).toBeDefined();
  expect(pkg.dependencies.hono).toBeUndefined();
  // The scaffolded ids test needs its runner.
  expect(pkg.devDependencies.vitest).toBeDefined();
  expect(pkg.scripts.test).toBe("vitest run");
  // Until the packages publish, the factory links the checkout that built the
  // CLI scaffolding it — wherever that checkout is.
  const checkout = path.resolve(packageRoot(), "..", "..");
  expect(pkg.dependencies["@jigs/service"]).toBe(
    `link:${checkout}/packages/service`,
  );
  expect(pkg.dependencies.jigs).toBe(`link:${checkout}/packages/jigs`);
  // Spike finding 5: pnpm 11 reads allowBuilds only from pnpm-workspace.yaml.
  const workspace = readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8");
  expect(workspace).toContain("@swc/core");
  // A second copy of the SDK or the World fails the install, not the run.
  expect(workspace).toContain("strictPeerDependencies: true");
  // The scope→registry line only: the token stays in ~/.npmrc.
  const npmrc = readFileSync(path.join(dir, ".npmrc"), "utf8");
  expect(npmrc).toContain("@salimhamed:registry=https://npm.pkg.github.com");
  expect(npmrc).not.toMatch(/^\s*[^#\n]*_authToken/m);
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

test("the tsconfig compiles the code this factory starts with", async () => {
  const dir = scaffold("epsilon");
  await init(dir);

  const tsconfig = readFileSync(path.join(dir, "tsconfig.json"), "utf8");
  expect(tsconfig).toContain('"steps"');
  expect(tsconfig).toContain('"pipelines"');
  expect(tsconfig).toContain('"jigs.config.test.ts"');
});

// Each exported "use step" function's name is half a durable step id, so the
// scaffold's list is the list every factory's World records. The ids test
// scaffolded beside it pins the same names against the build; here the two
// templates are held to each other without a build.
test("the wrappers scaffolded are the step ids the scaffolded test pins", async () => {
  const dir = scaffold("theta");
  await init(dir);

  const wrappers = readFileSync(path.join(dir, "steps", "jigs.ts"), "utf8");
  const steps = [...wrappers.matchAll(/^export async function (\w+)\(/gm)]
    .map((match) => `step//./steps/jigs//${match[1]}`)
    .sort();
  expect(steps).toHaveLength(15);
  const idsTest = readFileSync(path.join(dir, "jigs.config.test.ts"), "utf8");
  const pinned = [...idsTest.matchAll(/"(step\/\/\.\/steps\/jigs\/\/\w+)"/g)]
    .map((match) => match[1])
    .sort();
  expect(pinned).toEqual(steps);
  // Every wrapper has its directive: one without it compiles clean and runs
  // unmemoized.
  expect(wrappers.match(/"use step";/g)).toHaveLength(15);
  expect(idsTest).toContain("workflow//./pipelines/ship//shipPipeline");
});

test("the docker project and ports all carry the factory", async () => {
  const first = scaffold("alpha");
  const second = scaffold("beta");
  const a = await init(first);
  const b = await init(second);

  const compose = readFileSync(path.join(first, "docker-compose.yml"), "utf8");
  expect(compose).toContain("name: alpha");
  expect(compose).toContain(`"${a.postgresPort}:5432"`);
  expect(a.postgresPort).not.toBe(b.postgresPort);
  expect(a.servicePort).not.toBe(b.servicePort);
  const yml = readFileSync(path.join(first, "jigs.yml"), "utf8");
  expect(yml).toContain(`port: ${a.servicePort}`);
  expect(yml).toContain(`dashboard_port: ${a.dashboardPort}`);
  expect(a.dashboardPort).not.toBe(b.dashboardPort);
  // Disjoint ranges: one factory's dashboard is never another's service.
  for (const port of [a.servicePort, b.servicePort]) {
    expect(a.dashboardPort).not.toBe(port);
    expect(b.dashboardPort).not.toBe(port);
  }
});

test("an existing file is kept, never overwritten", async () => {
  const dir = scaffold("gamma");
  await init(dir);
  writeFileSync(path.join(dir, "jigs.yml"), "service:\n  port: 9999\n");

  const again = await init(dir);

  expect(again.created).toEqual([]);
  expect(again.skipped).toContain("jigs.yml");
  expect(readFileSync(path.join(dir, "jigs.yml"), "utf8")).toContain("9999");
});

test("the next steps are printed, not run", async () => {
  const dir = scaffold("delta");
  const { lines } = await init(dir);

  const printed = lines.join("\n");
  expect(printed).toContain("never rename the file or an exported wrapper");
  expect(printed).toContain("LINEAR_API_KEY and GITHUB_TOKEN");
  expect(printed).toContain("jigs up");
  expect(printed).toContain("jigs bind");
  // `jigs up` owns the machine-touching commands now, one step at a time.
  expect(printed).not.toContain("docker compose");
  expect(printed).not.toContain("pnpm exec bootstrap");
  // Printing them is the whole point: nothing was executed.
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  expect(existsSync(path.join(dir, ".env"))).toBe(false);
});
