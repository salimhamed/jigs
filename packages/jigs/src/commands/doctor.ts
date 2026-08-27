import type { CheckReport } from "../checks/catalog.ts";
import { CliError } from "../errors.ts";
import { type ServiceDeps, serviceBase, serviceFetch } from "./service.ts";

// An HTTP client of the service (ADR 0008), deliberately not a local run of
// the catalog: the checks must execute in the environment steps run in, and
// the interactive shell's env is not the service unit's.

export type DoctorDeps = ServiceDeps;

export async function runDoctor(deps: DoctorDeps): Promise<CheckReport> {
  const base = serviceBase(deps.serviceUrl);
  const res = await serviceFetch(base, "/api/doctor");
  if (!res.ok) {
    throw new CliError(`doctor failed: HTTP ${res.status} ${await res.text()}`);
  }
  const report = (await res.json()) as CheckReport;

  let failures = 0;
  for (const check of report.checks) {
    if (check.ok) {
      deps.out(`ok   ${check.label}`);
      continue;
    }
    failures += 1;
    deps.out(`FAIL ${check.label}: ${check.reason}`);
    deps.out(`  → ${check.repair}`);
  }
  if (failures > 0) {
    throw new CliError(`doctor found ${failures} problem(s)`);
  }
  return report;
}
