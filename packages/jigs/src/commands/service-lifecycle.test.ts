import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CliError } from "../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { factorySlug } from "../worktrees/layout.ts";
import type { ServiceProcesses, SpawnSpec } from "./service-lifecycle.ts";
import {
  builtBundleHash,
  runningBundleHash,
  SERVICE_ENTRY,
  serviceLogPath,
  serviceLogs,
  servicePidfilePath,
  serviceStatus,
  startService,
  stopService,
} from "./service-lifecycle.ts";

let tmp: string;
let lines: string[];

beforeEach(() => {
  tmp = makeTmpDir();
  lines = [];
  // Pidfiles and logs live under the data dir, so redirecting it is enough
  // to keep the real filesystem effects inside the test's tmp dir.
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

interface Fake {
  processes: ServiceProcesses;
  spawns: SpawnSpec[];
  signals: Array<{ pid: number; sig: NodeJS.Signals | 0 }>;
  alive: Set<number>;
}

function fake(): Fake {
  const state: Fake = {
    spawns: [],
    signals: [],
    alive: new Set(),
    processes: undefined as unknown as ServiceProcesses,
  };
  state.processes = {
    spawn(spec) {
      state.spawns.push(spec);
      state.alive.add(4242);
      return 4242;
    },
    signal(pid, sig) {
      state.signals.push({ pid, sig });
      return state.alive.has(pid);
    },
  };
  return state;
}

// A factory repo that has already built its service, which is what every
// verb but the unbuilt-repo test starts from.
function builtFactory(
  parent = tmp,
  yml = "service:\n  port: 9100\n  dashboard_port: 9200\n",
): string {
  const root = makeFactoryRepo(parent, yml);
  const entry = path.join(root, SERVICE_ENTRY);
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  return root;
}

const deps = (cwd: string, io: Fake, stopTimeoutMs?: number) => ({
  cwd,
  out: (line: string) => lines.push(line),
  processes: io.processes,
  ...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs }),
});

test("start runs the built entry in the factory root on the factory's port", () => {
  const root = builtFactory();
  writeFileSync(path.join(root, ".env"), "LINEAR_API_KEY=lin\nPORT=1234\n");
  const io = fake();

  startService(deps(root, io));

  const spec = io.spawns[0];
  expect(spec?.args).toEqual([SERVICE_ENTRY]);
  expect(spec?.cwd).toBe(root);
  expect(spec?.env.LINEAR_API_KEY).toBe("lin");
  // jigs.yml, not .env, is where a factory's address is declared.
  expect(spec?.env.PORT).toBe("9100");
  expect(lines[0]).toContain("at http://localhost:9100");
});

test("the child is told where to host its dashboard and where its queue delivers", () => {
  const root = builtFactory();
  const io = fake();

  startService(deps(root, io));

  expect(io.spawns[0]?.env.JIGS_DASHBOARD_PORT).toBe("9200");
  // Every queue worker in the child, the dashboard's included, dispatches to
  // the service's own workflow routes rather than a guessed port.
  expect(io.spawns[0]?.env.WORKFLOW_LOCAL_BASE_URL).toBe(
    "http://localhost:9100",
  );
  expect(lines).toContain("dashboard: http://localhost:9200");
});

test("the factory's own .env owns the world the service writes", () => {
  const root = builtFactory();
  writeFileSync(
    path.join(root, ".env"),
    "WORKFLOW_POSTGRES_URL=postgres://me:secret@db.internal:5432/mine\n",
  );
  const io = fake();

  startService(deps(root, io));

  expect(io.spawns[0]?.env.WORKFLOW_POSTGRES_URL).toBe(
    "postgres://me:secret@db.internal:5432/mine",
  );
});

test("start records the pid in a pidfile keyed by factory slug", () => {
  const root = builtFactory();
  startService(deps(root, fake()));
  const pidfile = servicePidfilePath(factorySlug(root));
  expect(readFileSync(pidfile, "utf8").trim()).toBe("4242");
});

test("start records which bundle the process runs, and a dead pid runs none", () => {
  const root = builtFactory();
  const io = fake();
  startService(deps(root, io));

  expect(runningBundleHash(deps(root, io))).toBe(builtBundleHash(root));
  writeFileSync(path.join(root, SERVICE_ENTRY), "rebuilt");
  expect(runningBundleHash(deps(root, io))).not.toBe(builtBundleHash(root));
  io.alive.clear();
  expect(runningBundleHash(deps(root, io))).toBeUndefined();
});

