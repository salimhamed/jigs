import { readFileSync } from "node:fs";
import type { Check, CheckResult } from "../../../checks/check.ts";
import { SERVICE_ENV_FILE } from "../../../providers/credentials.ts";
import { realCodexAuthPath } from "./home.ts";

// A login file only, never a version.
export function codexAuthCheck(authPath = realCodexAuthPath()): Check {
  return {
    id: "harness.codex-auth",
    label: "Codex subscription login",
    run: async (): Promise<CheckResult> => {
      let raw: string;
      try {
        raw = readFileSync(authPath, "utf8");
      } catch {
        return {
          ok: false,
          reason: `no Codex login found at ${authPath}`,
          repair: "run: `codex login`",
        };
      }
      let auth: { auth_mode?: unknown };
      try {
        auth = JSON.parse(raw) as { auth_mode?: unknown };
      } catch {
        return {
          ok: false,
          reason: `${authPath} is not readable JSON`,
          repair: `remove ${authPath}, then run: \`codex login\``,
        };
      }
      // Deliberately no expiry gating: codex refreshes its JWT lazily, so a
      // stale-looking token is still a valid login.
      if (auth.auth_mode !== "chatgpt") {
        return {
          ok: false,
          reason: `${authPath} reports auth_mode ${JSON.stringify(auth.auth_mode)}, not "chatgpt"`,
          repair: `unset OPENAI_API_KEY in ${SERVICE_ENV_FILE}, then log in with the ChatGPT subscription: \`codex logout && codex login\``,
        };
      }
      return { ok: true };
    },
  };
}
