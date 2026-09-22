import type {
  AskableModelSource,
  McpServerConfig,
  PiMcpServerConfig,
} from "../blocks/agents/harness-config.ts";
import type { AgentRequest } from "../blocks/agents/plan.ts";
import { defaultMergePolicy, readFactoryConfig } from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { getAuthenticatedUser } from "../providers/github.ts";
import { resolveGithubIdentities } from "../providers/github-auth.ts";
import { getViewer } from "../providers/linear.ts";
import { driverFor, drivers } from "../steps/agents/drivers/index.ts";
import { awsCredentialsCheck } from "./aws.ts";
import { bindingChecks } from "./bindings.ts";
import { CHECK_TIMEOUT_MS, type Check } from "./catalog.ts";
import { type CoreProbes, coreChecks, type Integration } from "./core.ts";
import {
  type GithubIdentityProbes,
  githubIdentityChecks,
  realGithubIdentityProbes,
} from "./github-identity.ts";
import { type HarnessKind, harnessChecks, missingDriverCheck } from "./harnesses.ts";
import { linearWebhookChecks } from "./linear-webhook.ts";
import { mcpServerChecks } from "./mcp.ts";
import { webhookChecks } from "./webhooks.ts";

export { type BindingChecksOptions, bindingChecks } from "./bindings.ts";
export {
  CHECK_TIMEOUT_MS,
  type Check,
  type CheckOutcome,
  type CheckReport,
  type CheckResult,
  type FailedCheck,
  failedCheck,
  failedChecks,
  formatFailures,
  runChecks,
} from "./catalog.ts";
export {
  type CoreProbes,
  coreChecks,
  RESTART_SERVICE,
  SERVICE_ENV_FILE,
} from "./core.ts";
export {
  type GithubIdentityProbes,
  type GithubMergePolicyProbes,
  githubIdentityChecks,
  mergePolicyCheck,
  realGithubIdentityProbes,
  realGithubMergePolicyProbes,
} from "./github-identity.ts";
export {
  type HarnessRuntime,
  type HarnessRuntimeDeps,
  harnessRuntime,
  harnessRuntimes,
} from "./harness-runtime.ts";
export {
  claudeAuthCheck,
  codexAuthCheck,
  type HarnessKind,
  harnessChecks,
  harnessRuntimeCheck,
} from "./harnesses.ts";
export { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";
export { type WebhookChecksOptions, webhookChecks } from "./webhooks.ts";

// A workflow's declared requirements — the manifest side of the computed check
// list. Hand-maintaining the list is the drift trap this exists to avoid.
export interface WorkflowRequires {
  integrations?: Integration[];
  bindings?: string[];
  harnesses?: HarnessKind[];
  models?: AskableModelSource[];
  aws?: true;
}

// The real provider clients, so a caller of the catalog states only its own
// requirements. Substituting a probe stays a seam on coreChecks itself.
const coreProbes: CoreProbes = { linearViewer: getViewer };
const githubProbes: GithubIdentityProbes = realGithubIdentityProbes(getAuthenticatedUser);

// Which credential jigs holds and what it is allowed to do with it. Both come
// from `jigs.config.ts`; where there is none to read, the defaults are what a
// factory would get, and the credential is still worth checking.
function githubChecks(checkBindings = false): Check[] {
  try {
    const { merge, bindings } = readFactoryConfig(factoryRoot());
    return githubIdentityChecks(
      resolveGithubIdentities(),
      merge,
      githubProbes,
      process.env,
      checkBindings ? bindings : {},
    );
  } catch {
    // A configuration that cannot be read is the binding checks' diagnosis;
    // the credential is still worth checking, against what a factory that
    // states nothing would get.
    return githubIdentityChecks([{ mode: "pat" }], defaultMergePolicy(), githubProbes);
  }
}

export function preflightChecks(
  requires: WorkflowRequires,
  inputs?: Record<string, unknown>,
): Check[] {
  const integrations = requires.integrations ?? [];
  // A binding selected by this run is more specific than the workflow's
  // static requirements. Workflows without a binding input retain the fixed
  // binding list declared in their manifest.
  const bindings =
    typeof inputs?.binding === "string" ? [inputs.binding] : (requires.bindings ?? []);
  return [
    ...coreChecks(coreProbes, process.env, integrations),
    ...(integrations.includes("github") ? githubChecks() : []),
    ...bindingChecks({ factoryRoot, names: bindings }),
    ...harnessChecks(requires.harnesses ?? []),
    ...(requires.models ?? []).flatMap((source) => {
      const driver = driverFor(source.kind);
      if (driver === undefined) return [missingDriverCheck(source.kind)];
      return [...driver.installationChecks(), ...(driver.descriptorChecks?.(source) ?? [])];
    }),
    ...(requires.aws ? [awsCredentialsCheck()] : []),
  ];
}

// Without a workflow manifest, doctor checks integrations configured in the environment.
export function doctorChecks(): Check[] {
  const profile = process.env.AWS_PROFILE;
  const integrations: Integration[] = [];
  if (process.env.LINEAR_API_KEY) integrations.push("linear");
  return [
    ...coreChecks(coreProbes, process.env, integrations),
    // Always: an App identity needs no environment variable to be configured,
    // so there is nothing to detect — the configuration itself is the answer.
    ...githubChecks(true),
    ...(integrations.includes("linear") ? linearWebhookChecks({ factoryRoot }) : []),
    ...bindingChecks({ factoryRoot }),
    ...webhookChecks({ factoryRoot }),
    ...Object.values(drivers).flatMap((driver) =>
      driver.family === "harness" ? driver.installationChecks() : [],
    ),
    ...(profile !== undefined && profile !== "" ? [awsCredentialsCheck()] : []),
  ];
}

// Strictly larger than the sum of the MCP check's three phase budgets
// (connect, listTools, callTool), so a slow server is diagnosed by the phase
// that timed out rather than pre-empted by the outer race into a generic
// "did not answer".
export const JIT_TIMEOUT_MS = 3 * CHECK_TIMEOUT_MS + 5_000;

function resolveNamedEnvironment(values: Record<string, string> | undefined) {
  if (values === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([target, source]) => [target, process.env[source] ?? ""]),
  );
}

