import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type ResolvedService,
  resolveService,
} from "../../config/factory-config.ts";
import { readFactoryEnv } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { jigsDataDir } from "../../config/paths.ts";
import { JigsError } from "../../errors.ts";
import { stringEnv } from "../../steps/agent/harnesses/env.ts";

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

// What `jigs build` compiles into the bundle. An edit to one of them that was
// never built is invisible at run time: the service keeps executing the bundle
// it booted from.
const PIPELINE_SOURCES = ["jigs.config.ts", "pipelines", "steps"];

// A test file beside a pipeline is compiled into no bundle, so editing one
// leaves the build current.
const NOT_COMPILED = /\.(test|spec)\.[cm]?tsx?$/;

// Empty when the factory has no bundle at all — an unbuilt factory, not a
// build gone stale.
export function stalePipelineSources(factoryRoot: string): string[] {
  const entry = path.join(factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) return [];
  const builtAt = statSync(entry).mtimeMs;
  return PIPELINE_SOURCES.filter((source) =>
    newerThan(path.join(factoryRoot, source), builtAt),
  );
}

function newerThan(target: string, builtAt: number): boolean {
  if (!existsSync(target)) return false;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs > builtAt;
  // The directory's own mtime counts too: a delete, or a rename that carries
  // the old file's mtime along, leaves no newer file behind.
  if (stat.mtimeMs > builtAt) return true;
  return readdirSync(target, { recursive: true, withFileTypes: true }).some(
    (entry) =>
      (entry.isFile() || entry.isDirectory()) &&
      !NOT_COMPILED.test(entry.name) &&
      statSync(path.join(entry.parentPath, entry.name)).mtimeMs > builtAt,
  );
}

type BundleDeps = Pick<ServiceLifecycleDeps, "cwd" | "processes">;

