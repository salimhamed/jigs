import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  type ResolvedService,
  resolveService,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/factory-root.ts";
import { CliError } from "../errors.ts";
import { stringEnv } from "../harnesses/env.ts";
import { jigsDataDir } from "../paths.ts";

// Supervision is a pidfile under the jigs data dir, keyed by factory slug —
// not a systemd unit. A service per factory repo would otherwise need a unit
// per factory, and the CLI would have to generate, install and name them;
// the pidfile keeps jigs portable and collapses every "how do I restart
// this" repair string to one constant, `jigs service restart`.

// The factory repo builds its service with nitro; this is where that build
// lands. Producing it is `jigs build`'s job, so a missing entry is an error
// here, never something the supervisor silently builds.
export const SERVICE_ENTRY = ".output/server/index.mjs";

const STOP_TIMEOUT_MS = 10_000;
// A boot clones every binding, and a first clone of a large repo is a minute.
const START_TIMEOUT_MS = 300_000;
const POLL_MS = 100;
const START_POLL_MS = 200;
const LOG_LINES = 50;

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}

// With the probe below, the only things a test cannot do for real. Every file
// this module touches is either in the factory repo under test or under
// `jigsDataDir()`, which `XDG_DATA_HOME` already redirects.
export interface ServiceProcesses {
  spawn(spec: SpawnSpec): number | undefined;
  // node's `kill(pid, 0)` semantics: false only when the process is gone.
  signal(pid: number, sig: NodeJS.Signals | 0): boolean;
}

// What the service's /health says about its boot; null when it does not
// answer at all.
export interface ServiceHealth {
  ready: boolean;
  phase: string;
}

export interface ServiceLifecycleDeps {
  cwd: string;
  out: (line: string) => void;
  processes?: ServiceProcesses;
  probe?: (url: string) => Promise<ServiceHealth | null>;
  startTimeoutMs?: number;
  startPollMs?: number;
  stopTimeoutMs?: number;
}

export interface StartOptions {
  // `jigs up` spawns in one step and waits in the next, so it can name them
  // apart; everything else waits here.
  awaitReady?: boolean;
}

interface Supervisor {
  factoryRoot: string;
  service: ResolvedService;
  processes: ServiceProcesses;
  probe: (url: string) => Promise<ServiceHealth | null>;
  out: (line: string) => void;
  startTimeoutMs: number;
  startPollMs: number;
  stopTimeoutMs: number;
}

export function servicePidfilePath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.pid`);
}

export function serviceLogPath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.log`);
}

