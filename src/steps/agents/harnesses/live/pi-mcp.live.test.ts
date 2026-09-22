import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, expect, type TestContext, test } from "vitest";
import { harnesses, models } from "../../../../blocks/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../blocks/agents/plan.ts";
import { executeAgent } from "../../execute-agent.ts";
import { piRunStatePath, piSessionsDir, removePiRunState } from "../pi-home.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";

const LINEAR_SERVER = "linear-personal";
const LINEAR_TOOL = "get_issue";
const globalMcpPath = path.join(homedir(), ".config", "mcp", "mcp.json");

type GlobalMcpConfig = {
  mcpServers?: Record<string, { url?: unknown; auth?: unknown }>;
};

// The adapter reports missing OAuth credentials as a tool result, not a Pi
// failure, so the session log is the only exact signal for it.
function adapterNeedsAuth(runId: string): boolean {
  const sessions = piSessionsDir(piRunStatePath(runId));
  if (!existsSync(sessions)) return false;
  return readdirSync(sessions).some((name) =>
    readFileSync(path.join(sessions, name), "utf8")
      .split("\n")
      .some((line) => {
        try {
          const entry = JSON.parse(line) as {
            message?: { role?: unknown; details?: { error?: unknown } };
          };
          return (
            entry.message?.role === "toolResult" && entry.message.details?.error === "auth_required"
          );
        } catch {
          return false;
        }
      }),
  );
}

let tmp: string | undefined;
let runId: string | undefined;
afterEach(() => {
  if (tmp !== undefined) removeTmpDir(tmp);
  if (runId !== undefined) removePiRunState(runId);
});

test.skipIf(!existsSync(globalMcpPath))(
  "Pi calls the explicitly selected read-only Linear server through LM Studio",
  async (context: TestContext) => {
    const globalConfig = JSON.parse(readFileSync(globalMcpPath, "utf8")) as GlobalMcpConfig;
    const selected = globalConfig.mcpServers?.[LINEAR_SERVER];
    if (typeof selected?.url !== "string" || selected.auth !== "oauth") {
      context.skip(
        `blocked live test: ${LINEAR_SERVER} is not configured as an OAuth HTTP server in ${globalMcpPath}`,
      );
    }
    const lmStudio = await fetch("http://127.0.0.1:1234/v1/models", {
      signal: AbortSignal.timeout(3_000),
    }).catch(() => undefined);
    if (lmStudio === undefined)
      context.skip("blocked live test: LM Studio is unavailable at http://127.0.0.1:1234/v1");
    if (!lmStudio.ok)
      context.skip(`blocked live test: LM Studio model endpoint returned HTTP ${lmStudio.status}`);
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

    runId = `pi-linear-${crypto.randomUUID()}`;
    const result = await executeAgent(request, { workflowRunId: runId });
    if ("jitFailure" in result)
      throw new Error(
        `blocked live test: ${result.jitFailure.map((failure) => failure.reason).join("; ")}`,
      );
    if ("resumeFailed" in result) throw new Error(result.resumeFailed);
    if (adapterNeedsAuth(runId))
      context.skip("blocked live test: Linear OAuth credentials are unavailable to pi-mcp-adapter");
    expect(result.text).toContain("AGE-511");
    expect(result.text).toContain("Support explicit pi MCP configuration");
  },
);
