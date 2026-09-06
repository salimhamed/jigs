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

  // Infrastructure only: jigs.config.ts, the pipelines and the step wrappers
  // are this factory's own source, and nothing here writes a line of them.
  expect(created.sort()).toEqual([
    ".env.example",
    ".gitignore",
    ".npmrc",
    "docker-compose.yml",
    "jigs.yml",
    "nitro.config.ts",
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.json",
  ]);
  // Spike finding 6: hono resolves as an external otherwise.
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  expect(pkg.dependencies.hono).toBeDefined();
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

test("the tsconfig compiles the code this factory will write", async () => {
  const dir = scaffold("epsilon");
  await init(dir);

  const tsconfig = readFileSync(path.join(dir, "tsconfig.json"), "utf8");
  expect(tsconfig).toContain('"steps"');
  expect(tsconfig).toContain('"pipelines"');
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

test("the commands only a human should run are printed, not run", async () => {
  const dir = scaffold("delta");
  const { lines } = await init(dir);

  const printed = lines.join("\n");
  expect(printed).toContain("jigs scaffolds none of them");
  expect(printed).toContain("docker compose up -d --wait");
  expect(printed).toContain("pnpm exec bootstrap");
  // bootstrap loads the .env copied a line earlier, so the World URL it used
  // to be prefixed with was never the thing that told it where to connect.
  expect(printed).not.toContain("WORKFLOW_POSTGRES_URL=");
  expect(printed).toContain("jigs build");
  expect(printed).toContain("jigs service start");
  // Printing them is the whole point: nothing was executed.
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  expect(existsSync(path.join(dir, ".env"))).toBe(false);
});
