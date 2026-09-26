import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, QueryConfig } from "pg";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { factorySlug } from "../../steps/workspaces/layout.ts";
import type { RegistrySql } from "../../steps/workspaces/registry.ts";
import { resourceAttribute } from "../../workflow/runtime/resources.ts";
import { listResources, runResourcesPrune } from "./resources.ts";
import {
  type ServiceProcesses,
  servicePidfilePath,
  serviceSupervisionPath,
} from "./service-lifecycle.ts";
import { FAKE_BOOT, FAKE_START, SERVICE_COMMAND, serviceRecord } from "./test-fixtures.ts";

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

// A machine with the given ps rows; `signal` answers liveness from them.
function machine(rows: string[] = [], boot = FAKE_BOOT): ServiceProcesses {
  const output = rows.map((row) => `${row}\n`).join("");
  const alive = new Set(output.split("\n").map((row) => Number(row.trim().split(/\s+/)[0])));
  return {
    spawn: () => undefined,
    signal: (pid) => alive.has(pid),
    snapshot: () => output,
    bootId: () => boot,
    startTime: (pid) => (alive.has(pid) ? FAKE_START : undefined),
  };
}

function recordService(pid: number, options: { pidfile?: boolean } = {}): void {
  const slug = factorySlug(root);
  const pidfile = servicePidfilePath(slug);
  mkdirSync(path.dirname(pidfile), { recursive: true });
  if (options.pidfile !== false) writeFileSync(pidfile, `${pid}\n`);
  writeFileSync(serviceSupervisionPath(slug), serviceRecord(pid));
}

const prune = (processes: ServiceProcesses, connect: () => RegistrySql) =>
  runResourcesPrune(
    { cwd: root, out: (line) => lines.push(line), connect, processes },
    { apply: true },
  );

test("apply refuses a running service without opening the database", async () => {
  recordService(700);
  const connect = vi.fn(() => database());

  await expect(prune(machine([`700 1 700 Ss ${SERVICE_COMMAND}`]), connect)).rejects.toMatchObject({
    message: "factory service is still running as pid 700",
    hint: expect.stringContaining("pnpm exec jigs service stop"),
  });
  expect(connect).not.toHaveBeenCalled();
});

test("apply refuses while a process is left in the service's recorded group", async () => {
  recordService(700);
  const connect = vi.fn(() => database());

  await expect(
    prune(machine(["1 0 1 Ss init", "812 1 700 S claude --print hello world"]), connect),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /still running in the service's recorded process group 700:\n {2}pid 812: claude --print hello world/,
    ),
    hint: expect.stringContaining("pnpm exec jigs service stop"),
  });
  expect(connect).not.toHaveBeenCalled();
});

test("apply refuses without a service record", async () => {
  const connect = vi.fn(() => database());

  await expect(prune(machine(["1 0 1 Ss init"]), connect)).rejects.toMatchObject({
    message: expect.stringContaining("no service record at"),
    hint: expect.stringContaining("pnpm exec jigs service start and pnpm exec jigs service stop"),
  });
  expect(connect).not.toHaveBeenCalled();
});

test("apply proceeds once the service and its group are gone", async () => {
  recordService(700, { pidfile: false });
  const connect = vi.fn(() => database());

  const report = await prune(machine(["1 0 1 Ss init", "900 1 900 Ss bash"]), connect);

  expect(connect).toHaveBeenCalled();
  expect(report.complete).toBe(true);
});

test("apply proceeds after a restart of the machine, whatever now has the recorded pid", async () => {
  recordService(700);
  const connect = vi.fn(() => database());

  await prune(machine(["700 1 700 Ss tmux", "701 700 700 S -zsh"], "boot-2"), connect);

  expect(connect).toHaveBeenCalled();
  expect(existsSync(serviceSupervisionPath(factorySlug(root)))).toBe(false);
});

test("apply proceeds when another program took the group after a clean stop", async () => {
  recordService(700, { pidfile: false });
  const connect = vi.fn(() => database());

  await prune(machine(["700 1 700 Ss tmux", "701 700 700 S -zsh"]), connect);

  expect(connect).toHaveBeenCalled();
});
