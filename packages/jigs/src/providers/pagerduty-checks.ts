import { type Check, failedCheck } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { FACTORY_CONFIG_FILE } from "../workflow/factory-schema.ts";
import { ProviderApiError } from "./http.ts";
import { hubRefused } from "./hub.ts";
import { type PagerDutyUser, pagerDutyClientFor, pagerDutyTokens } from "./pagerduty.ts";

// A probe is a provider client; the catalog owns the repair text, which is
// what makes preflight and doctor say the same thing.
export interface PagerDutyAppProbes {
  /** Ask the hub for, or reuse, the app's token. */
  token(ctx: FactoryContext): Promise<void>;
  /** The cheapest read the token should be allowed. */
  read(ctx: FactoryContext): Promise<void>;
}

const PAGERDUTY_APP_PROBES: PagerDutyAppProbes = {
  token: pagerDutyToken,
  read: (ctx) => pagerDutyClientFor(ctx).verifyAccess(),
};

const forbidden = (err: unknown): boolean =>
  err instanceof ProviderApiError && (err.status === 401 || err.status === 403);

/** Whether the hub hands this factory a PagerDuty token, and the token can read incidents. */
export function pagerDutyAppChecks(
  ctx: FactoryContext,
  probes: PagerDutyAppProbes = PAGERDUTY_APP_PROBES,
): Check[] {
  return [
    {
      id: "pagerduty.app",
      label: "PagerDuty app",
      run: async () => {
        try {
          await probes.token(ctx);
        } catch (err) {
          return hubRefused("the hub has no PagerDuty token for this factory", err);
        }
        try {
          await probes.read(ctx);
        } catch (err) {
          return {
            ok: false,
            reason: `the hub's PagerDuty token could not list incidents: ${err instanceof Error ? err.message : String(err)}`,
            repair: forbidden(err)
              ? "in PagerDuty, grant the factory's PagerDuty app incidents.read, then: `pnpm exec jigs doctor`"
              : "retry, and check PagerDuty's status page if it repeats",
          };
        }
        return { ok: true, detail: "acting as the hub's PagerDuty app" };
      },
    },
  ];
}

/** The PagerDuty lookup the from check makes. */
export interface PagerDutyUserProbes {
  /** Ask the hub for, or reuse, the app's token; without one the app check reports the failure. */
  token(): Promise<void>;
  userByEmail(email: string): Promise<PagerDutyUser | null>;
}

// Doctor only: a write that names no real user fails on its own with
// PagerDuty's reason.
/** Whether the `pagerduty.from` email belongs to a PagerDuty user. */
export function pagerDutyFromChecks(from: string, probes: PagerDutyUserProbes): Check[] {
  return [
    {
      id: "pagerduty.from",
      label: "PagerDuty from user",
      run: async () => {
        try {
          await probes.token();
        } catch {
          return { ok: true, detail: "not checked: the PagerDuty app check failed" };
        }
        let user: PagerDutyUser | null;
        try {
          user = await probes.userByEmail(from);
        } catch (err) {
          return {
            ok: false,
            reason: `could not look up ${from} in PagerDuty: ${err instanceof Error ? err.message : String(err)}`,
            repair: forbidden(err)
              ? "in PagerDuty, grant the factory's PagerDuty app users.read, then: `pnpm exec jigs doctor`"
              : "PagerDuty did not answer: retry `pnpm exec jigs doctor`, and check PagerDuty's status page if it repeats",
          };
        }
        if (user === null) {
          return {
            ok: false,
            reason: `no PagerDuty user has the email ${from}`,
            repair: `set pagerduty.from in ${FACTORY_CONFIG_FILE} to the email of a user on the PagerDuty account, then: \`pnpm exec jigs up\``,
          };
        }
        return { ok: true, detail: `notes are attributed to ${user.name}` };
      },
    },
  ];
}

async function pagerDutyToken(ctx: FactoryContext): Promise<void> {
  await pagerDutyTokens(ctx).bearer();
}

// A factory that uses PagerDuty names its from user up front, so a run fails
// here rather than at its first note.
export function pagerDutyChecks(ctx: FactoryContext): Check[] {
  let from: string | undefined;
  try {
    from = ctx.config.pagerduty?.from;
  } catch (err) {
    return [
      failedCheck(
        "pagerduty.app",
        "PagerDuty app",
        err instanceof Error ? err.message : String(err),
        `repair ${FACTORY_CONFIG_FILE}, then: \`pnpm exec jigs up\``,
      ),
    ];
  }
  if (from === undefined)
    return [
      failedCheck(
        "pagerduty.app",
        "PagerDuty app",
        `${FACTORY_CONFIG_FILE} has no pagerduty section`,
        `add pagerduty: { from: "<email of a PagerDuty user>" } to ${FACTORY_CONFIG_FILE}, then: \`pnpm exec jigs up\``,
      ),
    ];
  return pagerDutyAppChecks(ctx);
}

// A missing section or an unreadable config is the app check's diagnosis.
export function pagerDutyFromDoctorChecks(ctx: FactoryContext): Check[] {
  let from: string | undefined;
  try {
    from = ctx.config.pagerduty?.from;
  } catch {
    return [];
  }
  if (from === undefined) return [];
  return pagerDutyFromChecks(from, {
    token: () => pagerDutyToken(ctx),
    userByEmail: (email) => pagerDutyClientFor(ctx).findUserByEmail(email),
  });
}
