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
  readFactoryConfig,
  resolveService,
} from "../../config/factory-config.ts";
import { readFactoryEnv } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { jigsDataDir } from "../../config/paths.ts";
import { JigsError } from "../../errors.ts";
import { stringEnv } from "../../steps/agents/harnesses/env.ts";
import {
  judgeRecord,
  type ProcessControl,
  type ProcessEntry,
  parsePs,
  type ServiceRecord,
  type ServiceTarget,
  stopProcessTree,
  systemProcesses,
} from "./process-tree.ts";

// Supervision is a pidfile and a service record under the jigs data dir, keyed
// by factory slug. The service leads its own process group, so the group finds
// what it started even after a parent in between has exited; the record's boot
// ID, start time and command tell the service apart from a later process that
// got the same pid.

// The factory repo builds its service with nitro; this is where that build
// lands. Producing it is `jigs build`'s job, so a missing entry is an error
// here, never something the supervisor silently builds.
export const SERVICE_ENTRY = ".output/server/index.mjs";

const STOP_TIMEOUT_MS = 10_000;
const KILL_WAIT_MS = 2_000;
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
export interface ServiceProcesses extends ProcessControl {
  /** Starts the process as the leader of a new process group. */
  spawn(spec: SpawnSpec): number | undefined;
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
  killWaitMs?: number;
  now?: () => Date;
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

export function serviceExclusionPath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.maintenance-lock`);
}

export function serviceSupervisionPath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.supervision`);
}

function readRecord(slug: string): ServiceRecord | undefined {
  const file = serviceSupervisionPath(slug);
  if (!existsSync(file)) return undefined;
  const record = parseRecord(readFileSync(file, "utf8"));
  if (record === undefined) {
    throw new JigsError(
      `the service record at ${file} is unreadable`,
      `check with ps that nothing this factory's service started is still running, then delete ${file}`,
    );
  }
  return record;
}

function parseRecord(text: string): ServiceRecord | undefined {
  let value: Partial<ServiceRecord>;
  try {
    value = JSON.parse(text) as Partial<ServiceRecord>;
  } catch {
    return undefined;
  }
  const { processGroup, bootId, startTime, command } = value;
  if (!Number.isInteger(processGroup) || (processGroup as number) <= 0) return undefined;
  if (typeof bootId !== "string" || typeof startTime !== "string") return undefined;
  if (typeof command !== "string") return undefined;
  return { processGroup: processGroup as number, bootId, startTime, command };
}

/**
 * The service as its records and the running processes describe it.
 *
 * - `none`: nothing recorded; `discarded` when the records were from before
 *   the machine last restarted and were deleted.
 * - `running`: the recorded service is running.
 * - `stopped`: the service has exited. `orphanGroup` is its process group
 *   while processes it started could still be in it.
 */
type ServiceState =
  | { kind: "none"; discarded: boolean }
  | { kind: "running"; pid: number; processGroup: number }
  | { kind: "stopped"; orphanGroup: number | undefined };

// Throws rather than guess when the pidfile names a live process that the
// record cannot vouch for: stopping it could kill someone else's process, and
// ignoring it could start a second service.
function inspectService(slug: string, processes: ServiceProcesses): ServiceState {
  const pidfile = servicePidfilePath(slug);
  const recordFile = serviceSupervisionPath(slug);
  const pid = readPid(slug);
  const record = readRecord(slug);
  const entries = parsePs(processes.snapshot());
  const unverified = (entry: ProcessEntry, why: string) =>
    new JigsError(
      `pid ${entry.pid} in ${pidfile} cannot be verified as the ${slug} service: ${entry.command}`,
      `${why}; if that process is not this factory's service, delete ${pidfile} and ${recordFile}, otherwise stop it yourself`,
    );

  if (record === undefined) {
    if (pid === undefined) return { kind: "none", discarded: false };
    const alive = entries.find((entry) => entry.pid === pid);
    if (alive !== undefined) throw unverified(alive, `there is no service record at ${recordFile}`);
    rmSync(pidfile, { force: true });
    return { kind: "none", discarded: false };
  }
  if (pid !== undefined && pid !== record.processGroup) {
    throw new JigsError(
      `${pidfile} names pid ${pid} but ${recordFile} names pid ${record.processGroup}`,
      `check with ps that neither is this factory's service, then delete both files`,
    );
  }

  const verdict = judgeRecord(record, {
    bootId: processes.bootId(),
    entries,
    startTime: (leader) => processes.startTime(leader),
  });
  switch (verdict.kind) {
    case "previous-boot":
      rmSync(pidfile, { force: true });
      rmSync(recordFile, { force: true });
      return { kind: "none", discarded: true };
    case "service":
      return { kind: "running", pid: verdict.leader.pid, processGroup: record.processGroup };
    case "leader-gone":
      return { kind: "stopped", orphanGroup: record.processGroup };
    case "reused":
      if (pid !== undefined) {
        throw unverified(
          verdict.leader,
          "its start time or command differs from the service record",
        );
      }
      return { kind: "stopped", orphanGroup: undefined };
  }
}

