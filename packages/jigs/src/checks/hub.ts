import type { FactoryStatus } from "@jigs-ai/hub-protocol";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import {
  fetchFactoryStatus,
  HUB_CONNECT,
  type HubConnection,
  hubConnection,
  hubRefused,
} from "../providers/hub.ts";
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
        let hub: HubConnection;
        try {
          hub = hubConnection(ctx);
        } catch (err) {
          return {
            ok: false,
            reason: `${err instanceof Error ? err.message : String(err)}, so this factory hears nothing and gets no GitHub, Linear, Slack or PagerDuty token`,
            repair: (err instanceof JigsError ? err.hint : undefined) ?? HUB_CONNECT,
          };
        }
        try {
          const { factory, organization } = await status(ctx);
          return { ok: true, detail: `factory ${factory.name} in ${organization.name}` };
        } catch (err) {
          return hubRefused(`could not reach the hub at ${hub.url}`, err);
        }
      },
    },
  ];
}

const APP_CHECKS = {
  slack: {
    label: "Slack",
    where: "no workspace",
    repair: "in the hub, assign this factory a Slack app installed in your workspace",
  },
  pagerduty: {
    label: "PagerDuty",
    where: "no account",
    repair: "in the hub, assign this factory a PagerDuty app installed on your account",
  },
};

/** Whether the hub has assigned this factory an app of `provider`, and where it is installed. */
export function hubAppChecks(
  ctx: FactoryContext,
  provider: keyof typeof APP_CHECKS,
  status: (ctx: FactoryContext) => Promise<FactoryStatus> = fetchFactoryStatus,
): Check[] {
  const { label, where, repair } = APP_CHECKS[provider];
  return [
    {
      id: `hub.${provider}`,
      label: `hub ${label} app`,
      run: async () => {
        let apps: FactoryStatus["apps"];
        try {
          ({ apps } = await status(ctx));
        } catch (err) {
          return hubRefused(`could not read this factory's ${label} apps from the hub`, err);
        }
        const assigned = apps.filter((app) => app.provider === provider);
        if (assigned.length === 0)
          return {
            ok: false,
            reason: `no ${label} app is assigned to this factory on the hub`,
            repair,
          };
        return {
          ok: true,
          detail: assigned
            .map(
              (app) =>
                `${app.name} in ${app.installations.map(({ account }) => account).join(", ") || where}`,
            )
            .join("; "),
        };
      },
    },
  ];
}
