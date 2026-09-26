import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, QueryConfig } from "pg";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { factorySlug } from "../../steps/workspaces/layout.ts";
import type { RegistrySql } from "../../steps/workspaces/registry.ts";
import { resourceAttribute } from "../../workflow/runtime/resources.ts";
import { listResources, runResourcesPrune } from "./resources.ts";
import { servicePidfilePath, serviceSupervisionPath } from "./service-lifecycle.ts";

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const WORKFLOW = "workflow//./workflows/ship//shipWorkflow";
let tmp: string;
let root: string;
let lines: string[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-resource-command-"));
  root = path.join(tmp, "factory");
  mkdirSync(path.join(root, ".output", "server"), { recursive: true });
  writeFileSync(
    path.join(root, "jigs.config.ts"),
    "export default { service: { port: 8990, dashboardPort: 9090 }, workflows: {} };\n",
  );
  writeFileSync(path.join(root, ".env"), "WORKFLOW_POSTGRES_URL=postgres://unused/test\n");
  writeFileSync(path.join(root, ".output", "server", "index.mjs"), `const id = "${WORKFLOW}";\n`);
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  lines = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function database(status = "completed"): RegistrySql {
  const resource = resourceAttribute({
    kind: "pull-request",
    identity: "acme/repo#1",
    url: "https://github.com/acme/repo/pull/1",
  });
  const pool = {
    async query(config: string | (QueryConfig & { rowMode?: string })) {
      const text = typeof config === "string" ? config : config.text;
      if (text.includes('"workflow"."workflow_runs"')) {
        return {
          rows: [
            {
              id: RUN,
              name: WORKFLOW,
              status,
              attributes: {
                [resource.key]: resource.value,
              },
            },
          ],
        };
      }
      return { rows: [] };
    },
    async end() {},
  };
  return drizzle(pool as unknown as Pool);
}

test("list selects a run by its full ID and prints JSON without mutating", async () => {
  const report = await listResources(
    { cwd: root, out: (line) => lines.push(line), connect: () => database() },
    { run: RUN, json: true },
  );
  expect(report).toMatchObject({
    complete: true,
    entries: [{ runId: RUN, kind: "pull-request", exists: null, eligible: false }],
  });
  expect(JSON.parse(lines.join("\n"))).toEqual(report);
});

test.each([
  ["a prefix", RUN.slice(5, 13)],
  ["a prefix with wrun_", RUN.slice(0, 13)],
  ["a ticket", "AGE-317"],
  ["an unknown ref", "wrun_01ZZZZZZZZZZZZZZZZZZZZZZZZ"],
])("--run rejects %s and points at jigs status", async (_label, ref) => {
  await expect(
    listResources(
      {
        cwd: root,
        out: (line) => lines.push(line),
        connect: () => database(),
      },
      { run: ref },
    ),
  ).rejects.toMatchObject({
    message: `run ${ref} not found`,
    hint: expect.stringContaining("pnpm exec jigs status"),
  });
  expect(lines).toEqual([]);
});

test("a workflow database read failure reports that nothing changed", async () => {
  const pool = {
    async query() {
      throw new Error("database unavailable");
    },
    async end() {},
  };
  const failed = drizzle(pool as unknown as Pool);

  await expect(
    listResources({ cwd: root, out: (line) => lines.push(line), connect: () => failed }),
  ).rejects.toThrow("could not read workflow runs");
});

test("apply refuses a running service without opening the database", async () => {
  const slug = factorySlug(root);
  const pidfile = servicePidfilePath(slug);
  mkdirSync(path.dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, `${process.pid}\n`);
  const connect = vi.fn(() => database());

  await expect(
    runResourcesPrune(
      {
        cwd: root,
        out: (line) => lines.push(line),
        connect,
        systemd: {
          available: () => true,
          linger: () => true,
          scopeState: () => "active",
          stopScope: () => undefined,
        },
      },
      { apply: true },
    ),
  ).rejects.toThrow("still running");
  expect(connect).not.toHaveBeenCalled();
});

test("apply refuses a surviving child in the factory scope", async () => {
  const supervision = serviceSupervisionPath(factorySlug(root));
  mkdirSync(path.dirname(supervision), { recursive: true });
  writeFileSync(supervision, "systemd-scope\n");
  const connect = vi.fn(() => database());
  await expect(
    runResourcesPrune(
      {
        cwd: root,
        out: (line) => lines.push(line),
        connect,
        systemd: {
          available: () => true,
          linger: () => true,
          scopeState: () => "active",
          stopScope: () => undefined,
        },
      },
      { apply: true },
    ),
  ).rejects.toThrow("still has a service or child process");
  expect(connect).not.toHaveBeenCalled();
});

test("apply refuses when prior child containment cannot be proven", async () => {
  const connect = vi.fn(() => database());
  await expect(
    runResourcesPrune(
      {
        cwd: root,
        out: (line) => lines.push(line),
        connect,
        systemd: {
          available: () => true,
          linger: () => true,
          scopeState: () => "inactive",
          stopScope: () => undefined,
        },
      },
      { apply: true },
    ),
  ).rejects.toThrow("cannot prove that prior factory child processes were contained");
  expect(connect).not.toHaveBeenCalled();
});