/**
 * Excludes service startup from offline resource maintenance. The directory
 * creation is the cross-process compare-and-set; a crashed holder is left in
 * place deliberately because guessing that a maintenance pass is gone would
 * reopen the startup/removal race.
 */
export function acquireServiceExclusion(
  slug: string,
  purpose: "start" | "resources-prune",
): () => void {
  const lock = serviceExclusionPath(slug);
  mkdirSync(path.dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new JigsError(
        `factory maintenance exclusion is already held at ${lock}`,
        "wait for the other command to finish; if it crashed, inspect that directory before removing it",
      );
    }
    throw error;
  }
  writeFileSync(
    path.join(lock, "owner.json"),
    `${JSON.stringify({ pid: process.pid, purpose })}\n`,
  );
  return () => rmSync(lock, { recursive: true, force: true });
}

function serviceRunStatePath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.run.json`);
}

interface ServiceRunState {
  logOffset: number;
  deathDetectedAt?: string;
  signal?: string;
}

export function builtBundleHash(factoryRoot: string): string | undefined {
  const entry = path.join(factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) return undefined;
  const hash = createHash("sha256");
  const output = path.dirname(entry);
  for (const name of readdirSync(output, { recursive: true }).map(String).sort()) {
    const file = path.join(output, name);
    if (statSync(file).isFile()) hash.update(name).update("\0").update(readFileSync(file));
  }
  // Service ports and binding settings are also read from the factory at boot.
  hash.update(JSON.stringify(readFactoryConfig(factoryRoot)));
  return hash.digest("hex");
}

// What `jigs build` compiles into the bundle. An edit to one of them that was
// never built is invisible at run time: the service keeps executing the bundle
// it booted from.
const WORKFLOW_SOURCES = ["jigs.config.ts", "jigs", "workflows", "blocks", "steps"];

// A test file beside a workflow is compiled into no bundle, so editing one
// leaves the build current.
const NOT_COMPILED = /\.(test|spec)\.[cm]?tsx?$/;

// Empty when the factory has no bundle at all — an unbuilt factory, not a
// build gone stale.
export function staleWorkflowSources(factoryRoot: string): string[] {
  const entry = path.join(factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) return [];
  const builtAt = statSync(entry).mtimeMs;
  return WORKFLOW_SOURCES.filter((source) => newerThan(path.join(factoryRoot, source), builtAt));
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
  const stale = staleWorkflowSources(factoryRoot);
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

function livePid(slug: string, processes: ServiceProcesses): number | undefined {
  const state = inspectService(slug, processes);
  return state.kind === "running" ? state.pid : undefined;
}

// For a caller deciding on liveness rather than reporting it.
export function liveServicePid(deps: ServiceLifecycleDeps): number | undefined {
  const { processes = nodeProcesses } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  return livePid(slug, processes);
}

// The factory's own `.env` is the service's environment file, World URL and
// credentials included. What jigs.config.ts declares wins over it: the two addresses
// the child listens on, and the base URL derived from the first of them.
//
// `WORKFLOW_LOCAL_BASE_URL` pins every queue worker in the child — the
// dashboard's included — to the service's own workflow routes. Left unset the
// World guesses a port the process happens to listen on, and a queue job
// delivered to a port with no workflow route dies after three 404s.
function childEnv(factoryRoot: string, service: ResolvedService): Record<string, string> {
  return {
    ...stringEnv(process.env),
    ...readFactoryEnv(factoryRoot),
    PORT: String(service.port),
    JIGS_DASHBOARD_PORT: String(service.dashboardPort),
    WORKFLOW_LOCAL_BASE_URL: service.serviceUrl,
    // The v5 Postgres package reads this when its module-level World is
    // created. Set it on the child itself, before any bundled module runs;
    // setting it only in the Nitro startup plugin can be too late.
    WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN: "1",
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
  const releaseExclusion = acquireServiceExclusion(slug, "start");
  try {
    const state = inspectService(slug, processes);
    if (state.kind === "running") {
      out(`already running: pid ${state.pid} at ${serviceUrl}`);
      return;
    }
    // A service that died without a stop can leave what it started running,
    // and the new service's record would lose track of it.
    if (state.kind === "stopped" && state.orphanGroup !== undefined) {
      const leftovers = await stopRecorded(deps, slug, { processGroup: state.orphanGroup });
      if (leftovers.length > 0) {
        out(`stopped ${leftovers.length} process(es) left by the previous service`);
      }
    }

    const entry = path.join(factoryRoot, SERVICE_ENTRY);
    if (!existsSync(entry)) {
      throw new JigsError(
        `no built service at ${entry}`,
        `build this factory's service first: pnpm exec jigs build in ${factoryRoot}`,
      );
    }

    const logFile = serviceLogPath(slug);
    const logOffset = existsSync(logFile) ? statSync(logFile).size : 0;
    const pid = processes.spawn({
      command: process.execPath,
      args: [SERVICE_ENTRY],
      cwd: factoryRoot,
      env: childEnv(factoryRoot, service),
      logPath: logFile,
    });
    if (pid === undefined) {
      throw new JigsError(`the service process for ${slug} did not start`, `check ${logFile}`);
    }

    // A process already gone has no start time; the readiness wait below
    // reports its failed boot.
    const record: ServiceRecord = {
      processGroup: pid,
      bootId: processes.bootId(),
      startTime: processes.startTime(pid) ?? "",
      command: `${process.execPath} ${SERVICE_ENTRY}`,
    };
    const pidfile = servicePidfilePath(slug);
    mkdirSync(path.dirname(pidfile), { recursive: true });
    writeFileSync(pidfile, `${pid}\n`);
    writeFileSync(serviceSupervisionPath(slug), `${JSON.stringify(record)}\n`);
    writeFileSync(serviceRunStatePath(slug), `${JSON.stringify({ logOffset })}\n`);
    writeFileSync(serviceBundlePath(slug), `${builtBundleHash(factoryRoot)}\n`);
    if (options.awaitReady !== false) await awaitReady(deps, slug, serviceUrl, pid);
    out(`started ${slug}: pid ${pid} at ${serviceUrl}`);
    out(`dashboard: ${dashboardUrl}`);
    out(`logs: ${logFile}`);
  } finally {
    releaseExclusion();
  }
}

