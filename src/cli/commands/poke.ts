import { JigsError } from "../../errors.ts";
import { runNotFound, type ServiceDeps, serviceFetch } from "./service-client.ts";

export interface PokeResult {
  runId: string;
  poked: Array<{ token: string; resumed: boolean }>;
}

export async function pokeRun(runId: string, deps: ServiceDeps): Promise<PokeResult> {
  const res = await serviceFetch(deps.serviceUrl, `/api/runs/${encodeURIComponent(runId)}/poke`, {
    method: "POST",
  });
  if (res.status === 404) throw runNotFound(runId);
  if (res.status === 409) {
    throw new JigsError(
      "run has no suspensions to poke",
      `inspect it: pnpm exec jigs status ${runId}`,
    );
  }
  if (!res.ok) {
    throw new JigsError(`poke failed: HTTP ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as PokeResult;
  for (const wake of result.poked) {
    deps.out(wake.resumed ? `poked ${wake.token}` : `gone (not poked): ${wake.token}`);
  }
  return result;
}
