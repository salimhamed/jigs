import { CliError } from "../errors.ts";
import {
  readErrorBody,
  runRefError,
  type ServiceDeps,
  serviceFetch,
} from "./service.ts";

// jigs contributes the one thing `workflow web` cannot do — resolving a
// ticket id or a ULID prefix to a run — and then hands the log surface back
// to the SDK, which already ships it (ADR 0008).

export interface LogsResult {
  runId: string;
  status: string;
  error?: string;
  logs?: string;
  suspensions?: Array<{ key: string; reason: string; satisfiedBy: string }>;
}

export async function showLogs(
  ref: string,
  deps: ServiceDeps,
): Promise<LogsResult> {
  const res = await serviceFetch(
    deps.serviceUrl,
    `/api/runs/${encodeURIComponent(ref)}`,
  );
  if (res.status === 404 || res.status === 409) {
    throw runRefError(ref, await readErrorBody(res));
  }
  if (!res.ok) {
    throw new CliError(`logs failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as LogsResult;
  deps.out(`run ${result.runId}`);
  deps.out(`status ${result.status}`);
  if (result.error !== undefined) deps.out(`error ${result.error}`);
  for (const suspension of result.suspensions ?? []) {
    deps.out(`suspended on ${suspension.key}: ${suspension.reason}`);
    deps.out(`  satisfied by ${suspension.satisfiedBy}`);
  }
  deps.out(result.logs ?? `npx workflow web ${result.runId}`);
  return result;
}
