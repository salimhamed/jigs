// Trigger-path preflight (ADR 0010): the checks run here, in the process the
// steps themselves execute in, and every failure is reported at once. There
// is no skip flag — a wrong block is a bug to fix, not a flag to add.

import { locateFactoryRoot } from "jigs";
import {
  type CheckReport,
  type CoreProbes,
  doctorChecks,
  type PipelineRequires,
  preflightChecks,
  runChecks,
} from "jigs/checks";
import { getAuthenticatedUser } from "./providers/github";
import { getViewer } from "./providers/linear";

export function factoryRoot(): string {
  const override = process.env.JIGS_FACTORY_ROOT;
  if (override !== undefined && override !== "") return override;
  return locateFactoryRoot(process.cwd());
}

const probes: CoreProbes = {
  linearViewer: getViewer,
  githubWhoami: getAuthenticatedUser,
};

export function preflight(requires: PipelineRequires): Promise<CheckReport> {
  return runChecks(preflightChecks({ factoryRoot, requires, probes }));
}

export function doctor(): Promise<CheckReport> {
  return runChecks(doctorChecks({ factoryRoot, probes }));
}
