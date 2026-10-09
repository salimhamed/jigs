import type { GitHubTokenResponse } from "@jigs-ai/hub-protocol";
import type { CheckResult } from "../checks/check.ts";
import type { FactoryContext } from "../config/factory-context.ts";
import { hubRefused, hubToken } from "./hub.ts";

/** Whether the hub hands this factory a token for a GitHub installation, and as which bot. */
export function githubInstallationProbe(
  ctx: FactoryContext,
  issue: (installationName: string) => Promise<GitHubTokenResponse> = (installationName) =>
    hubToken("github", installationName, ctx),
): (installationName: string) => Promise<CheckResult> {
  return async (installationName) => {
    try {
      const { app, account } = await issue(installationName);
      return { ok: true, detail: `${app.slug}[bot] on ${account}` };
    } catch (err) {
      return hubRefused("the hub gave no GitHub token", err);
    }
  };
}
