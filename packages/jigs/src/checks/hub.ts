import type { FactoryStatus } from "@jigs-ai/hub-protocol";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { fetchFactoryStatus, HUB_CONNECT } from "../providers/hub.ts";
import type { Check } from "./check.ts";

/** Whether the hub answers and takes this factory's token. */
export function hubChecks(
  ctx: FactoryContext,
  status: (ctx: FactoryContext) => Promise<FactoryStatus> = fetchFactoryStatus,
): Check[] {
  return [
    {
      id: "hub.connection",
      label: "hub",
      run: async () => {
        if (ctx.env("JIGS_HUB_TOKEN") === undefined)
          return {
            ok: false,
            reason:
              "JIGS_HUB_TOKEN is not set, so this factory hears nothing and gets no GitHub, Linear or Slack token",
            repair: HUB_CONNECT,
          };
        try {
          const { factory, organization } = await status(ctx);
          return { ok: true, detail: `factory ${factory.name} in ${organization.name}` };
        } catch (err) {
          return {
            ok: false,
            reason: `could not reach the hub at ${ctx.config.hub.url}: ${err instanceof Error ? err.message : String(err)}`,
            repair:
              (err instanceof JigsError ? err.hint : undefined) ??
              "check hub.url in jigs.config.ts and that the hub is running, then: `pnpm exec jigs doctor`",
          };
        }
      },
    },
  ];
}

/** Whether the hub has assigned this factory a Slack app installed in a workspace. */
export function hubSlackChecks(
  ctx: FactoryContext,
  status: (ctx: FactoryContext) => Promise<FactoryStatus> = fetchFactoryStatus,
): Check[] {
  return [
    {
      id: "hub.slack",
      label: "hub Slack app",
      run: async () => {
        let apps: FactoryStatus["apps"];
        try {
          ({ apps } = await status(ctx));
        } catch (err) {
          return {
            ok: false,
            reason: `could not read this factory's Slack apps from the hub: ${err instanceof Error ? err.message : String(err)}`,
            repair:
              (err instanceof JigsError ? err.hint : undefined) ??
              "check hub.url in jigs.config.ts and that the hub is running, then: `pnpm exec jigs doctor`",
          };
        }
        const slack = apps.filter((app) => app.provider === "slack");
        if (slack.length === 0)
          return {
            ok: false,
            reason: "no Slack app is assigned to this factory on the hub",
            repair: "in the hub, assign this factory a Slack app installed in your workspace",
          };
        return {
          ok: true,
          detail: slack
            .map(
              (app) =>
                `${app.name} in ${app.installations.map(({ account }) => account).join(", ") || "no workspace"}`,
            )
            .join("; "),
        };
      },
    },
  ];
}
