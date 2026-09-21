import type { Check, CheckResult } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

/** Check that a model API credential is present without spending a request. */
export function modelApiKeyCheck(variable: string, env: NodeJS.ProcessEnv = process.env): Check {
  return {
    id: `model.${variable.toLowerCase().replaceAll("_", "-")}`,
    label: `${variable} credential`,
    run: async (): Promise<CheckResult> =>
      env[variable] === undefined || env[variable] === ""
        ? {
            ok: false,
            reason: `${variable} is not set in the service's environment`,
            repair: `set ${variable} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
          }
        : { ok: true },
  };
}
