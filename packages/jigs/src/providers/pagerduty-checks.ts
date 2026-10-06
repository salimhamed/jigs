import type { CheckResult } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { ProviderApiError } from "./http.ts";
import { hubRefused, hubToken } from "./hub.ts";
import { pagerDutyFor } from "./pagerduty.ts";

export interface PagerDutyInstallationProbeDeps {
  /** Ask the hub for the installation's token, returning the user its writes are made as. */
  token?: (installationName: string) => Promise<{ from: string }>;
  /** The cheapest read the token should be allowed. */
  read?: (installationName: string) => Promise<void>;
}

const forbidden = (err: unknown): boolean =>
  err instanceof ProviderApiError && (err.status === 401 || err.status === 403);

/** Whether the hub hands this factory a PagerDuty installation's token, and the token can read incidents. */
export function pagerDutyInstallationProbe(
  ctx: FactoryContext,
  deps: PagerDutyInstallationProbeDeps = {},
): (installationName: string) => Promise<CheckResult> {
  const token = deps.token ?? ((name: string) => hubToken("pagerduty", name, ctx));
  const read = deps.read ?? ((name: string) => pagerDutyFor(name, ctx).verifyAccess());
  return async (installationName) => {
    let from: string;
    try {
      ({ from } = await token(installationName));
    } catch (err) {
      return hubRefused("the hub gave no PagerDuty token", err);
    }
    try {
      await read(installationName);
    } catch (err) {
      return {
        ok: false,
        reason: `its token could not list incidents: ${err instanceof Error ? err.message : String(err)}`,
        repair: forbidden(err)
          ? "in PagerDuty, grant the factory's PagerDuty app incidents.read, then: `pnpm exec jigs doctor`"
          : "retry, and check PagerDuty's status page if it repeats",
      };
    }
    return { ok: true, detail: `notes made as ${from}` };
  };
}
