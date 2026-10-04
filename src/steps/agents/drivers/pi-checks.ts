import { readFileSync } from "node:fs";
import type { Check, CheckResult } from "../../../checks/check.ts";
import type { PiMcpServerConfig } from "../../../workflow/agents/harness-config.ts";
import { piMcpToolNames } from "../harnesses/pi-extension.ts";
import { realPiAuthPath } from "../harnesses/pi-home.ts";

/** Check that Pi's shared login file contains an OpenAI Codex login. */
export function piOpenaiCodexAuthCheck(authPath = realPiAuthPath()): Check {
  return {
    id: "harness.pi-openai-codex-auth",
    label: "Pi OpenAI Codex login",
    run: async (): Promise<CheckResult> => {
      let auth: unknown;
      try {
        auth = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
      } catch {
        return {
          ok: false,
          reason: `no readable Pi login found at ${authPath}`,
          repair: "start Pi, then choose /login and OpenAI Codex: `pi`",
        };
      }
      if (typeof auth !== "object" || auth === null || !("openai-codex" in auth)) {
        return {
          ok: false,
          reason: `${authPath} has no OpenAI Codex login`,
          repair: "start Pi, then choose /login and OpenAI Codex: `pi`",
        };
      }
      return { ok: true };
    },
  };
}

/** Check that the adapter gives every MCP tool Pi may call a name of its own. */
export function piMcpToolNamesCheck(servers: Record<string, PiMcpServerConfig>): Check {
  return {
    id: "harness.pi-mcp-tools",
    label: "Pi MCP tool names",
    run: async (): Promise<CheckResult> => {
      const names = piMcpToolNames(servers);
      const repeated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
      return repeated.length === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `Pi would expose more than one MCP tool as ${repeated.join(", ")}: it names each tool after its server`,
            repair: "rename a server in the Pi harness's mcpServers, or drop one of the tools",
          };
    },
  };
}
