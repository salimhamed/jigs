import { CliError } from "../errors.ts";

export const DEFAULT_SERVICE_URL = "http://localhost:8990";

export function resolveServiceUrl(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.JIGS_SERVICE_URL;
  if (flag !== undefined && flag !== "") return flag;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULT_SERVICE_URL;
}

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
  let res: Response;
  try {
    res = await fetch(`${deps.serviceUrl}/api/runs/${runId}/poke`, {
      method: "POST",
    });
  } catch {
    throw new CliError(
      `could not reach the jigs service at ${deps.serviceUrl}`,
      "is the jigs service running? pass --service or set JIGS_SERVICE_URL",
    );
  }
  if (res.status === 404) {
    throw new CliError(`run ${runId} not found`);
  }
  if (res.status === 409) {
    throw new CliError(
      "run has no suspensions to poke",
      `inspect it: GET ${deps.serviceUrl}/api/runs/${runId}`,
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
