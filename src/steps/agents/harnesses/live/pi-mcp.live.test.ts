import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
const baseUrl = process.env.JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL;
const localModel = process.env.JIGS_TEST_OPENAI_COMPATIBLE_MODEL;
const localConfigured =
  baseUrl !== undefined && baseUrl !== "" && localModel !== undefined && localModel !== "";
const localReachable = localConfigured
  ? await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;
// Credential shapes that must never reach the files a run leaves behind.
const CREDENTIAL_MARKERS = [
  /lin_(?:api|oauth)_[A-Za-z0-9]{8,}/,
  /"(?:access|refresh)_token"\s*:/,
  /Bearer [A-Za-z0-9._~+/-]{20,}/,
];

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

test.skipIf(!existsSync(globalMcpPath) || !localConfigured || !localReachable)(
  "Pi calls the explicitly selected read-only Linear server through LM Studio",
  async (context: TestContext) => {
    const globalConfig = JSON.parse(readFileSync(globalMcpPath, "utf8")) as GlobalMcpConfig;
    const selected = globalConfig.mcpServers?.[LINEAR_SERVER];
    if (typeof selected?.url !== "string" || selected.auth !== "oauth") {
      context.skip(
        `blocked live test: ${LINEAR_SERVER} is not configured as an OAuth HTTP server in ${globalMcpPath}`,
      );
    }
    tmp = makeTmpDir();
    const request = buildAgentRequest({
      harness: harnesses.pi(
        models.openaiCompatible({
          name: "lmstudio",
          baseUrl: baseUrl as string,
          model: localModel as string,
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

    const runState = piRunStatePath(runId);
    expect(readdirSync(path.join(runState, "invocations"))).toEqual([]);
    const left = readdirSync(runState, { recursive: true, encoding: "utf8" })
      .map((name) => path.join(runState, name))
      .filter((file) => statSync(file).isFile());
    expect(left.length).toBeGreaterThan(0);
    for (const file of left) {
      const content = readFileSync(file, "utf8");
      for (const marker of CREDENTIAL_MARKERS)
        expect(marker.test(content), `${file} matches ${marker}`).toBe(false);
    }
  },
);
