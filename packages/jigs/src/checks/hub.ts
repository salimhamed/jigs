import type { FactoryContext } from "../config/factory-context.ts";
import type { Check } from "./check.ts";

// Whether the hub answers, and takes the token, is not checked yet.
export function hubChecks(ctx: FactoryContext): Check[] {
  return [
    {
      id: "hub.token",
      label: "hub token",
      run: async () =>
        ctx.env("JIGS_HUB_TOKEN") === undefined
          ? {
              ok: false,
              reason: "JIGS_HUB_TOKEN is not set, so no GitHub event reaches this factory",
              repair:
                "connect the factory with the token the hub showed when you added it: `pnpm exec jigs hub connect <url> <token>`",
            }
          : { ok: true },
    },
  ];
}
