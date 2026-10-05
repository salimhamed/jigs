import type { LinearTokenResponse } from "@jigs-ai/hub-protocol";
import type { Check } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { FACTORY_CONFIG_FILE } from "../workflow/factory-schema.ts";
import { hubRefused, hubToken } from "./hub.ts";
import { findUserByEmail, type LinearUser } from "./linear.ts";

/** Whether the hub hands this factory a Linear token: a Linear app assigned, connected and current. */
export function linearChecks(
  ctx: FactoryContext,
  issue: (ctx: FactoryContext) => Promise<LinearTokenResponse> = (ctx) =>
    hubToken("linear", {}, ctx),
): Check[] {
  return [
    {
      id: "linear.identity",
      label: "Linear app",
      run: async () => {
        try {
          const { app } = await issue(ctx);
          return { ok: true, detail: `acting as ${app.name}` };
        } catch (err) {
          return hubRefused("the hub has no Linear token for this factory", err);
        }
      },
    },
  ];
}

// Doctor only, never preflight: a mention must never stop a run from starting.
/** Whether the factory's operator email belongs to a Linear user who will be notified. */
export function linearOperatorChecks(
  email: string | undefined,
  userByEmail: (email: string) => Promise<LinearUser | null>,
): Check[] {
  if (email === undefined) return [];
  return [
    {
      id: "linear.operator",
      label: "Linear operator",
      run: async () => {
        let user: LinearUser | null;
        try {
          user = await userByEmail(email);
        } catch (err) {
          return {
            ok: false,
            reason: `could not look up ${email} in Linear: ${err}`,
            repair: "repair the Linear app check, then: `pnpm exec jigs doctor`",
          };
        }
        if (user === null) {
          return {
            ok: false,
            reason: `no active Linear user has the email ${email}`,
            repair: `set linear.operator in ${FACTORY_CONFIG_FILE} to the email of an active user in this Linear workspace, or remove it to mention the ticket's creator, then: \`pnpm exec jigs up\``,
          };
        }
        return { ok: true, detail: `mentions ${user.name}` };
      },
    },
  ];
}

// An unreadable config is reported by the binding checks, so it adds nothing here.
export function linearOperatorDoctorChecks(ctx: FactoryContext): Check[] {
  let operator: string | undefined;
  try {
    ({ operator } = ctx.config.linear);
  } catch {
    return [];
  }
  return linearOperatorChecks(operator, findUserByEmail);
}
