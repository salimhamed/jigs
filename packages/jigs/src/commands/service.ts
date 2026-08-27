// Shared plumbing for the verbs that are HTTP clients of the service (ADR
// 0008). One place for the unreachable-service and run-ref errors, so every
// verb renders them identically.

import { CliError } from "../errors.ts";

export interface ServiceDeps {
  out: (line: string) => void;
  serviceUrl: string;
}

export function serviceBase(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/, "");
}

export async function serviceFetch(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(`${base}${path}`, init);
  } catch {
    throw new CliError(
      `could not reach the jigs service at ${base}`,
      "is the jigs service running? pass --service or set JIGS_SERVICE_URL",
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
