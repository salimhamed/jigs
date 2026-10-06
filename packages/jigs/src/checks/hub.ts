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
import type { Provider } from "../workflow/providers.ts";
import type { Check, CheckResult } from "./check.ts";

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

const LABELS: Record<Provider, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  pagerduty: "PagerDuty",
};

export interface InstallationsCheckOptions {
  /** The installations the factory names: in bindings, triggers and agent harnesses. */
  declared: readonly string[];
  /** Mints the installation's token through the hub and makes the provider's cheapest call. */
  probe(installationName: string): Promise<CheckResult>;
  /** The hub's view of the factory; given, every named installation assigned to it is checked too. */
  status?: () => Promise<FactoryStatus>;
}

/**
 * Whether every installation of `provider` the factory uses is named on the
 * hub, assigned to the factory and answers.
 */
export function installationsCheck(
  provider: Provider,
  { declared, probe, status }: InstallationsCheckOptions,
): Check {
  const label = LABELS[provider];
  return {
    id: `${provider}.installations`,
    label: `${label} installations`,
    run: async (): Promise<CheckResult> => {
      const names = new Set(declared);
      if (status !== undefined) {
        let apps: FactoryStatus["apps"];
        try {
          ({ apps } = await status());
        } catch (err) {
          return hubRefused(
            `could not read this factory's ${label} installations from the hub`,
            err,
          );
        }
        for (const app of apps)
          if (app.provider === provider)
            for (const { installationName } of app.installations)
              if (installationName !== null) names.add(installationName);
      }
      if (names.size === 0)
        return {
          ok: false,
          reason: `no ${label} installation is named and assigned to this factory on the hub`,
          repair: `in the hub, name an installation of a ${label} app and assign the app to this factory, then: \`pnpm exec jigs doctor\``,
        };
      const results = await Promise.all(
        [...names].map(async (name) => ({ name, result: await probe(name) })),
      );
      const failed = results.flatMap(({ name, result }) => (result.ok ? [] : [{ name, result }]));
      if (failed.length > 0)
        return {
          ok: false,
          reason: failed.map(({ name, result }) => `${name}: ${result.reason}`).join("; "),
          repair: [...new Set(failed.map(({ result }) => result.repair))].join("\n"),
        };
      return {
        ok: true,
        detail: results
          .map(({ name, result }) =>
            result.ok && result.detail !== undefined ? `${name}: ${result.detail}` : name,
          )
          .join("; "),
      };
    },
  };
}
