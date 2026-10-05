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
              "JIGS_HUB_TOKEN is not set, so this factory hears nothing and gets no GitHub or Linear token",
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
