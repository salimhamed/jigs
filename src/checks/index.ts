import type {
  AskableModelSource,
  Harness,
  McpServerConfig,
  PiMcpServerConfig,
} from "../blocks/agents/harness-config.ts";
import type { AgentRequest } from "../blocks/agents/plan.ts";
import {
  defaultMergePolicy,
  FACTORY_CONFIG_FILE,
  type LinearIdentity,
  readFactoryConfig,
} from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { getAuthenticatedUser } from "../providers/github.ts";
import { resolveGithubIdentities } from "../providers/github-auth.ts";
import { getViewer } from "../providers/linear.ts";
import { resolveLinearIdentity } from "../providers/linear-auth.ts";
import { driverFor } from "../steps/agents/drivers/index.ts";
import { awsCredentialsCheck } from "./aws.ts";
import { bindingChecks } from "./bindings.ts";
import {
  CHECK_TIMEOUT_MS,
  type Check,
  failedCheck,
  neededByWorkflows,
  requirementUsers,
  type WorkflowManifests,
} from "./catalog.ts";
import { type Integration, RESTART_SERVICE } from "./core.ts";
import {
  type GithubIdentityProbes,
  githubIdentityChecks,
  realGithubIdentityProbes,
} from "./github-identity.ts";
import {
  harnessChecks,
  harnessUsers,
  missingDriverCheck,
  requiredHarnessKinds,
  usedHarnessChecks,
} from "./harnesses.ts";
import { type LinearIdentityProbes, linearIdentityChecks } from "./linear-identity.ts";
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
export { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";
export {
  type GithubIdentityCheckOptions,
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
export { type LinearIdentityProbes, linearIdentityChecks } from "./linear-identity.ts";
export { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";
export { type WebhookChecksOptions, webhookChecks } from "./webhooks.ts";

// A workflow's declared requirements — the manifest side of the computed check
// list. Hand-maintaining the list is the drift trap this exists to avoid.
export interface WorkflowRequires {
  agents?: Record<string, Harness>;
  integrations?: Integration[];
  bindings?: string[];
  models?: AskableModelSource[];
  aws?: true;
}

// The real provider clients, so a caller of the catalog states only its own
// requirements. Substituting a probe stays a seam on each check factory.
const linearProbes: LinearIdentityProbes = { viewer: getViewer };
const githubProbes: GithubIdentityProbes = realGithubIdentityProbes(getAuthenticatedUser);

// Which credential jigs holds and what it is allowed to do with it. Both come
// from `jigs.config.ts`; where there is none to read, the defaults are what a
// factory would get, and the credential is still worth checking.
function githubChecks(checkBindings = false): Check[] {
  try {
    const { merge, bindings, webhooks } = readFactoryConfig(factoryRoot());
    return githubIdentityChecks(resolveGithubIdentities(), merge, githubProbes, process.env, {
      bindings: checkBindings ? bindings : {},
      webhooks: webhooks?.github.enabled ?? false,
    });
  } catch {
    // A configuration that cannot be read is the binding checks' diagnosis;
    // the credential is still worth checking, against what a factory that
    // states nothing would get.
    return githubIdentityChecks([{ mode: "pat" }], defaultMergePolicy(), githubProbes);
  }
}

// A configuration that cannot be read says nothing about the credential, so it
// fails as itself rather than as a key Linear rejected.
function linearChecks(): Check[] {
  let identity: LinearIdentity;
  try {
    identity = resolveLinearIdentity();
  } catch (err) {
    return [
      failedCheck(
        "linear.identity",
        "Linear identity",
        err instanceof Error ? err.message : String(err),
        `repair ${FACTORY_CONFIG_FILE}, then: ${RESTART_SERVICE}`,
      ),
    ];
  }
  return linearIdentityChecks(identity, linearProbes);
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
    ...(integrations.includes("linear") ? linearChecks() : []),
    ...(integrations.includes("github") ? githubChecks() : []),
    ...bindingChecks({ factoryRoot, names: bindings }),
    ...harnessChecks(requiredHarnessKinds(requires)),
    ...(requires.models ?? []).flatMap((source) => {
      const driver = driverFor(source.kind);
      if (driver === undefined) return [missingDriverCheck(source.kind)];
      return [...driver.installationChecks(), ...(driver.descriptorChecks?.(source) ?? [])];
    }),
    ...(requires.aws ? [awsCredentialsCheck()] : []),
  ];
}

// Beyond what a workflow requires, the configuration can ask for a provider
// itself: a binding or a GitHub webhook needs GitHub, a Linear webhook needs
// Linear, and an App identity is set up on purpose. The key and PAT identities
// are what every scaffold states, so they ask for nothing. An unreadable config
// asks for nothing either: the binding checks report it.
function configuredProviders(): Record<Integration, boolean> {
  try {
    const { bindings, webhooks, github, linear } = readFactoryConfig(factoryRoot());
    return {
      github:
        Object.keys(bindings).length > 0 ||
        (webhooks?.github.enabled ?? false) ||
        github.identities.some((identity) => identity.mode === "app"),
      linear: (webhooks?.linear.enabled ?? false) || linear.identity.mode === "app",
    };
  } catch {
    return { github: false, linear: false };
  }
}

// Every check follows the factory: its workflows' manifests and its
// configuration. A provider, harness or AWS profile nothing uses is not checked.
export function doctorChecks(workflows: WorkflowManifests): Check[] {
  const users = requirementUsers(workflows, (requires) => [
    ...(requires.integrations ?? []),
    ...(requires.aws ? (["aws"] as const) : []),
  ]);
  const configured = configuredProviders();
  const provider = (name: Integration, checks: () => Check[]): Check[] => {
    const needing = users.get(name) ?? [];
    return needing.length > 0 || configured[name] ? neededByWorkflows(checks(), needing) : [];
  };
  const aws = users.get("aws") ?? [];
  return [
    ...provider("linear", linearChecks),
    ...provider("github", () => githubChecks(true)),
    // Keyed on the config rather than the Linear credential: a Linear webhook
    // switched on without its secret is a failure even where that is missing too.
    ...linearWebhookChecks({ factoryRoot }),
    ...bindingChecks({ factoryRoot }),
    ...webhookChecks({ factoryRoot }),
    ...usedHarnessChecks(harnessUsers(workflows)),
    ...(aws.length > 0 ? neededByWorkflows([awsCredentialsCheck()], aws) : []),
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
// ahead of the run. `env` is the environment the step hands its harness.
export function jitChecks(wire: AgentRequest, env: Record<string, string>): Check[] {
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
    ...mcpServerChecks(probeableServers, wire.cwd, harness.kind === "pi" ? {} : env),
  ];
}
