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

// The live root and the live provider clients, so a caller states only what
// is theirs to state — the pipeline's requirements. Both stay overridable:
// the catalog's own tests drive it without a factory on disk or a network.
const coreProbes: CoreProbes = {
  linearViewer: getViewer,
  githubWhoami: getAuthenticatedUser,
};

export interface PreflightChecksOptions {
  requires: PipelineRequires;
  factoryRoot?: () => string;
  probes?: CoreProbes;
}

export function preflightChecks(options: PreflightChecksOptions): Check[] {
  return [
    ...coreChecks(options.probes ?? coreProbes),
    ...bindingChecks({
      factoryRoot: options.factoryRoot ?? factoryRoot,
      names: options.requires.bindings ?? [],
    }),
    ...harnessChecks(options.requires.harnesses ?? []),
    ...(options.requires.aws ? [awsCredentialsCheck()] : []),
  ];
}

export interface DoctorChecksOptions {
  factoryRoot?: () => string;
  probes?: CoreProbes;
}

// No pipeline, so no manifest: doctor takes every declared binding and both
// harnesses. MCP is absent on purpose — it is JIT-only (ADR 0011). AWS is
// conditional for the same reason: with no manifest to read, a set
// AWS_PROFILE is the only evidence this factory uses AWS at all.
export function doctorChecks(options: DoctorChecksOptions = {}): Check[] {
  const profile = process.env.AWS_PROFILE;
  return [
    ...coreChecks(options.probes ?? coreProbes),
    ...bindingChecks({ factoryRoot: options.factoryRoot ?? factoryRoot }),
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
