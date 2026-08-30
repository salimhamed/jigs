import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { initFactory } from "./init.ts";

const scaffold = (name: string) => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "jigs-init-")), name);
  return dir;
};

function init(dir: string) {
  const lines: string[] = [];
  const result = initFactory({ cwd: dir, out: (line) => lines.push(line) });
  return { ...result, lines };
}

test("scaffolds a factory that can be installed and built", () => {
  const dir = scaffold("acme-factory");
  const { created } = init(dir);

  expect(created.sort()).toEqual([
    ".env.example",
    ".gitignore",
    "docker-compose.yml",
    "jigs.config.ts",
    "jigs.yml",
    "nitro.config.ts",
    "package.json",
    path.join("pipelines", "example.ts"),
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

test("the docker project and ports all carry the factory", () => {
  const first = scaffold("alpha");
  const second = scaffold("beta");
  const a = init(first);
  const b = init(second);

  const compose = readFileSync(path.join(first, "docker-compose.yml"), "utf8");
  expect(compose).toContain("name: alpha");
  expect(compose).toContain(`"${a.postgresPort}:5432"`);
  expect(a.postgresPort).not.toBe(b.postgresPort);
  expect(a.servicePort).not.toBe(b.servicePort);
  expect(readFileSync(path.join(first, "jigs.yml"), "utf8")).toContain(
    `port: ${a.servicePort}`,
  );
});

test("an existing file is kept, never overwritten", () => {
  const dir = scaffold("gamma");
  init(dir);
  writeFileSync(path.join(dir, "jigs.yml"), "service:\n  port: 9999\n");

  const again = init(dir);

  expect(again.created).toEqual([]);
  expect(again.skipped).toContain("jigs.yml");
  expect(readFileSync(path.join(dir, "jigs.yml"), "utf8")).toContain("9999");
});

test("the commands only a human should run are printed, not run", () => {
  const dir = scaffold("delta");
  const { lines } = init(dir);

  const printed = lines.join("\n");
  expect(printed).toContain("docker compose up -d --wait");
  expect(printed).toContain("pnpm exec bootstrap");
  expect(printed).toContain("jigs build");
  expect(printed).toContain("jigs service start");
  // Printing them is the whole point: nothing was executed.
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  expect(existsSync(path.join(dir, ".env"))).toBe(false);
});
