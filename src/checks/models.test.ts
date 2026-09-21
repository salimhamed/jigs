import { expect, test } from "vitest";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";
import { modelApiKeyCheck } from "./models.ts";

test("an API model credential check requires the named environment variable without probing", async () => {
  const missing = await modelApiKeyCheck("OPENROUTER_API_KEY", {}).run();
  expect(missing).toEqual({
    ok: false,
    reason: "OPENROUTER_API_KEY is not set in the service's environment",
    repair: `set OPENROUTER_API_KEY in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
  });

  await expect(
    modelApiKeyCheck("TEAM_OPENROUTER_KEY", { TEAM_OPENROUTER_KEY: "configured" }).run(),
  ).resolves.toEqual({ ok: true });
});
