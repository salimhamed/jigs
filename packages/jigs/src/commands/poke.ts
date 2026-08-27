import { CliError } from "../errors.ts";

export interface PokeDeps {
  out: (line: string) => void;
  serviceUrl: string;
}

export interface PokeResult {
  runId: string;
  poked: Array<{ token: string; resumed: boolean }>;
}

export async function pokeRun(
  runId: string,
  deps: PokeDeps,
): Promise<PokeResult> {
  const base = deps.serviceUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/poke`, {
      method: "POST",
    });
  } catch {
    throw new CliError(
      `could not reach the jigs service at ${base}`,
      "is the jigs service running? pass --service or set JIGS_SERVICE_URL",
    );
  }
  if (res.status === 404) {
    throw new CliError(`run ${runId} not found`);
  }
  if (res.status === 409) {
    throw new CliError(
      "run has no suspensions to poke",
      `inspect it: GET ${base}/api/runs/${runId}`,
    );
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
