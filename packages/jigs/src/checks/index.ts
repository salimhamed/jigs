import { factoryRoot } from "../config/factory-root.ts";
import { getAuthenticatedUser } from "../providers/github.ts";
import { getViewer } from "../providers/linear.ts";
import type { AgentWire } from "../steps/plan.ts";
import { awsCredentialsCheck } from "./aws.ts";
import { bindingChecks } from "./bindings.ts";
import { CHECK_TIMEOUT_MS, type Check } from "./catalog.ts";
import { type CoreProbes, coreChecks } from "./core.ts";
import { type HarnessKind, harnessChecks } from "./harnesses.ts";
import { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";

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
  claudeAuthCheck,
  codexAuthCheck,
  type HarnessKind,
  harnessChecks,
} from "./harnesses.ts";
export { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";

// A pipeline's declared requirements — the manifest side of the computed
// check list (ADR 0010). Hand-maintaining the list is the drift trap this
// exists to avoid.
export interface PipelineRequires {
  bindings?: string[];
  harnesses?: HarnessKind[];
  aws?: true;
}

// The real provider clients, so a caller of the catalog states only its own
// requirements. Substituting a probe stays a seam on coreChecks itself.
const coreProbes: CoreProbes = {
  linearViewer: getViewer,
  githubWhoami: getAuthenticatedUser,
};

export function preflightChecks(requires: PipelineRequires): Check[] {
  return [
    ...coreChecks(coreProbes),
    ...bindingChecks({ factoryRoot, names: requires.bindings ?? [] }),
    ...harnessChecks(requires.harnesses ?? []),
    ...(requires.aws ? [awsCredentialsCheck()] : []),
  ];
}

// No pipeline, so no manifest: doctor takes every declared binding and both
// harnesses. MCP is absent on purpose — it is JIT-only (ADR 0011). AWS is
// conditional for the same reason: with no manifest to read, a set
// AWS_PROFILE is the only evidence this factory uses AWS at all.
export function doctorChecks(): Check[] {
  const profile = process.env.AWS_PROFILE;
  return [
    ...coreChecks(coreProbes),
    ...bindingChecks({ factoryRoot }),
    ...harnessChecks(["claude", "codex"]),
    ...(profile !== undefined && profile !== "" ? [awsCredentialsCheck()] : []),
  ];
}

// Strictly larger than the sum of the MCP check's three phase budgets
// (connect, listTools, callTool), so a slow server is diagnosed by the phase
// that timed out rather than pre-empted by the outer race into a generic
// "did not answer".
export const JIT_TIMEOUT_MS = 3 * CHECK_TIMEOUT_MS + 5_000;

// Everything a step can only learn at hydration, once the body has built its
// harness config (ADR 0010's backstop half).
export function jitChecks(wire: AgentWire): Check[] {
  const harness = wire.harness;
  return [
    ...(harness.kind === "codex" ? [codexWorktreeConfigCheck(wire.cwd)] : []),
    ...mcpServerChecks(harness.mcpServers ?? {}, wire.cwd),
  ];
}
