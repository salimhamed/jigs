import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { harnesses, models } from "../../../../blocks/agents/harness-config.ts";
import { buildAgentRequest } from "../../../../blocks/agents/plan.ts";
import { type DriverResolver, driverFor } from "../../drivers/index.ts";
import { createPiDriver } from "../../drivers/pi.ts";
import {
  type AgentExecutionDependencies,
  defaultAgentExecutionDependencies,
  executeAgent,
} from "../../execute-agent.ts";
import { scrubbedEnv } from "../env.ts";
import { executePi } from "../pi.ts";
import { preparePiInvocationHome } from "../pi-home.ts";
import { planPiModel } from "../pi-model.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { makeScratchRepo } from "./fixtures/live-env.ts";

const baseUrl = process.env.JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL;
const localModel = process.env.JIGS_TEST_OPENAI_COMPATIBLE_MODEL;
const localConfigured =
  baseUrl !== undefined && baseUrl !== "" && localModel !== undefined && localModel !== "";
const localReachable = localConfigured
  ? await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

let tmp: string;
let worktree: string;
let deps: AgentExecutionDependencies;
beforeAll(() => {
  tmp = makeTmpDir();
  worktree = makeScratchRepo(tmp, "pi-run-isolation");
  const pi = createPiDriver({
    preparePiHome: (runId, source) =>
      preparePiInvocationHome(runId, source, { baseDir: path.join(tmp, "managed-pi-homes") }),
    executePi,
  });
  deps = {
    ...defaultAgentExecutionDependencies,
    resolveDriver: ((kind) => (kind === "pi" ? pi : driverFor(kind))) as DriverResolver,
  };
});
afterAll(() => removeTmpDir(tmp));

test.skipIf(!localConfigured || !localReachable)(
  "a real Pi extension is callable in the control home and absent from a managed run",
  async () => {
    const source = models.openaiCompatible({
      name: "lmstudio",
      baseUrl: baseUrl as string,
      model: localModel as string,
    });
    const preparedControl = preparePiInvocationHome("control", planPiModel(harnesses.pi(source)), {
      baseDir: path.join(tmp, "control-pi-homes"),
    });
    const controlHome = preparedControl.home;
    const extensions = path.join(controlHome, "extensions");
    mkdirSync(extensions, { recursive: true });
    const token = `PI-PROBE-${crypto.randomUUID()}`;
    writeFileSync(
      path.join(extensions, "probe.ts"),
      `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_probe_token",
    label: "Get probe token",
    description: "Return the isolation probe token.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: ${JSON.stringify(token)} }], details: {} };
    },
  });
}
`,
    );
    const prompt = [
      "If a tool named get_probe_token is available, call it and reply with exactly its token.",
      "Otherwise reply with exactly NO-PROBE-TOOL.",
    ].join("\n");

    const control = await executePi({
      args: [
        "--mode",
        "json",
        "--model",
        `lmstudio/${localModel as string}`,
        "--no-approve",
        prompt,
      ],
      cwd: worktree,
      env: { ...scrubbedEnv([]), PI_CODING_AGENT_DIR: controlHome },
    });
    expect(control.text).toContain(token);

    const managed = await executeAgent(
      buildAgentRequest({ harness: harnesses.pi(source), cwd: worktree, prompt }),
      { workflowRunId: `live-pi-isolation-${crypto.randomUUID()}` },
      deps,
    );
    if ("jitFailure" in managed) throw new Error("unexpected JIT failure");
    if ("resumeFailed" in managed)
      throw new Error(`unexpected resume failure: ${managed.resumeFailed}`);
    expect(managed.text).not.toContain(token);
  },
);
