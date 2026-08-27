import type { AgentWire } from "../steps/plan.ts";
import {
  bindingChecks,
  factoryConfigFailure,
  readBindings,
} from "./bindings.ts";
import type { Check } from "./catalog.ts";
import { type CoreProbes, coreChecks } from "./core.ts";
import { type HarnessKind, harnessChecks } from "./harnesses.ts";
import { codexWorktreeConfigCheck, mcpServerChecks } from "./mcp.ts";

export {
  type BindingChecksOptions,
  bindingChecks,
  factoryConfigFailure,
  readBindings,
} from "./bindings.ts";
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
}

export interface PreflightChecksOptions {
  factoryRoot: () => string;
  requires: PipelineRequires;
  probes: CoreProbes;
}

export function preflightChecks(options: PreflightChecksOptions): Check[] {
  return [
    ...coreChecks(options.probes),
    ...bindingChecks({
      factoryRoot: options.factoryRoot,
      names: options.requires.bindings ?? [],
    }),
    ...harnessChecks(options.requires.harnesses ?? []),
  ];
}

export interface DoctorChecksOptions {
  factoryRoot: () => string;
  probes: CoreProbes;
}

// No pipeline, so no manifest: doctor takes every declared binding and both
// harnesses. MCP is absent on purpose — it is JIT-only (ADR 0011).
export function doctorChecks(options: DoctorChecksOptions): Check[] {
  let bindings: Check[];
  try {
    bindings = bindingChecks({
      factoryRoot: options.factoryRoot,
      names: Object.keys(readBindings(options.factoryRoot)),
    });
  } catch (err) {
    // Unlike preflight, doctor has no manifest to excuse an unreadable
    // config — the operator asked what is wrong, so say it.
    bindings = [factoryConfigFailure(err)];
  }
  return [
    ...coreChecks(options.probes),
    ...bindings,
    ...harnessChecks(["claude", "codex"]),
  ];
}

// Everything a step can only learn at hydration, once the body has built its
// harness config (ADR 0010's backstop half).
export function jitChecks(wire: AgentWire): Check[] {
  const harness = wire.harness;
  return [
    ...(harness.kind === "codex" ? [codexWorktreeConfigCheck(wire.cwd)] : []),
    ...mcpServerChecks(harness.mcpServers ?? {}),
  ];
}
