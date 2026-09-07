import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { JigsError } from "../errors.ts";
import { makeFactoryRepo, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { factorySlug } from "../worktrees/layout.ts";
import type {
  ServiceHealth,
  ServiceProcesses,
  SpawnSpec,
} from "./service-lifecycle.ts";
import {
  awaitServiceReady,
  builtBundleHash,
  restartService,
  runningBundleHash,
  SERVICE_ENTRY,
  serviceLogPath,
  serviceLogs,
  servicePidfilePath,
  serviceStatus,
  stalePipelineSources,
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
  probe: (url: string) => Promise<ServiceHealth | null>;
  spawns: SpawnSpec[];
  signals: Array<{ pid: number; sig: NodeJS.Signals | 0 }>;
  probes: string[];
  alive: Set<number>;
}

const READY: ServiceHealth = { ready: true, phase: "ready" };
const booting = (phase: string): ServiceHealth => ({ ready: false, phase });

// `health` is what /health answers to each probe in turn — null for no answer
// at all; the last entry repeats, so the default is a service up at once.
function fake(health: Array<ServiceHealth | null> = [READY]): Fake {
  const state: Fake = {
    spawns: [],
    signals: [],
    probes: [],
    alive: new Set(),
    processes: undefined as unknown as ServiceProcesses,
    probe: undefined as unknown as Fake["probe"],
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
  state.probe = async (url) => {
    state.probes.push(url);
    return health[Math.min(state.probes.length, health.length) - 1] ?? null;
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

const deps = (
  cwd: string,
  io: Fake,
  timeouts: { startTimeoutMs?: number; stopTimeoutMs?: number } = {},
) => ({
  cwd,
  out: (line: string) => lines.push(line),
  processes: io.processes,
  probe: io.probe,
  // The fake answers at once; the wait between probes is for a real boot.
  startPollMs: 0,
  ...timeouts,
});

const failure = (run: Promise<void>) =>
  run.then(
    () => undefined,
    (caught: unknown) => caught as JigsError,
  );

// SIGTERM ends the fake process, the way a service that owns its exit does.
function exitsOnTerm(io: Fake) {
  io.processes.signal = (pid, sig) => {
    io.signals.push({ pid, sig });
    if (sig === "SIGTERM") io.alive.delete(pid);
    return io.alive.has(pid);
  };
}

test("start runs the built entry in the factory root on the factory's port", async () => {
  const root = builtFactory();
  writeFileSync(path.join(root, ".env"), "LINEAR_API_KEY=lin\nPORT=1234\n");
  const io = fake();

  await startService(deps(root, io));

  const spec = io.spawns[0];
  expect(spec?.args).toEqual([SERVICE_ENTRY]);
  expect(spec?.cwd).toBe(root);
  expect(spec?.env.LINEAR_API_KEY).toBe("lin");
  // jigs.yml, not .env, is where a factory's address is declared.
  expect(spec?.env.PORT).toBe("9100");
  expect(lines[0]).toContain("at http://localhost:9100");
});

test("the child is told where to host its dashboard and where its queue delivers", async () => {
  const root = builtFactory();
  const io = fake();

  await startService(deps(root, io));

  expect(io.spawns[0]?.env.JIGS_DASHBOARD_PORT).toBe("9200");
  // Every queue worker in the child, the dashboard's included, dispatches to
  // the service's own workflow routes rather than a guessed port.
  expect(io.spawns[0]?.env.WORKFLOW_LOCAL_BASE_URL).toBe(
    "http://localhost:9100",
  );
  expect(lines).toContain("dashboard: http://localhost:9200");
});

test("the factory's own .env owns the world the service writes", async () => {
  const root = builtFactory();
  writeFileSync(
    path.join(root, ".env"),
    "WORKFLOW_POSTGRES_URL=postgres://me:secret@db.internal:5432/mine\n",
  );
  const io = fake();

  await startService(deps(root, io));

  expect(io.spawns[0]?.env.WORKFLOW_POSTGRES_URL).toBe(
    "postgres://me:secret@db.internal:5432/mine",
  );
});

test("start records the pid in a pidfile keyed by factory slug", async () => {
  const root = builtFactory();
  await startService(deps(root, fake()));
  const pidfile = servicePidfilePath(factorySlug(root));
  expect(readFileSync(pidfile, "utf8").trim()).toBe("4242");
});

test("start records which bundle the process runs, and a dead pid runs none", async () => {
  const root = builtFactory();
  const io = fake();
  await startService(deps(root, io));

  expect(runningBundleHash(deps(root, io))).toBe(builtBundleHash(root));
  writeFileSync(path.join(root, SERVICE_ENTRY), "rebuilt");
  expect(runningBundleHash(deps(root, io))).not.toBe(builtBundleHash(root));
  io.alive.clear();
  expect(runningBundleHash(deps(root, io))).toBeUndefined();
});

// Mtimes are set outright rather than by write order: a whole test's writes
// can land in one filesystem tick, and the question here is strictly which
// side of the build a source falls on.
function touch(root: string, relative: string, offsetMs: number): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "");
  const when = new Date(Date.now() + offsetMs);
  utimesSync(file, when, when);
}

test("only the sources edited since the build are named stale", () => {
  const root = builtFactory();
  touch(root, SERVICE_ENTRY, 0);
  touch(root, "jigs.config.ts", 60_000);
  touch(root, "pipelines/nested/ship.ts", 60_000);
  touch(root, "steps/jigs.ts", -60_000);

  expect(stalePipelineSources(root)).toEqual(["jigs.config.ts", "pipelines"]);
});

test("a build newer than every source is stale in nothing", () => {
  const root = builtFactory();
  touch(root, "jigs.config.ts", -60_000);
  touch(root, "pipelines/ship.ts", -60_000);
  touch(root, SERVICE_ENTRY, 0);

  expect(stalePipelineSources(root)).toEqual([]);
});

test("a factory with no build at all is not stale — it is unbuilt", () => {
  const root = makeFactoryRepo(tmp, "");
  touch(root, "jigs.config.ts", 60_000);

  expect(stalePipelineSources(root)).toEqual([]);
});

test("two factories supervise independently", async () => {
  const one = builtFactory();
  const two = builtFactory(path.join(tmp, "second"));
  const io = fake();
  await startService(deps(one, io));
  await startService(deps(two, io));
  expect(existsSync(servicePidfilePath(factorySlug(one)))).toBe(true);
  expect(existsSync(servicePidfilePath(factorySlug(two)))).toBe(true);
});

test("start refuses when the factory has not built its service", async () => {
  const root = makeFactoryRepo(tmp, "");
  const io = fake();
  const err = await failure(startService(deps(root, io)));
  expect(err?.message).toContain(path.join(root, SERVICE_ENTRY));
  expect(err?.hint).toContain("jigs build");
  expect(io.spawns).toHaveLength(0);
});

test("start on a live pidfile does not spawn a second process", async () => {
  const root = builtFactory();
  const io = fake();
  await startService(deps(root, io));
  await startService(deps(root, io));
  expect(io.spawns).toHaveLength(1);
  expect(lines.at(-1)).toContain("already running");
});

test("start replaces a pidfile whose process is gone", async () => {
  const root = builtFactory();
  const pidfile = servicePidfilePath(factorySlug(root));
  mkdirSync(path.dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, "9\n");
  const io = fake();
  await startService(deps(root, io));
  expect(io.spawns).toHaveLength(1);
  expect(readFileSync(pidfile, "utf8").trim()).toBe("4242");
});

// A 200 from /health is not enough: nitro answers it before the plugins that
// clone the bindings and start the World have run.
test("start says started only once /health reports ready, printing the phases on the way", async () => {
  const root = builtFactory();
  const io = fake([
    null,
    booting("registry"),
    booting("cloning forge"),
    booting("cloning forge"),
    booting("world"),
    READY,
  ]);

  await startService(deps(root, io));

  expect(io.probes).toEqual(Array(6).fill("http://localhost:9100/health"));
  expect(lines).toEqual([
    "booting: registry",
    "booting: cloning forge",
    "booting: world",
    expect.stringContaining("started"),
    "dashboard: http://localhost:9200",
    expect.stringContaining("logs: "),
  ]);
});

test("a process that dies while booting fails the start at once, printing its log", async () => {
  const root = builtFactory();
  const io = fake([booting("cloning forge")]);
  const probe = io.probe;
  io.probe = async (url) => {
    io.alive.clear();
    const log = serviceLogPath(factorySlug(root));
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, "cloning binding forge\nfatal: repo gone\n");
    return probe(url);
  };

  const err = await failure(startService(deps(root, io)));

  expect(err?.message).toContain("exited during boot");
  expect(err?.hint).toContain(serviceLogPath(factorySlug(root)));
  expect(lines).toEqual([
    "booting: cloning forge",
    "cloning binding forge",
    "fatal: repo gone",
  ]);
  expect(io.probes).toHaveLength(1);
  // Nothing is left to supervise.
  expect(existsSync(servicePidfilePath(factorySlug(root)))).toBe(false);
});

test("a start that outlives its timeout fails, names the log and the phase, and keeps the live pid supervised", async () => {
  const root = builtFactory();
  const io = fake([booting("cloning forge")]);

  const err = await failure(
    startService(deps(root, io, { startTimeoutMs: 0 })),
  );

  expect(err?.message).toContain("still booting");
  expect(err?.message).toContain("cloning forge");
  expect(err?.hint).toContain(serviceLogPath(factorySlug(root)));
  expect(err?.hint).toContain("jigs service stop");
  expect(
    readFileSync(servicePidfilePath(factorySlug(root)), "utf8").trim(),
  ).toBe("4242");
});

// `jigs up` names the spawn and the wait as two steps.
test("a start told not to wait spawns without probing, and awaitServiceReady waits afterwards", async () => {
  const root = builtFactory();
  const io = fake([booting("world"), READY]);

  await startService(deps(root, io), { awaitReady: false });
  expect(io.probes).toHaveLength(0);
  expect(lines[0]).toContain("started");

  await awaitServiceReady(deps(root, io));
  expect(io.probes).toHaveLength(2);
  expect(lines).toContain("booting: world");
});

test("awaitServiceReady on a pid that died reports the failed boot", async () => {
  const root = builtFactory();
  const io = fake();
  await startService(deps(root, io), { awaitReady: false });
  io.alive.clear();

  const err = await failure(awaitServiceReady(deps(root, io)));

  expect(err?.message).toContain("exited during boot");
  expect(existsSync(servicePidfilePath(factorySlug(root)))).toBe(false);
});

test("awaitServiceReady without a pidfile says the service is not running", async () => {
  const root = builtFactory();
  const err = await failure(awaitServiceReady(deps(root, fake())));
  expect(err?.message).toContain("not running");
  expect(err?.hint).toContain("jigs service start");
});

test("restart waits for the new process to be ready too", async () => {
  const root = builtFactory();
  const io = fake([READY, booting("world"), READY]);
  await startService(deps(root, io));
  exitsOnTerm(io);
  lines = [];

  await restartService(deps(root, io));

  expect(io.spawns).toHaveLength(2);
  expect(io.probes).toHaveLength(3);
  expect(lines[0]).toContain("stopped");
  expect(lines[1]).toBe("booting: world");
  expect(lines[2]).toContain("started");
});

test("stop terminates the recorded pid and clears the pidfile", async () => {
  const root = builtFactory();
  const io = fake();
  await startService(deps(root, io));
  exitsOnTerm(io);

  await stopService(deps(root, io));

  expect(io.signals.map((s) => s.sig)).toContain("SIGTERM");
  expect(io.signals.map((s) => s.sig)).not.toContain("SIGKILL");
  expect(existsSync(servicePidfilePath(factorySlug(root)))).toBe(false);
});

test("stop escalates to SIGKILL when the process outlives the timeout", async () => {
  const root = builtFactory();
  const io = fake();
  await startService(deps(root, io));

  await stopService(deps(root, io, { stopTimeoutMs: 0 }));

  expect(io.signals.map((s) => s.sig)).toContain("SIGKILL");
  expect(existsSync(servicePidfilePath(factorySlug(root)))).toBe(false);
});

test("stop without a pidfile says so instead of failing", async () => {
  const root = builtFactory();
  await stopService(deps(root, fake()));
  expect(lines).toContain(`not running: ${factorySlug(root)}`);
});

test("status reports the pid, the url and the factory root", async () => {
  const root = builtFactory();
  const io = fake();
  await startService(deps(root, io));
  lines = [];

  serviceStatus(deps(root, io));

  expect(lines[0]).toBe(
    `${factorySlug(root)}: running pid 4242 at http://localhost:9100`,
  );
  expect(lines).toContain("dashboard: http://localhost:9200");
  expect(lines).toContain(`factory ${root}`);
});

test("status reports a dead pidfile as not running", async () => {
  const root = builtFactory();
  const io = fake();
  await startService(deps(root, io));
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
      return caught as JigsError;
    }
    return undefined;
  })();
  expect(err?.message).toMatch(/no service log at/);
  expect(err?.hint).toContain("jigs service start");
});
