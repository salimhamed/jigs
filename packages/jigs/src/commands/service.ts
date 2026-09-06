// Shared plumbing for the verbs that are HTTP clients of the service (ADR
// 0008). One place for the unreachable-service and run-ref errors, so every
// verb renders them identically.

import { basename } from "node:path";
import { resolveService } from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/factory-root.ts";
import { CliError } from "../errors.ts";
import { liveServicePid } from "./service-lifecycle.ts";

// Which service a verb talks to. The factory root travels with the URL only
// so the unreachable error can name the factory whose service is down.
export interface ServiceTarget {
  serviceUrl: string;
  factoryRoot?: string;
}

export interface ServiceDeps extends ServiceTarget {
  out: (line: string) => void;
}

// An explicit --service / JIGS_SERVICE_URL wins; otherwise the factory the
// user is standing in names its own service. Call this from inside a command
// action, never from a commander `.default()` — the filesystem walk here
// would then run on `jigs --help`, outside any factory repo.
export function resolveServiceTarget(
  cwd: string,
  explicit?: string,
): ServiceTarget {
  if (explicit !== undefined && explicit !== "")
    return { serviceUrl: explicit };
  const factoryRoot = locateFactoryRoot(cwd);
  return { serviceUrl: resolveService(factoryRoot).serviceUrl, factoryRoot };
}

export async function serviceFetch(
  target: ServiceTarget,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = target.serviceUrl.replace(/\/+$/, "");
  try {
    return await fetch(`${base}${path}`, init);
  } catch {
    throw new CliError(
      `could not reach the jigs service at ${base}`,
      unreachableHint(target),
    );
  }
}

// A live pid behind a port that does not answer is a service booting or
// wedged; "start it" would send the operator to spawn a second one.
function unreachableHint(target: ServiceTarget): string {
  if (target.factoryRoot === undefined) {
    return "is the jigs service running? pass --service or set JIGS_SERVICE_URL";
  }
  const factory = basename(target.factoryRoot);
  const pid = livePidOrNone(target.factoryRoot);
  return pid === undefined
    ? `the ${factory} factory's service is not running — start it: jigs service start`
    : `the ${factory} factory's service is running (pid ${pid}) but not answering — still booting, or wedged: jigs service logs`;
}

// A hint must not turn into a second error: a pid the OS recycled to another
// user answers `kill(pid, 0)` with EPERM, which the liveness check rethrows,
// and a factory root that no longer parses throws before that.
function livePidOrNone(factoryRoot: string): number | undefined {
  try {
    return liveServicePid({ cwd: factoryRoot, out: () => {} });
  } catch {
    return undefined;
  }
}

export interface RunRefErrorBody {
  candidates?: string[];
}

export async function readErrorBody(res: Response): Promise<RunRefErrorBody> {
  return (await res.json().catch(() => ({}))) as RunRefErrorBody;
}

// The service resolves run refs (ULID, unique prefix, ticket id); these are
// the two ways it can answer that no single run was named. The candidate
// list, not the status, is what tells them apart.
export function runRefError(ref: string, body: RunRefErrorBody): CliError {
  return body.candidates === undefined
    ? new CliError(`run ${ref} not found`)
    : new CliError(
        `run ref ${ref} is ambiguous`,
        `matches: ${body.candidates.join(", ")} — use more characters`,
      );
}
