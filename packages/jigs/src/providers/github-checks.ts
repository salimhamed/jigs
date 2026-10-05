// Whether the hub can hand this factory a GitHub token for every repository it
// is bound to: a GitHub App assigned to the factory, installed on each owner,
// and only one of them per owner.

import type { FactoryStatus } from "@jigs-ai/hub-protocol";
import type { Check, CheckResult } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { parseGithubRemote } from "./github-remote.ts";
import { fetchFactoryStatus } from "./hub.ts";

export function githubChecks(
  ctx: FactoryContext,
  status: (ctx: FactoryContext) => Promise<FactoryStatus> = fetchFactoryStatus,
): Check[] {
  return [
    {
      id: "github.identity",
      label: "GitHub App",
      run: async (): Promise<CheckResult> => {
        let apps: FactoryStatus["apps"];
        try {
          ({ apps } = await status(ctx));
        } catch (err) {
          return {
            ok: false,
            reason: `could not read this factory's GitHub Apps from the hub: ${err instanceof Error ? err.message : String(err)}`,
            repair:
              (err instanceof JigsError ? err.hint : undefined) ??
              "check hub.url in jigs.config.ts and that the hub is running, then: `pnpm exec jigs doctor`",
          };
        }
        const github = apps.filter((app) => app.provider === "github");
        if (github.length === 0)
          return {
            ok: false,
            reason: "no GitHub App is assigned to this factory on the hub",
            repair:
              "in the hub, assign this factory a GitHub App installed on each bound repository's owner",
          };
        const owners = [
          ...new Set(
            Object.values(ctx.config.bindings).flatMap(
              ({ remote }) => parseGithubRemote(remote)?.owner ?? [],
            ),
          ),
        ];
        const installedOn = (owner: string) =>
          github.filter((app) =>
            app.installations.some(({ account }) => account.toLowerCase() === owner.toLowerCase()),
          );
        const missing = owners.filter((owner) => installedOn(owner).length === 0);
        if (missing.length > 0)
          return {
            ok: false,
            reason: `no GitHub App assigned to this factory is installed on ${missing.join(", ")}`,
            repair: `in the hub, install one of this factory's GitHub Apps on ${missing.join(", ")}, or assign the factory an App installed there`,
          };
        const shared = owners.filter((owner) => installedOn(owner).length > 1);
        if (shared.length > 0)
          return {
            ok: false,
            reason: shared
              .map(
                (owner) =>
                  `${owner} has more than one of this factory's GitHub Apps installed (${installedOn(
                    owner,
                  )
                    .map((app) => app.name)
                    .join(", ")})`,
              )
              .join("; "),
            repair: "in the hub, leave this factory assigned only one App installed on each owner",
          };
        return {
          ok: true,
          detail: github
            .map(
              (app) =>
                `${app.name} on ${app.installations.map(({ account }) => account).join(", ") || "no account"}`,
            )
            .join("; "),
        };
      },
    },
  ];
}
