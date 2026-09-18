// Shared plumbing for the verbs that are HTTP clients of the service. One
// place for the unreachable-service and run-ref errors, so every verb renders
// them identically.

import { resolveService } from "../../config/factory-config.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";

export interface ServiceDeps {
  serviceUrl: string;
  out: (line: string) => void;
}

// `JIGS_SERVICE_URL=` reaches commander as an empty string, which names no
// service at all: the factory the user is standing in owns the run either way.
export function usesFactoryService(explicit?: string): explicit is undefined | "" {
  return explicit === undefined || explicit === "";
}

// An explicit --service-url / JIGS_SERVICE_URL wins; otherwise the factory the
// user is standing in names its own service. Call this from inside a command
// action, never from a commander `.default()` — the filesystem walk here
// would then run on `jigs --help`, outside any factory repo.
export function resolveServiceUrl(cwd: string, explicit?: string): string {
  if (!usesFactoryService(explicit)) return explicit;
  return resolveService(locateFactoryRoot(cwd)).serviceUrl;
}

export async function serviceFetch(
  serviceUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = serviceUrl.replace(/\/+$/, "");
  try {
    return await fetch(`${base}${path}`, init);
  } catch {
    throw new JigsError(
      `could not reach the jigs service at ${base}`,
      "jigs service status says whether it is running; jigs service start starts it",
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
export function runRefError(ref: string, body: RunRefErrorBody): JigsError {
  return body.candidates === undefined
    ? new JigsError(`run ${ref} not found`)
    : new JigsError(
        `run ref ${ref} is ambiguous`,
        `matches: ${body.candidates.join(", ")} — use more characters`,
      );
}
