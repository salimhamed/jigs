import { existsSync, readFileSync, statSync } from "node:fs";
import { type ResolvedService, resolveService } from "../../config/factory-config.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import { parsePs, type ServiceTarget } from "../../service/process-tree.ts";
import { columns, detail, displayPath, hint, indent, layout } from "../output.ts";
import {
  awaitReady,
  builtBundleHash,
  failedBoot,
  LOG_LINES,
  nodeProcesses,
  runningBundleHash,
  type ServiceLifecycleDeps,
  spawnService,
  stopRecorded,
  tailLines,
} from "./service-process.ts";
import {
  acquireServiceExclusion,
  forgetServiceProcess,
  inspectService,
  livePid,
  readServiceRecord,
  type ServiceRun,
  serviceLogPath,
  writeServiceRecord,
} from "./service-record.ts";

interface Launched {
  pid: number;
  service: ResolvedService;
}

// Ends what a service that died without a stop left running, then spawns a
// new one. Undefined when the recorded service is still running.
async function launch(deps: ServiceLifecycleDeps): Promise<Launched | undefined> {
  const { out, processes = nodeProcesses } = deps;
  const ctx = currentFactoryContext();
  const service = resolveService(ctx);
  const { slug, serviceUrl } = service;
  const releaseExclusion = acquireServiceExclusion(slug, "start");
  try {
    const state = inspectService(slug, processes, { cleanUp: true });
    if (state.kind === "running") {
      out(`${slug} is already running at ${serviceUrl} ${detail(`pid ${state.pid}`)}`);
      return undefined;
    }
    // A service that died without a stop can leave what it started running,
    // and the new service's record would lose track of it.
    if (state.kind === "stopped" && state.orphanGroup !== undefined) {
      const leftovers = await stopRecorded(deps, slug, { processGroup: state.orphanGroup });
      if (leftovers.length > 0) {
        out(`stopped ${leftovers.length} process(es) left by the previous service`);
      }
    }
    return { pid: spawnService(deps, ctx.root, service), service };
  } finally {
    releaseExclusion();
  }
}

function reportStarted(out: (line: string) => void, { pid, service }: Launched): void {
  out(`started ${service.slug} at ${service.serviceUrl} ${detail(`pid ${pid}`)}`);
  for (const line of indent(
    columns([
      ["dashboard", service.dashboardUrl],
      ["logs", displayPath(serviceLogPath(service.slug))],
    ]),
  )) {
    out(line);
  }
}

export type ServiceOutcome = "started" | "restarted" | "unchanged";

/**
 * Brings the running service in line with the built bundle: starts it when it
 * is not running, and restarts it when it runs an earlier bundle or `restart`
 * asks. Does not wait for it to boot: `awaitServiceReady` does.
 */
export async function ensureServiceCurrent(
  deps: ServiceLifecycleDeps,
  options: { restart?: boolean; beforeRestart: () => Promise<void> },
): Promise<ServiceOutcome> {
  const { processes = nodeProcesses } = deps;
  const { root } = currentFactoryContext();
  const { slug } = resolveService(currentFactoryContext());
  let outcome: ServiceOutcome = "started";
  // Compared against the bundle the running process started from, not the
  // one on disk before this build: a restart refused last time must still
  // be owed this time.
  if (livePid(slug, processes) !== undefined) {
    if (builtBundleHash(root) === runningBundleHash(deps) && options.restart !== true) {
      return "unchanged";
    }
    await options.beforeRestart();
    await stopService(deps);
    outcome = "restarted";
  }
  const launched = await launch(deps);
  if (launched !== undefined) reportStarted(deps.out, launched);
  return outcome;
}