// Which bundle the running process was started from, so a later `jigs up`
// can tell a rebuild that changed nothing from one the service has yet to
// pick up.
export function serviceBundlePath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.bundle`);
}

export function builtBundleHash(factoryRoot: string): string | undefined {
  const entry = path.join(factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) return undefined;
  return createHash("sha256").update(readFileSync(entry)).digest("hex");
}

export function runningBundleHash(
  deps: ServiceLifecycleDeps,
): string | undefined {
  const sv = resolveSupervisor(deps);
  if (livePid(sv) === undefined) return undefined;
  const file = serviceBundlePath(sv.service.slug);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

// Walks for the factory repo and parses its jigs.yml, so this throws when the
// caller is not standing in a factory.
function resolveSupervisor(deps: ServiceLifecycleDeps): Supervisor {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  return {
    factoryRoot,
    service: resolveService(factoryRoot),
    processes: deps.processes ?? nodeProcesses,
    probe: deps.probe ?? healthProbe,
    out: deps.out,
    startTimeoutMs: deps.startTimeoutMs ?? START_TIMEOUT_MS,
    startPollMs: deps.startPollMs ?? START_POLL_MS,
    stopTimeoutMs: deps.stopTimeoutMs ?? STOP_TIMEOUT_MS,
  };
}

function readPid(sv: Supervisor): number | undefined {
  const file = servicePidfilePath(sv.service.slug);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function livePid(sv: Supervisor): number | undefined {
  const pid = readPid(sv);
  if (pid === undefined) return undefined;
  return sv.processes.signal(pid, 0) ? pid : undefined;
}

// For a caller deciding on liveness rather than reporting it.
export function liveServicePid(deps: ServiceLifecycleDeps): number | undefined {
  return livePid(resolveSupervisor(deps));
}

// The factory's own `.env` is the service's environment file, World URL and
// credentials included. What jigs.yml declares wins over it: the two addresses
// the child listens on, and the base URL derived from the first of them.
//
// `WORKFLOW_LOCAL_BASE_URL` pins every queue worker in the child — the
// dashboard's included — to the service's own workflow routes. Left unset the
// World guesses a port the process happens to listen on, and a queue job
// delivered to a port with no workflow route dies after three 404s.
function childEnv(sv: Supervisor): Record<string, string> {
  const dotenvPath = path.join(sv.factoryRoot, ".env");
  return {
    ...stringEnv(process.env),
    ...(existsSync(dotenvPath)
      ? (parseEnv(readFileSync(dotenvPath, "utf8")) as Record<string, string>)
      : {}),
    PORT: String(sv.service.port),
    JIGS_DASHBOARD_PORT: String(sv.service.dashboardPort),
    WORKFLOW_LOCAL_BASE_URL: sv.service.serviceUrl,
  };
}

export async function startService(
  deps: ServiceLifecycleDeps,
  options: StartOptions = {},
): Promise<void> {
  const sv = resolveSupervisor(deps);
  const running = livePid(sv);
  if (running !== undefined) {
    sv.out(`already running: pid ${running} at ${sv.service.serviceUrl}`);
    return;
  }

  const entry = path.join(sv.factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) {
    throw new CliError(
      `no built service at ${entry}`,
      `build this factory's service first: jigs build in ${sv.factoryRoot}`,
    );
  }

  const logFile = serviceLogPath(sv.service.slug);
  const pid = sv.processes.spawn({
    command: process.execPath,
    args: [SERVICE_ENTRY],
    cwd: sv.factoryRoot,
    env: childEnv(sv),
    logPath: logFile,
  });
  if (pid === undefined) {
    throw new CliError(
      `the service process for ${sv.service.slug} did not start`,
      `check ${logFile}`,
    );
  }

  const pidfile = servicePidfilePath(sv.service.slug);
  mkdirSync(path.dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, `${pid}\n`);
  writeFileSync(
    serviceBundlePath(sv.service.slug),
    `${builtBundleHash(sv.factoryRoot)}\n`,
  );
  if (options.awaitReady !== false) await awaitReady(sv, pid);
  sv.out(`started ${sv.service.slug}: pid ${pid} at ${sv.service.serviceUrl}`);
  sv.out(`dashboard: ${sv.service.dashboardUrl}`);
  sv.out(`logs: ${logFile}`);
}

/**
 * Waits for the recorded service to report itself ready. What `start` does
 * before it says "started", for a caller that spawned without waiting.
 */
export async function awaitServiceReady(
  deps: ServiceLifecycleDeps,
): Promise<void> {
  const sv = resolveSupervisor(deps);
  const pid = readPid(sv);
  if (pid === undefined) {
    throw new CliError(
      `not running: ${sv.service.slug}`,
      "start it: jigs service start",
    );
  }
  if (!sv.processes.signal(pid, 0)) throw failedBoot(sv, pid);
  await awaitReady(sv, pid);
}

// "started" means the World is up and every binding cloned, not that the port
// answers: nitro serves /health before its plugins run, so a 200 says nothing
// about a boot that a failed clone can still end a minute later.
async function awaitReady(sv: Supervisor, pid: number): Promise<void> {
  const deadline = Date.now() + sv.startTimeoutMs;
  let phase: string | undefined;
  for (;;) {
    const health = await sv.probe(`${sv.service.serviceUrl}/health`);
    if (health?.ready) return;
    if (health !== null && health.phase !== phase) {
      phase = health.phase;
      sv.out(`booting: ${phase}`);
    }
    if (!sv.processes.signal(pid, 0)) throw failedBoot(sv, pid);
    if (Date.now() >= deadline) {
      throw new CliError(
        `the ${sv.service.slug} service is still booting after ${sv.startTimeoutMs / 1000}s — pid ${pid} is still running${phase === undefined ? "" : ` (${phase})`}`,
        `it clones every binding before the World starts — watch jigs service logs (${serviceLogPath(sv.service.slug)}); jigs service stop ends it`,
      );
    }
    await sleep(sv.startPollMs);
  }
}