test("two factories supervise independently", () => {
  const one = builtFactory();
  const two = builtFactory(path.join(tmp, "second"));
  const io = fake();
  startService(deps(one, io));
  startService(deps(two, io));
  expect(existsSync(servicePidfilePath(factorySlug(one)))).toBe(true);
  expect(existsSync(servicePidfilePath(factorySlug(two)))).toBe(true);
});

test("start refuses when the factory has not built its service", () => {
  const root = makeFactoryRepo(tmp, "");
  const io = fake();
  const err = (() => {
    try {
      startService(deps(root, io));
    } catch (caught) {
      return caught as CliError;
    }
    return undefined;
  })();
  expect(err?.message).toContain(path.join(root, SERVICE_ENTRY));
  expect(err?.hint).toContain("jigs build");
  expect(io.spawns).toHaveLength(0);
});

test("start on a live pidfile does not spawn a second process", () => {
  const root = builtFactory();
  const io = fake();
  startService(deps(root, io));
  startService(deps(root, io));
  expect(io.spawns).toHaveLength(1);
  expect(lines.at(-1)).toContain("already running");
});

test("start replaces a pidfile whose process is gone", () => {
  const root = builtFactory();
  const pidfile = servicePidfilePath(factorySlug(root));
  mkdirSync(path.dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, "9\n");
  const io = fake();
  startService(deps(root, io));
  expect(io.spawns).toHaveLength(1);
  expect(readFileSync(pidfile, "utf8").trim()).toBe("4242");
});

test("stop terminates the recorded pid and clears the pidfile", async () => {
  const root = builtFactory();
  const io = fake();
  startService(deps(root, io));
  io.processes.signal = (pid, sig) => {
    io.signals.push({ pid, sig });
    if (sig === "SIGTERM") io.alive.delete(pid);
    return io.alive.has(pid);
  };

  await stopService(deps(root, io));

  expect(io.signals.map((s) => s.sig)).toContain("SIGTERM");
  expect(io.signals.map((s) => s.sig)).not.toContain("SIGKILL");
  expect(existsSync(servicePidfilePath(factorySlug(root)))).toBe(false);
});

test("stop escalates to SIGKILL when the process outlives the timeout", async () => {
  const root = builtFactory();
  const io = fake();
  startService(deps(root, io));

  await stopService(deps(root, io, 0));

  expect(io.signals.map((s) => s.sig)).toContain("SIGKILL");
  expect(existsSync(servicePidfilePath(factorySlug(root)))).toBe(false);
});

test("stop without a pidfile says so instead of failing", async () => {
  const root = builtFactory();
  await stopService(deps(root, fake()));
  expect(lines).toContain(`not running: ${factorySlug(root)}`);
});

test("status reports the pid, the url and the factory root", () => {
  const root = builtFactory();
  const io = fake();
  startService(deps(root, io));
  lines = [];

  serviceStatus(deps(root, io));

  expect(lines[0]).toBe(
    `${factorySlug(root)}: running pid 4242 at http://localhost:9100`,
  );
  expect(lines).toContain("dashboard: http://localhost:9200");
  expect(lines).toContain(`factory ${root}`);
});

test("status reports a dead pidfile as not running", () => {
  const root = builtFactory();
  const io = fake();
  startService(deps(root, io));
  io.alive.clear();
  lines = [];
  serviceStatus(deps(root, io));
  expect(lines[0]).toContain("not running");
});

test("service logs print the tail of the process's own output", () => {
  const root = builtFactory();
  const log = serviceLogPath(factorySlug(root));
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(log, "one\ntwo\nthree\n");

  serviceLogs(deps(root, fake()), { lines: 2 });

  expect(lines.slice(0, 2)).toEqual(["two", "three"]);
  expect(lines.at(-1)).toContain("tail -f");
});

test("service logs before a first start point at jigs service start", () => {
  const root = builtFactory();
  const err = (() => {
    try {
      serviceLogs(deps(root, fake()));
    } catch (caught) {
      return caught as CliError;
    }
    return undefined;
  })();
  expect(err?.message).toMatch(/no service log at/);
  expect(err?.hint).toContain("jigs service start");
});
