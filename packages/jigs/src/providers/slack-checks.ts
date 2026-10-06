import { type SlackTokenResponse, slackBotScopes } from "@jigs-ai/hub-protocol";
import type { CheckResult } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { hubRefused, hubToken } from "./hub.ts";

const and = (items: readonly string[]) => items.join(" and ");

/** Whether the hub hands this factory a Slack installation's bot token, granted every scope jigs uses. */
export function slackInstallationProbe(
  ctx: FactoryContext,
  issue: (installationName: string) => Promise<SlackTokenResponse> = (installationName) =>
    hubToken("slack", installationName, ctx),
): (installationName: string) => Promise<CheckResult> {
  return async (installationName) => {
    let issued: SlackTokenResponse;
    try {
      issued = await issue(installationName);
    } catch (err) {
      return hubRefused("the hub gave no Slack token", err);
    }
    const granted = new Set(issued.scopes);
    const missing = slackBotScopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0)
      return {
        ok: false,
        reason: `${issued.app.name}'s bot token lacks ${and(missing)}`,
        repair: `in the hub, add ${and(missing)} to ${issued.app.name}'s bot scopes and install it in the workspace again, then: \`pnpm exec jigs doctor\``,
      };
    return { ok: true, detail: `acting as ${issued.app.name} in ${issued.team}` };
  };
}
