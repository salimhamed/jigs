import { CliError } from "../errors.ts";
import {
  readErrorBody,
  runRefError,
  type ServiceDeps,
  serviceBase,
  serviceFetch,
} from "./service.ts";

// jigs contributes the one thing `workflow web` cannot do — resolving a
// ticket id or a ULID prefix to a run — and then hands the log surface back
// to the SDK, which already ships it (ADR 0008).

export interface LogsResult {
  runId: string;
  status: string;
  suspensions?: Array<{ key: string; reason: string; satisfiedBy: string }>;
}

export async function showLogs(
  ref: string,
  deps: ServiceDeps,
): Promise<LogsResult> {
  const base = serviceBase(deps.serviceUrl);
  const res = await serviceFetch(base, `/api/runs/${encodeURIComponent(ref)}`);
  if (res.status === 404 || res.status === 409) {
    throw runRefError(ref, await readErrorBody(res));
  }
  if (!res.ok) {
    throw new CliError(`logs failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as LogsResult;
  deps.out(`run ${result.runId}`);
  deps.out(`status ${result.status}`);
  for (const suspension of result.suspensions ?? []) {
    deps.out(`suspended on ${suspension.key}: ${suspension.reason}`);
    deps.out(`  satisfied by ${suspension.satisfiedBy}`);
  }
  deps.out(`npx workflow web ${result.runId}`);
  return result;
}