// The gates exit the process when a clone or the registry fails, so a pid
// gone mid-boot is the failed boot itself; its log is the explanation, and
// the last lines of it are worth more here than a path.
function failedBoot(sv: Supervisor, pid: number): CliError {
  const logFile = serviceLogPath(sv.service.slug);
  for (const line of tailLines(logFile, LOG_LINES)) sv.out(line);
  rmSync(servicePidfilePath(sv.service.slug), { force: true });
  return new CliError(
    `the ${sv.service.slug} service exited during boot (pid ${pid})`,
    `its log says why: jigs service logs (${logFile})`,
  );
}

async function healthProbe(url: string): Promise<ServiceHealth | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      ready?: boolean;
      phase?: string;
    };
    // A service built before /health reported readiness answers with neither
    // field; answering at all was its whole readiness.
    return { ready: body.ready ?? true, phase: body.phase ?? "up" };
  } catch {
    return null;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function stopService(deps: ServiceLifecycleDeps): Promise<void> {
  const sv = resolveSupervisor(deps);
  const pid = readPid(sv);
  const pidfile = servicePidfilePath(sv.service.slug);
  if (pid === undefined || !sv.processes.signal(pid, 0)) {
    if (pid !== undefined) rmSync(pidfile, { force: true });
    sv.out(`not running: ${sv.service.slug}`);
    return;
  }

  sv.processes.signal(pid, "SIGTERM");
  const deadline = Date.now() + sv.stopTimeoutMs;
  while (sv.processes.signal(pid, 0)) {
    if (Date.now() >= deadline) {
      sv.processes.signal(pid, "SIGKILL");
      sv.out(`pid ${pid} ignored SIGTERM — killed`);
      break;
    }
    await sleep(POLL_MS);
  }
  rmSync(pidfile, { force: true });
  sv.out(`stopped ${sv.service.slug}: pid ${pid}`);
}

export async function restartService(
  deps: ServiceLifecycleDeps,
  options: StartOptions = {},
): Promise<void> {
  await stopService(deps);
  await startService(deps, options);
}

export function serviceStatus(deps: ServiceLifecycleDeps): void {
  const sv = resolveSupervisor(deps);
  const pid = livePid(sv);
  sv.out(
    pid === undefined
      ? `${sv.service.slug}: not running (${sv.service.serviceUrl})`
      : `${sv.service.slug}: running pid ${pid} at ${sv.service.serviceUrl}`,
  );
  sv.out(`dashboard: ${sv.service.dashboardUrl}`);
  sv.out(`factory ${sv.factoryRoot}`);
}

// `jigs logs <run>` is about a run — it resolves the ref and points at the
// run's page on the dashboard the service hosts. This is about the process:
// the stdout the supervisor redirects, which no dashboard can know about.
// Different subject, so the `service` namespace keeps them apart rather than
// one shadowing the other.
export function serviceLogs(
  deps: ServiceLifecycleDeps,
  options: { lines?: number } = {},
): void {
  const sv = resolveSupervisor(deps);
  const file = serviceLogPath(sv.service.slug);
  if (!existsSync(file)) {
    throw new CliError(
      `no service log at ${file}`,
      `this factory's service has not run yet: jigs service start`,
    );
  }
  for (const line of tailLines(file, options.lines ?? LOG_LINES)) sv.out(line);
  sv.out(`(follow: tail -f ${file})`);
}

function tailLines(file: string, count: number): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count);
}

const nodeProcesses: ServiceProcesses = {
  spawn(spec) {
    mkdirSync(path.dirname(spec.logPath), { recursive: true });
    const fd = openSync(spec.logPath, "a");
    try {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      return child.pid;
    } finally {
      closeSync(fd);
    }
  },
  signal(pid, sig) {
    try {
      process.kill(pid, sig);
      return true;
    } catch (err) {
      // ESRCH is the only "gone" answer. Anything else — EPERM on a pid the
      // OS recycled to another user — is not a liveness verdict, so surface
      // it rather than report a process alive or dead on a guess.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw err;
    }
  },
};