export function runningBundleHash(deps: BundleDeps): string | undefined {
  const { processes = nodeProcesses } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  if (livePid(slug, processes) === undefined) return undefined;
  const file = serviceBundlePath(slug);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

// Why a run launched now would not execute the sources on disk: the bundle is
// behind them, or the running process is behind the bundle — a build nobody
// restarted onto. Undefined for an unbuilt factory.
export function serviceBehindSources(deps: BundleDeps): string | undefined {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  if (!existsSync(path.join(factoryRoot, SERVICE_ENTRY))) return undefined;
  const stale = stalePipelineSources(factoryRoot);
  if (stale.length > 0) {
    return `${stale.join(", ")} newer than the built service`;
  }
  const running = runningBundleHash(deps);
  if (running !== undefined && running !== builtBundleHash(factoryRoot)) {
    return "the service is running an earlier bundle than the one built";
  }
  return undefined;
}

function readPid(slug: string): number | undefined {
  const file = servicePidfilePath(slug);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function livePid(
  slug: string,
  processes: ServiceProcesses,
): number | undefined {
  const pid = readPid(slug);
  if (pid === undefined) return undefined;
  return processes.signal(pid, 0) ? pid : undefined;
}

// For a caller deciding on liveness rather than reporting it.
export function liveServicePid(deps: ServiceLifecycleDeps): number | undefined {
  const { processes = nodeProcesses } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  return livePid(slug, processes);
}

// The factory's own `.env` is the service's environment file, World URL and
// credentials included. What jigs.yml declares wins over it: the two addresses
// the child listens on, and the base URL derived from the first of them.
//
// `WORKFLOW_LOCAL_BASE_URL` pins every queue worker in the child — the
// dashboard's included — to the service's own workflow routes. Left unset the
// World guesses a port the process happens to listen on, and a queue job
// delivered to a port with no workflow route dies after three 404s.
function childEnv(
  factoryRoot: string,
  service: ResolvedService,
): Record<string, string> {
  return {
    ...stringEnv(process.env),
    ...readFactoryEnv(factoryRoot),
    PORT: String(service.port),
    JIGS_DASHBOARD_PORT: String(service.dashboardPort),
    WORKFLOW_LOCAL_BASE_URL: service.serviceUrl,
  };
}

export async function startService(
  deps: ServiceLifecycleDeps,
  options: StartOptions = {},
): Promise<void> {
  const { out, processes = nodeProcesses } = deps;
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const service = resolveService(factoryRoot);
  const { slug, serviceUrl, dashboardUrl } = service;

  const running = livePid(slug, processes);
  if (running !== undefined) {
    out(`already running: pid ${running} at ${serviceUrl}`);
    return;
  }

  const entry = path.join(factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) {
    throw new JigsError(
      `no built service at ${entry}`,
      `build this factory's service first: jigs build in ${factoryRoot}`,
    );
  }

  const logFile = serviceLogPath(slug);
  const pid = processes.spawn({
    command: process.execPath,
    args: [SERVICE_ENTRY],
    cwd: factoryRoot,
    env: childEnv(factoryRoot, service),
    logPath: logFile,
  });
  if (pid === undefined) {
    throw new JigsError(
      `the service process for ${slug} did not start`,
      `check ${logFile}`,
    );
  }

  const pidfile = servicePidfilePath(slug);
  mkdirSync(path.dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, `${pid}\n`);
  writeFileSync(serviceBundlePath(slug), `${builtBundleHash(factoryRoot)}\n`);
  if (options.awaitReady !== false)
    await awaitReady(deps, slug, serviceUrl, pid);
  out(`started ${slug}: pid ${pid} at ${serviceUrl}`);
  out(`dashboard: ${dashboardUrl}`);
  out(`logs: ${logFile}`);
}

/**
 * Waits for the recorded service to report itself ready. What `start` does
 * before it says "started", for a caller that spawned without waiting.
 */
export async function awaitServiceReady(
  deps: ServiceLifecycleDeps,
): Promise<void> {
  const { out, processes = nodeProcesses } = deps;
  const { slug, serviceUrl } = resolveService(locateFactoryRoot(deps.cwd));
  const pid = readPid(slug);
  if (pid === undefined) {
    throw new JigsError(`not running: ${slug}`, "start it: jigs service start");
  }
  if (!processes.signal(pid, 0)) throw failedBoot(slug, pid, out);
  await awaitReady(deps, slug, serviceUrl, pid);
}

// "started" means the World is up and every binding cloned, not that the port
// answers: nitro serves /health before its plugins run, so a 200 says nothing
// about a boot that a failed clone can still end a minute later.
async function awaitReady(
  deps: ServiceLifecycleDeps,
  slug: string,
  serviceUrl: string,
  pid: number,
): Promise<void> {
  const {
    out,
    probe = healthProbe,
    processes = nodeProcesses,
    startTimeoutMs = START_TIMEOUT_MS,
    startPollMs = START_POLL_MS,
  } = deps;
  const deadline = Date.now() + startTimeoutMs;
  let phase: string | undefined;
  for (;;) {
    const health = await probe(`${serviceUrl}/health`);
    if (health?.ready) return;
    if (health !== null && health.phase !== phase) {
      phase = health.phase;
      out(`booting: ${phase}`);
    }
    if (!processes.signal(pid, 0)) throw failedBoot(slug, pid, out);
    if (Date.now() >= deadline) {
      throw new JigsError(
        `the ${slug} service is still booting after ${startTimeoutMs / 1000}s — pid ${pid} is still running${phase === undefined ? "" : ` (${phase})`}`,
        `it clones every binding before the World starts — watch jigs service logs (${serviceLogPath(slug)}); jigs service stop ends it`,
      );
    }
    await sleep(startPollMs);
  }
}

// The gates exit the process when a clone or the registry fails, so a pid
// gone mid-boot is the failed boot itself; its log is the explanation, and
// the last lines of it are worth more here than a path.
function failedBoot(
  slug: string,
  pid: number,
  out: (line: string) => void,
): JigsError {
  const logFile = serviceLogPath(slug);
  for (const line of tailLines(logFile, LOG_LINES)) out(line);
  rmSync(servicePidfilePath(slug), { force: true });
  return new JigsError(
    `the ${slug} service exited during boot (pid ${pid})`,
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
  const {
    out,
    processes = nodeProcesses,
    stopTimeoutMs = STOP_TIMEOUT_MS,
  } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  const pid = readPid(slug);
  const pidfile = servicePidfilePath(slug);
  if (pid === undefined || !processes.signal(pid, 0)) {
    if (pid !== undefined) rmSync(pidfile, { force: true });
    out(`not running: ${slug}`);
    return;
  }

  processes.signal(pid, "SIGTERM");
  const deadline = Date.now() + stopTimeoutMs;
  while (processes.signal(pid, 0)) {
    if (Date.now() >= deadline) {
      processes.signal(pid, "SIGKILL");
      out(`pid ${pid} ignored SIGTERM — killed`);
      break;
    }
    await sleep(POLL_MS);
  }
  rmSync(pidfile, { force: true });
  out(`stopped ${slug}: pid ${pid}`);
}

export async function restartService(
  deps: ServiceLifecycleDeps,
  options: StartOptions = {},
): Promise<void> {
  await stopService(deps);
  await startService(deps, options);
}

export function serviceStatus(deps: ServiceLifecycleDeps): void {
  const { out, processes = nodeProcesses } = deps;
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const { slug, serviceUrl, dashboardUrl } = resolveService(factoryRoot);
  const pid = livePid(slug, processes);
  out(
    pid === undefined
      ? `${slug}: not running (${serviceUrl})`
      : `${slug}: running pid ${pid} at ${serviceUrl}`,
  );
  out(`dashboard: ${dashboardUrl}`);
  out(`factory ${factoryRoot}`);
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
  const { out } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  const file = serviceLogPath(slug);
  if (!existsSync(file)) {
    throw new JigsError(
      `no service log at ${file}`,
      `this factory's service has not run yet: jigs service start`,
    );
  }
  for (const line of tailLines(file, options.lines ?? LOG_LINES)) out(line);
  out(`(follow: tail -f ${file})`);
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
