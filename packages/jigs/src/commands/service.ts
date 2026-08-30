// Shared plumbing for the verbs that are HTTP clients of the service (ADR
// 0008). One place for the unreachable-service and run-ref errors, so every
// verb renders them identically.

import { basename } from "node:path";
import { resolveService } from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { CliError } from "../errors.ts";

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
      target.factoryRoot === undefined
        ? "is the jigs service running? pass --service or set JIGS_SERVICE_URL"
        : `the ${basename(target.factoryRoot)} factory's service is not running — start it: jigs service start`,
    );
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
