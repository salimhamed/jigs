import type { AgentWire } from "../blocks/agent/plan.ts";
import { defaultMergePolicy, readFactoryConfig } from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { getAuthenticatedUser } from "../providers/github.ts";
import { resolveGithubIdentity } from "../providers/github-auth.ts";
import { getViewer } from "../providers/linear.ts";
import { awsCredentialsCheck } from "./aws.ts";
import { bindingChecks } from "./bindings.ts";
import { CHECK_TIMEOUT_MS, type Check } from "./catalog.ts";
import { type CoreProbes, coreChecks, type Integration } from "./core.ts";
import {
  type GithubIdentityProbes,
  githubIdentityChecks,
  realGithubIdentityProbes,
} from "./github-identity.ts";
import { type HarnessKind, harnessChecks } from "./harnesses.ts";
import { linearWebhookChecks } from "./linear-webhook.ts";
import { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";
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
  githubIdentityChecks,
  realGithubIdentityProbes,
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
  aws?: true;
}

// The real provider clients, so a caller of the catalog states only its own
// requirements. Substituting a probe stays a seam on coreChecks itself.
const coreProbes: CoreProbes = { linearViewer: getViewer };
const githubProbes: GithubIdentityProbes = realGithubIdentityProbes(getAuthenticatedUser);

// Which credential jigs holds and what it is allowed to do with it. Both come
// from `jigs.config.ts`; where there is none to read, the defaults are what a
// factory would get, and the credential is still worth checking.
function githubChecks(): Check[] {
  try {
    const { merge } = readFactoryConfig(factoryRoot());
    return githubIdentityChecks(resolveGithubIdentity(), merge, githubProbes);
  } catch {
    // A configuration that cannot be read is the binding checks' diagnosis;
    // the credential is still worth checking, against what a factory that
    // states nothing would get.
    return githubIdentityChecks({ mode: "pat" }, defaultMergePolicy(), githubProbes);
  }
}

export function preflightChecks(requires: WorkflowRequires): Check[] {
  const integrations = requires.integrations ?? [];
  return [
    ...coreChecks(coreProbes, process.env, integrations),
    ...(integrations.includes("github") ? githubChecks() : []),
    ...bindingChecks({ factoryRoot, names: requires.bindings ?? [] }),
    ...harnessChecks(requires.harnesses ?? []),
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
    ...githubChecks(),
    ...(integrations.includes("linear") ? linearWebhookChecks({ factoryRoot }) : []),
    ...bindingChecks({ factoryRoot }),
    ...webhookChecks({ factoryRoot }),
    ...harnessChecks(["claude", "codex"]),
    ...(profile !== undefined && profile !== "" ? [awsCredentialsCheck()] : []),
  ];
}

// Strictly larger than the sum of the MCP check's three phase budgets
// (connect, listTools, callTool), so a slow server is diagnosed by the phase
// that timed out rather than pre-empted by the outer race into a generic
// "did not answer".
export const JIT_TIMEOUT_MS = 3 * CHECK_TIMEOUT_MS + 5_000;

// Preflight's backstop: everything a step can only learn at hydration, once
// the body has built its harness config — which no manifest could declare
// ahead of the run.
export function jitChecks(wire: AgentWire): Check[] {
  const harness = wire.harness;
  return [
    ...(harness.kind === "codex" ? [codexWorktreeConfigCheck(wire.cwd)] : []),
    ...mcpServerChecks(harness.mcpServers ?? {}, wire.cwd),
  ];
}