/**
 * Waits for the recorded service to report itself ready. What `start` does
 * before it says "started", for a caller that spawned without waiting.
 */
export async function awaitServiceReady(deps: ServiceLifecycleDeps): Promise<void> {
  const { out, processes = nodeProcesses } = deps;
  const { slug, serviceUrl } = resolveService(locateFactoryRoot(deps.cwd));
  const pid = readPid(slug);
  if (pid === undefined) {
    throw new JigsError(`not running: ${slug}`, "start it: pnpm exec jigs service start");
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
        `it clones every binding before the World starts — watch pnpm exec jigs service logs (${serviceLogPath(slug)}); pnpm exec jigs service stop ends it`,
      );
    }
    await sleep(startPollMs);
  }
}

// The gates exit the process when a clone or the registry fails, so a pid
// gone mid-boot is the failed boot itself; its log is the explanation, and
// the last lines of it are worth more here than a path.
function failedBoot(slug: string, pid: number, out: (line: string) => void): JigsError {
  const logFile = serviceLogPath(slug);
  for (const line of tailLines(logFile, LOG_LINES)) out(line);
  rmSync(servicePidfilePath(slug), { force: true });
  return new JigsError(
    `the ${slug} service exited during boot (pid ${pid})`,
    `its log says why: pnpm exec jigs service logs (${logFile})`,
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stops the service and every process it started: its descendants and every
 * process still in its process group. Used by every verb that stops the
 * service, and fails naming each process that survived SIGKILL.
 *
 * @remarks
 * Nothing is selected from records made before the machine last restarted, or
 * from a pid or group that no longer belongs to the recorded service.
 */
export async function stopService(deps: ServiceLifecycleDeps): Promise<void> {
  const { out, processes = nodeProcesses } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  const state = inspectService(slug, processes);
  const target: ServiceTarget =
    state.kind === "running"
      ? { servicePid: state.pid, processGroup: state.processGroup }
      : state.kind === "stopped"
        ? { processGroup: state.orphanGroup }
        : {};
  const stopped = await stopRecorded(deps, slug, target);
  if (state.kind !== "running") {
    out(
      stopped.length === 0
        ? `service ${slug} was not running`
        : `service ${slug} was not running; stopped ${stopped.length} process(es) it had started`,
    );
    return;
  }
  const others = stopped.filter((entry) => entry.pid !== state.pid).length;
  out(
    `stopped service ${slug} (pid ${state.pid}${others === 0 ? "" : ` and ${others} process(es) it started`})`,
  );
}

async function stopRecorded(
  deps: ServiceLifecycleDeps,
  slug: string,
  target: ServiceTarget,
): Promise<ProcessEntry[]> {
  const {
    out,
    processes = nodeProcesses,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    killWaitMs = KILL_WAIT_MS,
  } = deps;
  const { stopped, killed } =
    target.servicePid === undefined && target.processGroup === undefined
      ? { stopped: [], killed: [] }
      : await stopProcessTree(processes, target, {
          timeoutMs: stopTimeoutMs,
          pollMs: POLL_MS,
          killWaitMs,
        });
  for (const entry of killed) out(`pid ${entry.pid} ignored SIGTERM — killed: ${entry.command}`);
  rmSync(servicePidfilePath(slug), { force: true });
  rmSync(serviceRunStatePath(slug), { force: true });
  return stopped;
}

/**
 * Throws unless the service and everything it started are gone: the recorded
 * service is not running and no process is left in its recorded process
 * group. Offline maintenance calls this; it never stops anything itself.
 */
export function requireServiceStopped(deps: ServiceLifecycleDeps): void {
  const { processes = nodeProcesses } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  const stop = "run pnpm exec jigs service stop first; prune never stops or kills processes";
  const state = inspectService(slug, processes);
  if (state.kind === "running") {
    throw new JigsError(`factory service is still running as pid ${state.pid}`, stop);
  }
  if (state.kind === "none") {
    if (state.discarded) return;
    throw new JigsError(
      `no service record at ${serviceSupervisionPath(slug)}`,
      "start and stop the service with pnpm exec jigs service start and pnpm exec jigs service stop; prune never stops or kills processes",
    );
  }
  const group = state.orphanGroup;
  if (group === undefined) return;
  const members = parsePs(processes.snapshot()).filter((entry) => entry.pgid === group);
  if (members.length > 0) {
    throw new JigsError(
      [
        `${members.length} process(es) are still running in the service's recorded process group ${group}:`,
        ...members.map((entry) => `  pid ${entry.pid}: ${entry.command}`),
      ].join("\n"),
      stop,
    );
  }
}

export async function restartService(
  deps: ServiceLifecycleDeps,
  options: StartOptions = {},
): Promise<void> {
  await stopService(deps);
  await startService(deps, options);
}

export function serviceStatus(deps: ServiceLifecycleDeps): void {
  const { out, processes = nodeProcesses, now = () => new Date() } = deps;
  const factoryRoot = locateFactoryRoot(deps.cwd);
  const { slug, serviceUrl, dashboardUrl } = resolveService(factoryRoot);
  const pid = livePid(slug, processes);
  out(
    pid === undefined
      ? deadServiceStatus(slug, serviceUrl, now)
      : `${slug}: running pid ${pid} at ${serviceUrl}`,
  );
  out(`dashboard: ${dashboardUrl}`);
  out(`factory ${factoryRoot}`);
}

function deadServiceStatus(slug: string, serviceUrl: string, now: () => Date): string {
  const stateFile = serviceRunStatePath(slug);
  const log = serviceLogPath(slug);
  const state = readRunState(stateFile);
  if (state === undefined) return `${slug}: not running (${serviceUrl})`;
  if (state.deathDetectedAt === undefined) {
    const logStat = existsSync(log) ? statSync(log) : undefined;
    state.deathDetectedAt = (
      logStat !== undefined && logStat.size > state.logOffset ? logStat.mtime : now()
    ).toISOString();
    state.signal = signalSince(log, state.logOffset);
    writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
  }
  return `${slug}: not running as of ${state.deathDetectedAt}${state.signal === undefined ? "" : `, last signal ${state.signal}`} (${serviceUrl})`;
}

function readRunState(file: string): ServiceRunState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as Partial<ServiceRunState>;
    return typeof state.logOffset === "number" && state.logOffset >= 0
      ? (state as ServiceRunState)
      : undefined;
  } catch {
    return undefined;
  }
}

function signalSince(log: string, offset: number): string | undefined {
  if (!existsSync(log)) return undefined;
  const contents = readFileSync(log);
  if (contents.byteLength < offset) return undefined;
  return contents
    .subarray(offset)
    .toString("utf8")
    .split("\n")
    .reverse()
    .map((line) => line.match(/Received ['"](SIG[A-Z]+)['"]/i)?.[1]?.toUpperCase())
    .find((value) => value !== undefined);
}

// `jigs status <run-id>` is about a run — it resolves the ref and points at the
// run's page on the dashboard the service hosts. This is about the process:
// the stdout the supervisor redirects, which no dashboard can know about.
// Different subject, so the `service` namespace keeps them apart rather than
// one shadowing the other.
export function serviceLogs(deps: ServiceLifecycleDeps, options: { lines?: number } = {}): void {
  const { out } = deps;
  const { slug } = resolveService(locateFactoryRoot(deps.cwd));
  const file = serviceLogPath(slug);
  if (!existsSync(file)) {
    throw new JigsError(
      `no service log at ${file}`,
      `this factory's service has not run yet: pnpm exec jigs service start`,
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
  ...systemProcesses,
};
