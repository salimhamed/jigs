import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
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
  expect(pkg.dependencies["@jigs/service"]).toMatch(/packages\/service$/);
  // Spike finding 5: pnpm 11 reads allowBuilds only from pnpm-workspace.yaml.
  expect(readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8")).toContain(
    "@swc/core",
  );
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
  expect(printed).toContain("jigs build");
  expect(printed).toContain("jigs service start");
  // Printing them is the whole point: nothing was executed.
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  expect(existsSync(path.join(dir, ".env"))).toBe(false);
});
