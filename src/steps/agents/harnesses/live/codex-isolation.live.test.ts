import { generateText } from "ai";
import { parse } from "smol-toml";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  codexAppServerStepSettings,
  codexExecStepSettings,
  withCodexAppServer,
} from "../../drivers/codex-support.ts";
import { stripApiCredentials } from "../env.ts";
import { codexExec } from "../index.ts";
import { makeTmpDir, managedCodexHomeState, removeTmpDir } from "../test-fixtures.ts";
import {
  assertLivePreconditions,
  makeControlCodexHome,
  makeManagedHome,
  makeScratchRepo,
  PROBE_PROMPT,
} from "./fixtures/live-env.ts";

// The isolation acceptance criterion, with a LIVE CONTROL and a REAL tool call
// as the observable — agent self-enumeration misreports. Control home declares
// the probe server with an unguessable token; the managed home is curated.
// Both surfaces run against both homes.

let tmp: string;
let scratch: string;
let controlHome: string;
let managedHome: string;
const probeToken = `PROBE-${crypto.randomUUID()}`;

beforeAll(() => {
  assertLivePreconditions();
  stripApiCredentials();
  tmp = makeTmpDir();
  scratch = makeScratchRepo(tmp);
  controlHome = makeControlCodexHome(tmp, probeToken);
  managedHome = makeManagedHome(tmp, "live-isolation");
});
afterAll(() => {
  removeTmpDir(tmp);
});

async function execProbe(codexHome: string): Promise<string> {
  const model = codexExec(
    "gpt-5.5",
    codexExecStepSettings({
      cwd: scratch,
      codexHome,
      // Non-interactive exec auto-DENIES MCP tool approvals under
      // approvalMode 'never' ("user cancelled MCP tool call"), which would
      // fake a passing isolation result. Probe-only bypass; scratch dir.
      dangerouslyBypassApprovalsAndSandbox: true,
      reasoningEffort: "low",
    }),
  );
  return (await generateText({ model, prompt: PROBE_PROMPT })).text;
}

async function appServerProbe(codexHome: string): Promise<string> {
  return withCodexAppServer(async (provider) => {
    const model = provider(
      "gpt-5.5",
      codexAppServerStepSettings({
        cwd: scratch,
        codexHome,
        approvalPolicy: "never",
        // The sandbox an agent step actually runs under. Codex 0.153 made an
        // MCP tool call an approvable action, and under any narrower sandbox
        // approvalPolicy 'never' auto-DENIES it ("MCP tool call requires
        // approval, but approval policy is never") — which would fake a
        // passing isolation result, the way the exec bypass above would.
        sandboxPolicy: "danger-full-access",
        effort: "low",
        autoApprove: true,
      }),
    );
    return (await generateText({ model, prompt: PROBE_PROMPT })).text;
  });
}

test("control (exec): the probe server IS callable — the observable works", async () => {
  expect(await execProbe(controlHome)).toContain(probeToken);
});

test("managed (exec): the probe server is absent", async () => {
  expect(await execProbe(managedHome)).not.toContain(probeToken);
});

test("control (app-server): the probe server IS callable", async () => {
  expect(await appServerProbe(controlHome)).toContain(probeToken);
});

test("managed (app-server): the probe server is absent; home stays curated", async () => {
  expect(await appServerProbe(managedHome)).not.toContain(probeToken);
  // Codex prepends trust records and personality (codex-mutable state), but
  // must not have gained any mcp_servers declaration. Parsed, not substring:
  // the curated comment itself mentions mcp_servers.
  const config = parse(managedCodexHomeState(managedHome).configToml);
  expect(config.mcp_servers ?? {}).toEqual({});
});