/** Waits for the recorded service to report itself ready. */
export async function awaitServiceReady(deps: ServiceLifecycleDeps): Promise<void> {
  const { out, processes = nodeProcesses } = deps;
  const { slug, serviceUrl } = resolveService(currentFactoryContext());
  const recorded = readServiceRecord(slug).process;
  if (recorded === undefined || recorded.exited) {
    throw new JigsError(`not running: ${slug}`, "start it: `pnpm exec jigs up`");
  }
  const pid = recorded.processGroup;
  if (!processes.signal(pid, 0)) throw failedBoot(slug, pid, out);
  await awaitReady(deps, slug, serviceUrl, pid);
}

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
  const { slug } = resolveService(currentFactoryContext());
  const state = inspectService(slug, processes, { cleanUp: true });
  const target: ServiceTarget =
    state.kind === "running"
      ? { servicePid: state.pid, processGroup: state.processGroup }
      : state.kind === "stopped"
        ? { processGroup: state.orphanGroup }
        : {};
  const stopped = await stopRecorded(deps, slug, target);
  if (state.kind !== "running") {
    out(`service ${slug} was not running`);
    if (stopped.length > 0) out(`stopped ${stopped.length} process(es) it had started`);
    return;
  }
  const others = stopped.filter((entry) => entry.pid !== state.pid).length;
  out(
    `stopped service ${slug} (pid ${state.pid}${others === 0 ? "" : ` and ${others} process(es) it started`})`,
  );
}

/**
 * Throws unless the service and everything it started are gone: the recorded
 * service is not running and no process is left in its recorded process
 * group. Offline maintenance calls this; it never stops anything itself.
 */
export function requireServiceStopped(deps: ServiceLifecycleDeps): void {
  const { processes = nodeProcesses } = deps;
  const { slug } = resolveService(currentFactoryContext());
  const stop =
    "prune never stops or kills processes, so stop the service first: `pnpm exec jigs service stop`";
  const state = inspectService(slug, processes, { cleanUp: true });
  if (state.kind === "running") {
    throw new JigsError(`factory service is still running as pid ${state.pid}`, stop);
  }
  // Nothing recorded means nothing jigs started can be running.
  if (state.kind === "none") return;
  const group = state.orphanGroup;
  const members =
    group === undefined
      ? []
      : parsePs(processes.snapshot()).filter((entry) => entry.pgid === group);
  if (members.length === 0) {
    forgetServiceProcess(slug);
    return;
  }
  throw new JigsError(
    [
      `${members.length} process(es) are still running in the service's recorded process group ${group}:`,
      ...members.map((entry) => `  pid ${entry.pid}: ${entry.command}`),
    ].join("\n"),
    stop,
  );
}

// For a caller deciding on liveness rather than reporting it.
export function liveServicePid(deps: ServiceLifecycleDeps): number | undefined {
  const { processes = nodeProcesses } = deps;
  const { slug } = resolveService(currentFactoryContext());
  return livePid(slug, processes);
}

export function serviceStatus(deps: ServiceLifecycleDeps): void {
  const { out, processes = nodeProcesses, now = () => new Date() } = deps;
  const ctx = currentFactoryContext();
  const factoryRoot = ctx.root;
  const { slug, serviceUrl, dashboardUrl } = resolveService(ctx);
  const pid = livePid(slug, processes);
  out(
    pid === undefined
      ? deadServiceStatus(slug, now)
      : `${slug} is running at ${serviceUrl} ${detail(`pid ${pid}`)}`,
  );
  for (const line of indent(
    columns([
      ...(pid === undefined ? [["service", serviceUrl]] : []),
      ["dashboard", dashboardUrl],
      ["factory", displayPath(factoryRoot)],
    ]),
  )) {
    out(line);
  }
}

function deadServiceStatus(slug: string, now: () => Date): string {
  const log = serviceLogPath(slug);
  const record = readServiceRecord(slug);
  const run: ServiceRun | undefined = record.run;
  if (run === undefined) return `${slug} is not running`;
  if (run.deathDetectedAt === undefined) {
    const logStat = existsSync(log) ? statSync(log) : undefined;
    run.deathDetectedAt = (
      logStat !== undefined && logStat.size > run.logOffset ? logStat.mtime : now()
    ).toISOString();
    const signal = signalSince(log, run.logOffset);
    if (signal !== undefined) run.signal = signal;
    writeServiceRecord(slug, { ...record, run });
  }
  const signal = run.signal === undefined ? "" : ` ${detail(`last signal ${run.signal}`)}`;
  return `${slug} is not running as of ${run.deathDetectedAt}${signal}`;
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
  const { slug } = resolveService(currentFactoryContext());
  const file = serviceLogPath(slug);
  if (!existsSync(file)) {
    throw new JigsError(
      `no service log at ${file}`,
      "this factory's service has not run yet, so start it: `pnpm exec jigs up`",
    );
  }
  const tail = tailLines(file, options.lines ?? LOG_LINES);
  for (const line of layout(tail, hint("follow the log:", `tail -f ${displayPath(file)}`))) {
    out(line);
  }
}
