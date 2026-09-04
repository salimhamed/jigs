import { spawn } from "node:child_process";
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
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { CliError } from "../errors.ts";
import { stringEnv } from "../harnesses/env.ts";
import { jigsDataDir } from "../paths.ts";
import { STEP_TIMEOUT_ENV } from "../step-timeout.ts";

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
const POLL_MS = 100;
const LOG_LINES = 50;

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}

// The only two things a test cannot do for real. Every file this module
// touches is either in the factory repo under test or under `jigsDataDir()`,
// which `XDG_DATA_HOME` already redirects.
export interface ServiceProcesses {
  spawn(spec: SpawnSpec): number | undefined;
  // node's `kill(pid, 0)` semantics: false only when the process is gone.
  signal(pid: number, sig: NodeJS.Signals | 0): boolean;
}

export interface ServiceLifecycleDeps {
  cwd: string;
  out: (line: string) => void;
  processes?: ServiceProcesses;
  stopTimeoutMs?: number;
}

interface Supervisor {
  factoryRoot: string;
  service: ResolvedService;
  processes: ServiceProcesses;
  out: (line: string) => void;
  stopTimeoutMs: number;
}

export function servicePidfilePath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.pid`);
}

export function serviceLogPath(slug: string): string {
  return path.join(jigsDataDir(), "services", `${slug}.log`);
}

// Walks for the factory repo and parses its jigs.yml, so this throws when the
// caller is not standing in a factory.
function resolveSupervisor(deps: ServiceLifecycleDeps): Supervisor {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  return {
    factoryRoot,
    service: resolveService(factoryRoot),
    processes: deps.processes ?? nodeProcesses,
    out: deps.out,
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

// The factory's own `.env` is the service's environment file, World URL and
// credentials included. `PORT` and the step timeout are the exceptions: both
// are declared in jigs.yml — the address the child must listen on, and the cap
// it must bound its step dispatcher by — so jigs.yml wins over `.env` for
// them. Including when the cap is absent: unset means uncapped, and an
// inherited value must not quietly reintroduce one.
//
// `WORKFLOW_LOCAL_BASE_URL` pins every queue worker in the child — the
// dashboard's included — to the service's own workflow routes. Left unset the
// World guesses a port the process happens to listen on, and a queue job
// delivered to a port with no workflow route dies after three 404s.
function childEnv(sv: Supervisor): Record<string, string> {
  const dotenvPath = path.join(sv.factoryRoot, ".env");
  const env: Record<string, string> = {
    ...stringEnv(process.env),
    ...(existsSync(dotenvPath)
      ? (parseEnv(readFileSync(dotenvPath, "utf8")) as Record<string, string>)
      : {}),
    PORT: String(sv.service.port),
    JIGS_DASHBOARD_PORT: String(sv.service.dashboardPort),
    WORKFLOW_LOCAL_BASE_URL: sv.service.serviceUrl,
  };
  const minutes = sv.service.stepTimeoutMinutes;
  if (minutes === undefined) delete env[STEP_TIMEOUT_ENV];
  else env[STEP_TIMEOUT_ENV] = String(minutes);
  return env;
}

export function startService(deps: ServiceLifecycleDeps): void {
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
  sv.out(`started ${sv.service.slug}: pid ${pid} at ${sv.service.serviceUrl}`);
  sv.out(`dashboard: ${sv.service.dashboardUrl}`);
  sv.out(`logs: ${logFile}`);
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
): Promise<void> {
  await stopService(deps);
  startService(deps);
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
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines.slice(-(options.lines ?? LOG_LINES))) sv.out(line);
  sv.out(`(follow: tail -f ${file})`);
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
