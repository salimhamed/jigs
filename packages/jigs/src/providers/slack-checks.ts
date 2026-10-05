import { type SlackTokenResponse, slackBotScopes } from "@jigs-ai/hub-protocol";
import type { Check } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { fetchSlackToken } from "./hub.ts";

const and = (items: readonly string[]) => items.join(" and ");

// An unreadable config is the binding checks' diagnosis, so it asks for no extra scopes here.
function declaredScopes(ctx: FactoryContext): string[] {
  let extra: readonly string[] = [];
  try {
    extra = ctx.config.slack?.scopes ?? [];
  } catch {}
  return [...new Set([...slackBotScopes, ...extra])];
}

/**
 * Whether the hub hands this factory a Slack bot token, and the workspace granted it every scope
 * jigs uses plus the factory's own `slack.scopes`.
 */
export function slackChecks(
  ctx: FactoryContext,
  issue: (ctx: FactoryContext) => Promise<SlackTokenResponse> = fetchSlackToken,
): Check[] {
  return [
    {
      id: "slack.identity",
      label: "Slack app",
      run: async () => {
        let issued: SlackTokenResponse;
        try {
          issued = await issue(ctx);
        } catch (err) {
          return {
            ok: false,
            reason: `the hub has no Slack token for this factory: ${err instanceof Error ? err.message : String(err)}`,
            repair:
              (err instanceof JigsError ? err.hint : undefined) ??
              "check hub.url in jigs.config.ts and that the hub is running, then: `pnpm exec jigs doctor`",
          };
        }
        const granted = new Set(issued.scopes);
        const missing = declaredScopes(ctx).filter((scope) => !granted.has(scope));
        if (missing.length > 0)
          return {
            ok: false,
            reason: `${issued.app.name}'s bot token lacks ${and(missing)}`,
            repair: `in the hub, add ${and(missing)} to ${issued.app.name}'s bot scopes and install it in the workspace again, then: \`pnpm exec jigs doctor\``,
          };
        return { ok: true, detail: `acting as ${issued.app.name} in ${issued.team}` };
      },
    },
  ];
}
