import { CliError } from "../errors.ts";
import {
  readErrorBody,
  runRefError,
  type ServiceDeps,
  serviceBase,
  serviceFetch,
} from "./service.ts";

export type PokeDeps = ServiceDeps;

export interface PokeResult {
  runId: string;
  poked: Array<{ token: string; resumed: boolean }>;
}

export async function pokeRun(
  runId: string,
  deps: PokeDeps,
): Promise<PokeResult> {
  const base = serviceBase(deps.serviceUrl);
  const res = await serviceFetch(
    base,
    `/api/runs/${encodeURIComponent(runId)}/poke`,
    { method: "POST" },
  );
  if (res.status === 404 || res.status === 409) {
    const body = await readErrorBody(res);
    if (res.status === 409 && body.candidates === undefined) {
      throw new CliError(
        "run has no suspensions to poke",
        `inspect it: GET ${base}/api/runs/${runId}`,
      );
    }
    throw runRefError(runId, body);
  }
  if (!res.ok) {
    throw new CliError(`poke failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as PokeResult;
  for (const wake of result.poked) {
    deps.out(
      wake.resumed ? `poked ${wake.token}` : `gone (not poked): ${wake.token}`,
    );
  }
  return result;
}
