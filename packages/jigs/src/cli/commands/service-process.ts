import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { type ResolvedService, resolveService } from "../../config/factory-config.ts";
import { readFactoryEnv } from "../../config/factory-env.ts";
import { JigsError } from "../../errors.ts";
import {
  type ProcessControl,
  type ProcessEntry,
  type ServiceTarget,
  stopProcessTree,
  systemProcesses,
} from "../../service/process-tree.ts";
import { stringEnv } from "../../steps/agents/shared/env.ts";
import { factoryContextAt } from "../factory-context.ts";
import { displayPath, note } from "../output.ts";
import {
  livePid,
  readServiceRecord,
  serviceLogPath,
  writeServiceRecord,
} from "./service-record.ts";

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
export const LOG_LINES = 50;

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
// answer at all. `pid` is undefined when whatever answered named none.
export interface ServiceHealth {
  ready: boolean;
  phase: string;
  pid: number | undefined;
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

export function builtBundleHash(factoryRoot: string): string | undefined {
  const entry = path.join(factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) return undefined;
  const hash = createHash("sha256");
  const output = path.dirname(entry);
  for (const name of readdirSync(output, { recursive: true }).map(String).sort()) {
    const file = path.join(output, name);
    if (statSync(file).isFile()) hash.update(name).update("\0").update(readFileSync(file));
  }
  return hash.digest("hex");
}

// What `jigs build` compiles into the bundle. An edit to one of them that was
// never built is invisible at run time: the service keeps executing the bundle
// it booted from.
const WORKFLOW_SOURCES = ["jigs.config.ts", "workflows", "blocks", "steps"];

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

// Which bundle the running process was started from, so a later `jigs up`
// can tell a rebuild that changed nothing from one the service has yet to
// pick up.
export function runningBundleHash(deps: BundleDeps): string | undefined {
  const { processes = nodeProcesses } = deps;
  const { slug } = resolveService(factoryContextAt(deps.cwd));
  if (livePid(slug, processes) === undefined) return undefined;
  return readServiceRecord(slug).process?.bundle;
}

// Why a run launched now would not execute the sources on disk: the bundle is
// behind them, or the running process is behind the bundle — a build nobody
// restarted onto. Undefined for an unbuilt factory.
export function serviceBehindSources(deps: BundleDeps): string | undefined {
  const factoryRoot = factoryContextAt(deps.cwd).root;
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

// The factory's own `.env` is the service's environment file, World URL and
// credentials included. What jigs.config.ts declares wins over it: the two addresses
// the child listens on, and the base URL derived from the first of them.
//
// `WORKFLOW_LOCAL_BASE_URL` pins every queue worker in the child — the
// dashboard's included — to the service's own workflow routes. Left unset the
// World guesses a port the process happens to listen on, and a queue job
// delivered to a port with no workflow route dies after three 404s.
//
// An empty `.env` slot is unset, as doctor reads it, so it never hides a value
// the shell exported.
function childEnv(factoryRoot: string, service: ResolvedService): Record<string, string> {
  const declared = Object.entries(readFactoryEnv(factoryRoot)).filter(([, value]) => value !== "");
  return {
    ...stringEnv(),
    ...Object.fromEntries(declared),
    PORT: String(service.port),
    JIGS_DASHBOARD_PORT: String(service.dashboardPort),
    WORKFLOW_LOCAL_BASE_URL: service.serviceUrl,
    // The v5 Postgres package reads this when its module-level World is
    // created. Set it on the child itself, before any bundled module runs;
    // setting it only in the Nitro startup plugin can be too late.
    WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN: "1",
  };
}

/**
 * Spawns the built service as the leader of its own process group and records
 * it. Does not wait for it to boot.
 */
export function spawnService(
  deps: ServiceLifecycleDeps,
  factoryRoot: string,
  service: ResolvedService,
): number {
  const { processes = nodeProcesses } = deps;
  const { slug } = service;
  const entry = path.join(factoryRoot, SERVICE_ENTRY);
  if (!existsSync(entry)) {
    throw new JigsError(
      `no built service at ${entry}`,
      `build this factory's service first: \`pnpm exec jigs build\` (in ${displayPath(factoryRoot)})`,
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
    throw new JigsError(
      `the service process for ${slug} did not start`,
      `its log may say why: \`pnpm exec jigs service logs\` (in ${displayPath(factoryRoot)}, log at ${displayPath(logFile)})`,
    );
  }

  const startTime = processes.startTime(pid);
  if (startTime === undefined && processes.signal(pid, 0)) {
    processes.signal(pid, "SIGKILL");
    throw new JigsError(
      `could not read the start time of the new service process (pid ${pid}), so it was killed`,
      "jigs needs it to recognise the service later\nrerun the command, and report it if it keeps failing",
    );
  }
  // A process already gone has no start time; the readiness wait reports its
  // failed boot.
  writeServiceRecord(slug, {
    process: {
      processGroup: pid,
      bootId: processes.bootId(),
      startTime: startTime ?? "",
      command: `${process.execPath} ${SERVICE_ENTRY}`,
      bundle: builtBundleHash(factoryRoot),
    },
    run: { logOffset },
  });
  return pid;
}

// "started" means the World is up and every binding cloned, not that the port
// answers: nitro serves /health before its plugins run, so a 200 says nothing
// about a boot that a failed clone can still end a minute later.
export async function awaitReady(
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
    // The new process never gets the port while another holds it, and nitro
    // keeps it running without a listener; trusting the other process's
    // answer would send every request for this factory to it.
    if (health !== null && health.pid !== pid) {
      await stopRecorded(deps, slug, { processGroup: pid });
      const other = health.pid === undefined ? "one that reports no pid" : `pid ${health.pid}`;
      throw new JigsError(
        `${serviceUrl} is already served by another process (${other}), so the ${slug} service could not listen there and was stopped`,
        "stop that process, or give this factory another `service.port` in jigs.config.ts",
      );
    }
    if (health?.ready) return;
    if (health !== null && health.phase !== phase) {
      phase = health.phase;
      out(note(`booting: ${phase}`));
    }
    if (!processes.signal(pid, 0)) throw failedBoot(slug, pid, out);
    if (Date.now() >= deadline) {
      throw new JigsError(
        `the ${slug} service is still booting after ${startTimeoutMs / 1000}s (pid ${pid}${phase === undefined ? "" : `, ${phase}`})`,
        `it clones every binding before the World starts\nwatch its log: \`pnpm exec jigs service logs\` (log at ${displayPath(serviceLogPath(slug))})\nstop it: \`pnpm exec jigs service stop\``,
      );
    }
    await sleep(startPollMs);
  }
}

// The gates exit the process when a clone or the registry fails, so a pid
// gone mid-boot is the failed boot itself; its log is the explanation, and
// the last lines of it are worth more here than a path.
export function failedBoot(slug: string, pid: number, out: (line: string) => void): JigsError {
  const logFile = serviceLogPath(slug);
  for (const line of tailLines(logFile, LOG_LINES)) out(line);
  const record = readServiceRecord(slug);
  if (record.process !== undefined) {
    writeServiceRecord(slug, { ...record, process: { ...record.process, exited: true } });
  }
  return new JigsError(
    `the ${slug} service exited during boot (pid ${pid})`,
    `its log says why: \`pnpm exec jigs service logs\` (log at ${displayPath(logFile)})`,
  );
}

async function healthProbe(url: string): Promise<ServiceHealth | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      ready?: unknown;
      phase?: unknown;
      pid?: unknown;
    };
    return {
      ready: body.ready === true,
      phase: typeof body.phase === "string" ? body.phase : "unknown",
      pid: typeof body.pid === "number" ? body.pid : undefined,
    };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Stops what the target names and deletes the record: nothing it names can be running after. */
export async function stopRecorded(
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
  for (const entry of killed) {
    out(`pid ${entry.pid} ignored SIGTERM, so it was killed: ${entry.command}`);
  }
  // The group is empty now, so the record has nothing left to find. Kept, it
  // would claim whatever group later reuses that ID.
  writeServiceRecord(slug, {});
  return stopped;
}

export function tailLines(file: string, count: number): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count);
}

export const nodeProcesses: ServiceProcesses = {
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
