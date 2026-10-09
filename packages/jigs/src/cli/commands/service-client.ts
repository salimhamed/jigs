import { currentFactoryContext } from "../../config/factory-context.ts";
// Shared plumbing for the verbs that are HTTP clients of the service. One
// place for the unreachable-service and unknown-run errors, so every verb
// renders them identically.

import { resolveService } from "../../config/factory-config.ts";
import { JigsError } from "../../errors.ts";
import { JIGS_VERSION, VERSION_HEADER } from "../../version.ts";

export interface ServiceDeps {
  serviceUrl: string;
  out: (line: string) => void;
}

// `JIGS_SERVICE_URL=` reaches commander as an empty string, which names no
// service at all: the factory the user is standing in owns the run either way.
export function usesFactoryService(explicit?: string): explicit is undefined | "" {
  return explicit === undefined || explicit === "";
}

export function resolveServiceUrl(explicit?: string): string {
  if (!usesFactoryService(explicit)) return explicit;
  return resolveService(currentFactoryContext()).serviceUrl;
}

export async function serviceFetch(
  serviceUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = serviceUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch {
    throw new JigsError(
      `could not reach the jigs service at ${base}`,
      "check whether it is running: `pnpm exec jigs service status`\nstart it: `pnpm exec jigs up`",
    );
  }
  const version = res.headers.get(VERSION_HEADER);
  if (version !== JIGS_VERSION) throw new ServiceVersionMismatch(base, version ?? undefined);
  return res;
}

/** The one error for a run argument that is not an existing run's full ID. */
export function runNotFound(ref: string): JigsError {
  return new JigsError(
    `run ${ref} not found`,
    "commands take a full run ID\nlist each run's ID and ticket: `pnpm exec jigs status`",
  );
}

/**
 * The service runs a different jigs than this CLI, typically after an upgrade
 * and before `jigs up` restarts it. Its responses may have another shape, so
 * none is read. A service with no version header predates the check.
 */
export class ServiceVersionMismatch extends JigsError {
  constructor(base: string, serviceVersion: string | undefined) {
    super(
      `the jigs service at ${base} runs ${serviceVersion === undefined ? "an older jigs" : `jigs ${serviceVersion}`}, and this CLI is jigs ${JIGS_VERSION}`,
      "restart it on this factory's jigs: `pnpm exec jigs up`",
    );
  }
}