function piProbeServer(server: PiMcpServerConfig): McpServerConfig {
  if ("command" in server) {
    return {
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { env: resolveNamedEnvironment(server.env) }),
      probe: server.probe,
    };
  }
  const headers = resolveNamedEnvironment(server.headers) ?? {};
  if (server.bearerTokenEnv !== undefined)
    headers.authorization = `Bearer ${process.env[server.bearerTokenEnv] ?? ""}`;
  return {
    url: server.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    probe: server.probe,
  };
}

// Preflight's backstop: everything a step can only learn at hydration, once
// the body has built its harness config — which no manifest could declare
// ahead of the run.
export function jitChecks(wire: AgentRequest): Check[] {
  const harness = wire.harness;
  if (wire.cwd === undefined) return [];
  const driver = driverFor(harness.kind);
  const probeableServers =
    harness.kind === "pi"
      ? Object.fromEntries(
          Object.entries(harness.mcpServers ?? {})
            .filter(([, server]) => !("auth" in server && server.auth === "oauth"))
            .map(([name, server]) => [name, piProbeServer(server)]),
        )
      : (harness.mcpServers ?? {});
  return [
    ...(driver?.jitChecks?.(wire) ?? []),
    // Pi's pinned adapter owns OAuth refresh and secure-store access. A raw MCP
    // client cannot reproduce that flow without adding a second integration,
    // so OAuth servers are exercised by the Pi tool call itself.
    ...mcpServerChecks(
      probeableServers,
      wire.cwd,
      harness.kind === "pi" ? { inheritEnv: false } : {},
    ),
  ];
}
