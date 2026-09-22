import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { harnesses, models } from "../../../../blocks/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../blocks/agents/plan.ts";
import { executeAgent } from "../../execute-agent.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";

const LINEAR_SERVER = "linear-personal";
const LINEAR_TOOL = "get_issue";
const globalMcpPath = path.join(homedir(), ".config", "mcp", "mcp.json");

type GlobalMcpConfig = {
  mcpServers?: Record<string, { url?: unknown; auth?: unknown }>;
};

let tmp: string | undefined;
afterEach(() => {
  if (tmp !== undefined) removeTmpDir(tmp);
});

test.skipIf(!existsSync(globalMcpPath))(
  "Pi calls the explicitly selected read-only Linear server through LM Studio",
  async ({ skip }) => {
    const globalConfig = JSON.parse(readFileSync(globalMcpPath, "utf8")) as GlobalMcpConfig;
    const selected = globalConfig.mcpServers?.[LINEAR_SERVER];
    if (typeof selected?.url !== "string" || selected.auth !== "oauth") {
      skip(
        `blocked live test: ${LINEAR_SERVER} is not configured as an OAuth HTTP server in ${globalMcpPath}`,
      );
      return;
    }
    try {
      const models = await fetch("http://127.0.0.1:1234/v1/models", {
        signal: AbortSignal.timeout(3_000),
      });
      if (!models.ok) {
        skip(`blocked live test: LM Studio model endpoint returned HTTP ${models.status}`);
        return;
      }
    } catch {
      skip("blocked live test: LM Studio is unavailable at http://127.0.0.1:1234/v1");
      return;
    }
    tmp = makeTmpDir();
    const request = buildAgentRequest({
      harness: harnesses.pi(
        models.openaiCompatible({
          name: "lmstudio",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "qwen/qwen3.8-27b",
        }),
        {
          mcpServers: {
            [LINEAR_SERVER]: {
              url: selected.url,
              auth: "oauth",
              tools: [LINEAR_TOOL],
              probe: { tool: LINEAR_TOOL, arguments: { id: "AGE-511" } },
            },
          },
        },
      ),
      cwd: tmp,
      prompt:
        "Use the Linear get_issue tool to read AGE-511. Reply with its issue identifier and title.",
    });

    let result: Awaited<ReturnType<typeof executeAgent>>;
    try {
      result = await executeAgent(request, { workflowRunId: `pi-linear-${crypto.randomUUID()}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/auth_required|oauth|credential|login|unauthorized/i.test(message)) {
        skip("blocked live test: Linear OAuth credentials are unavailable to pi-mcp-adapter");
        return;
      }
      throw error;
    }
    if ("jitFailure" in result)
      throw new Error(
        `blocked live test: ${result.jitFailure.map((failure) => failure.reason).join("; ")}`,
      );
    if ("resumeFailed" in result) throw new Error(result.resumeFailed);
    if (/auth_required|oauth credentials|unauthorized/i.test(result.text)) {
      skip("blocked live test: Linear OAuth credentials are unavailable to pi-mcp-adapter");
      return;
    }
    expect(result.text).toContain("AGE-511");
    expect(result.text).toContain("Support explicit pi MCP configuration");
  },
);
