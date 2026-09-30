import { FACTORY_CONFIG_FILE, type PagerDutyIdentity } from "../config/factory-config.ts";
import { PagerDutyApiError, type PagerDutyUser } from "../providers/pagerduty.ts";
import {
  type EnvLookup,
  missingPagerDutyVariables,
  PAGERDUTY_IDENTITY_VARIABLES,
  pagerDutyEnvValue,
  pagerDutyScope,
} from "../providers/pagerduty-auth.ts";
import type { Check } from "./catalog.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";

// A probe is a provider client; the catalog owns the repair text, which is
// what makes preflight and doctor say the same thing.
export interface PagerDutyIdentityProbes {
  /** Mint, or reuse, the app's token. */
  token(): Promise<void>;
  /** The cheapest read the token should be allowed. */
  read(): Promise<void>;
}

const VARIABLES = PAGERDUTY_IDENTITY_VARIABLES.join(" and ");

const forbidden = (err: unknown): boolean =>
  err instanceof PagerDutyApiError && (err.status === 401 || err.status === 403);

/** Whether the PagerDuty app's credentials are present, mint a token, and can read incidents. */
export function pagerDutyIdentityChecks(
  identity: PagerDutyIdentity,
  probes: PagerDutyIdentityProbes,
  env: EnvLookup = pagerDutyEnvValue,
): Check[] {
  const account = `${identity.subdomain} (${identity.region})`;
  return [
    {
      id: "pagerduty.identity",
      label: "PagerDuty identity",
      run: async () => {
        const missing = missingPagerDutyVariables(env);
        if (missing.length > 0) {
          return {
            ok: false,
            reason: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`,
            repair: `set ${VARIABLES} (the PagerDuty scoped OAuth app's client id and secret) in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
          };
        }
        try {
          await probes.token();
        } catch (err) {
          return {
            ok: false,
            reason: `${VARIABLES} are set but PagerDuty issued no token: ${err instanceof Error ? err.message : String(err)}`,
            repair: `check ${VARIABLES} in ${SERVICE_ENV_FILE} against the PagerDuty scoped OAuth app, and that the app grants every scope in "${pagerDutyScope(identity)}", then: \`${RESTART_SERVICE}\``,
          };
        }
        try {
          await probes.read();
        } catch (err) {
          return {
            ok: false,
            reason: `PagerDuty issued a token but refused to list incidents on ${account}: ${err instanceof Error ? err.message : String(err)}`,
            repair: forbidden(err)
              ? `grant incidents.read to the PagerDuty scoped OAuth app, and check pagerduty.identity.subdomain and region in ${FACTORY_CONFIG_FILE}, then: \`${RESTART_SERVICE}\``
              : "retry, and check PagerDuty's status page if it repeats",
          };
        }
        return { ok: true, detail: `acting as the app on ${account}` };
      },
    },
  ];
}

/** The PagerDuty lookup the from check makes. */
export interface PagerDutyUserProbes {
  userByEmail(email: string): Promise<PagerDutyUser | null>;
}

// Doctor only: preflight proves the token, and a write that names no real
// user fails on its own with PagerDuty's reason.
/** Whether the identity's `from` email belongs to a PagerDuty user. */
export function pagerDutyFromChecks(
  identity: PagerDutyIdentity,
  probes: PagerDutyUserProbes,
): Check[] {
  const { from } = identity;
  return [
    {
      id: "pagerduty.from",
      label: "PagerDuty from user",
      run: async () => {
        let user: PagerDutyUser | null;
        try {
          user = await probes.userByEmail(from);
        } catch (err) {
          return {
            ok: false,
            reason: `could not look up ${from} in PagerDuty: ${err instanceof Error ? err.message : String(err)}`,
            repair: forbidden(err)
              ? `grant users.read to the PagerDuty scoped OAuth app, then: \`${RESTART_SERVICE}\``
              : "repair the PagerDuty identity check, then: `pnpm exec jigs doctor`",
          };
        }
        if (user === null) {
          return {
            ok: false,
            reason: `no PagerDuty user has the email ${from}`,
            repair: `set pagerduty.identity.from in ${FACTORY_CONFIG_FILE} to the email of a user on the ${identity.subdomain} PagerDuty account, then: \`pnpm exec jigs up\``,
          };
        }
        return { ok: true, detail: `notes are attributed to ${user.name}` };
      },
    },
  ];
}
