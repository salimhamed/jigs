import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { STEPS_FILE } from "../config/steps-scaffold.ts";
import { initFactory } from "./init.ts";

const scaffold = (name: string) => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "jigs-init-")), name);
  return dir;
};

async function init(
  dir: string,
  confirm?: (question: string) => Promise<boolean>,
) {
  const lines: string[] = [];
  const result = await initFactory({
    cwd: dir,
    out: (line) => lines.push(line),
    ...(confirm === undefined ? {} : { confirm }),
  });
  return { ...result, lines };
}

const yes = async () => true;
const no = async () => false;

test("scaffolds a factory that can be installed and built", async () => {
  const dir = scaffold("acme-factory");
  const { created } = await init(dir);

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
    STEPS_FILE,
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

test("the scaffolded wrappers carry the directive and the tsconfig compiles them", async () => {
  const dir = scaffold("epsilon");
  await init(dir);

  expect(readFileSync(path.join(dir, STEPS_FILE), "utf8")).toContain(
    '"use step"',
  );
  expect(readFileSync(path.join(dir, "tsconfig.json"), "utf8")).toContain(
    '"steps"',
  );
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
  expect(readFileSync(path.join(first, "jigs.yml"), "utf8")).toContain(
    `port: ${a.servicePort}`,
  );
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

test("a re-run offers the wrappers this factory is missing and appends only those", async () => {
  const dir = scaffold("zeta");
  await init(dir);
  const stepsPath = path.join(dir, STEPS_FILE);
  const trimmed = readFileSync(stepsPath, "utf8").replace(
    /export async function worktree\([\s\S]*?\n}\n/,
    "",
  );
  writeFileSync(stepsPath, trimmed);

  const again = await init(dir, yes);

  expect(again.appended).toEqual(["worktree"]);
  expect(again.lines.join("\n")).toContain("no wrapper for 1 jigs step(s)");
  const repaired = readFileSync(stepsPath, "utf8");
  expect(repaired).toContain("export async function worktree(");
  // Everything that was there is still there, byte for byte: a rewrite would
  // renumber ids the World is already memoizing against.
  expect(repaired.startsWith(trimmed)).toBe(true);
  expect(await init(dir, yes)).toMatchObject({ appended: [] });
});

test("a declined offer leaves the wrappers alone", async () => {
  const dir = scaffold("eta");
  await init(dir);
  const stepsPath = path.join(dir, STEPS_FILE);
  const trimmed = readFileSync(stepsPath, "utf8").replace(
    /export async function readDiff\([\s\S]*?\n}\n/,
    "",
  );
  writeFileSync(stepsPath, trimmed);

  const again = await init(dir, no);

  expect(again.appended).toEqual([]);
  expect(readFileSync(stepsPath, "utf8")).toBe(trimmed);
});

test("the commands only a human should run are printed, not run", async () => {
  const dir = scaffold("delta");
  const { lines } = await init(dir);

  const printed = lines.join("\n");
  expect(printed).toContain("docker compose up -d --wait");
  expect(printed).toContain("pnpm exec bootstrap");
  expect(printed).toContain("jigs build");
  expect(printed).toContain("jigs service start");
  // Printing them is the whole point: nothing was executed.
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  expect(existsSync(path.join(dir, ".env"))).toBe(false);
});
