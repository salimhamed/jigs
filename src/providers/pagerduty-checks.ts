import { type Check, failedCheck } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { FACTORY_CONFIG_FILE, type PagerDutyIdentity } from "../workflow/factory-schema.ts";
import { type EnvLookup, RESTART_SERVICE, SERVICE_ENV_FILE } from "./credentials.ts";
import { ProviderApiError } from "./http.ts";
import { type PagerDutyUser, pagerDutyClientFor } from "./pagerduty.ts";
import {
  missingPagerDutyVariables,
  PAGERDUTY_IDENTITY_VARIABLES,
  pagerDutyAuthFor,
  resolvePagerDutyIdentity,
} from "./pagerduty-auth.ts";

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
  err instanceof ProviderApiError && (err.status === 401 || err.status === 403);

/** Whether the PagerDuty app's credentials are present, mint a token, and can read incidents. */
export function pagerDutyIdentityChecks(
  identity: PagerDutyIdentity,
  probes: PagerDutyIdentityProbes,
  env: EnvLookup,
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
            repair: `check ${VARIABLES} in ${SERVICE_ENV_FILE} against the PagerDuty scoped OAuth app, and that pagerduty.identity.subdomain and region in ${FACTORY_CONFIG_FILE} name its account (now ${account}), then: \`${RESTART_SERVICE}\``,
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
  /** Mint, or reuse, the app's token; without one the identity check reports the failure. */
  token(): Promise<void>;
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
        try {
          await probes.token();
        } catch {
          return { ok: true, detail: "not checked: the PagerDuty identity check failed" };
        }
        let user: PagerDutyUser | null;
        try {
          user = await probes.userByEmail(from);
        } catch (err) {
          return {
            ok: false,
            reason: `could not look up ${from} in PagerDuty: ${err instanceof Error ? err.message : String(err)}`,
            repair: forbidden(err)
              ? `grant users.read to the PagerDuty scoped OAuth app, then: \`${RESTART_SERVICE}\``
              : "PagerDuty did not answer: retry `pnpm exec jigs doctor`, and check PagerDuty's status page if it repeats",
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

async function pagerDutyToken(ctx: FactoryContext): Promise<void> {
  await pagerDutyAuthFor(ctx).bearer();
}

// A missing or unreadable pagerduty section fails as itself, with the section
// to add, rather than as a credential PagerDuty rejected.
export function pagerDutyChecks(ctx: FactoryContext): Check[] {
  let identity: PagerDutyIdentity;
  try {
    identity = resolvePagerDutyIdentity(ctx);
  } catch (err) {
    return [
      failedCheck(
        "pagerduty.identity",
        "PagerDuty identity",
        err instanceof Error ? err.message : String(err),
        err instanceof JigsError && err.hint !== undefined
          ? err.hint
          : `repair ${FACTORY_CONFIG_FILE}, then: \`${RESTART_SERVICE}\``,
      ),
    ];
  }
  return pagerDutyIdentityChecks(
    identity,
    { token: () => pagerDutyToken(ctx), read: () => pagerDutyClientFor(ctx).verifyAccess() },
    ctx.env,
  );
}

// An unreadable config is the identity check's diagnosis, so it adds nothing here.
export function pagerDutyFromDoctorChecks(ctx: FactoryContext): Check[] {
  let identity: PagerDutyIdentity;
  try {
    identity = resolvePagerDutyIdentity(ctx);
  } catch {
    return [];
  }
  return pagerDutyFromChecks(identity, {
    token: () => pagerDutyToken(ctx),
    userByEmail: (email) => pagerDutyClientFor(ctx).findUserByEmail(email),
  });
}

/** The real lookups for the PagerDuty webhook check. */
export const pagerDutyWebhookProbes = (ctx: FactoryContext) => ({
  token: () => pagerDutyToken(ctx),
  subscriptions: (url: string) => pagerDutyClientFor(ctx).listWebhookSubscriptions({ url }),
});
