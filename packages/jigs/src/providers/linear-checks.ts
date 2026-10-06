import type { LinearTokenResponse } from "@jigs-ai/hub-protocol";
import type { CheckResult } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { FACTORY_CONFIG_FILE } from "../workflow/factory-schema.ts";
import { hubRefused, hubToken } from "./hub.ts";
import { type LinearUser, linearFor } from "./linear.ts";

export interface LinearInstallationProbeDeps {
  /** The operator's email to find in the installation's workspace; doctor checks it, preflight does not. */
  operator?: string;
  issue?: (installationName: string) => Promise<LinearTokenResponse>;
  userByEmail?: (installationName: string, email: string) => Promise<LinearUser | null>;
}

/**
 * Whether the hub hands this factory a Linear installation's token and, when an
 * operator is given, whether a Linear user there has that email.
 */
export function linearInstallationProbe(
  ctx: FactoryContext,
  deps: LinearInstallationProbeDeps = {},
): (installationName: string) => Promise<CheckResult> {
  const issue = deps.issue ?? ((name: string) => hubToken("linear", name, ctx));
  const userByEmail =
    deps.userByEmail ??
    ((name: string, email: string) => linearFor(name, ctx).findUserByEmail(email));
  const { operator } = deps;
  return async (installationName) => {
    let app: LinearTokenResponse["app"];
    try {
      ({ app } = await issue(installationName));
    } catch (err) {
      return hubRefused("the hub gave no Linear token", err);
    }
    if (operator === undefined) return { ok: true, detail: `acting as ${app.name}` };
    let user: LinearUser | null;
    try {
      user = await userByEmail(installationName, operator);
    } catch (err) {
      return {
        ok: false,
        reason: `could not look up ${operator} in Linear: ${err instanceof Error ? err.message : String(err)}`,
        repair: "retry: `pnpm exec jigs doctor`, and check Linear's status page if it repeats",
      };
    }
    if (user === null)
      return {
        ok: false,
        reason: `no active Linear user has the email ${operator}`,
        repair: `set linear.operator in ${FACTORY_CONFIG_FILE} to the email of an active user in this Linear workspace, or remove it to mention the ticket's creator, then: \`pnpm exec jigs up\``,
      };
    return { ok: true, detail: `acting as ${app.name}, mentions ${user.name}` };
  };
}
