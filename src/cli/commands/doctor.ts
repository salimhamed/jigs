import type { CheckReport } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";

// An HTTP client of the service, deliberately not a local run of the catalog:
// the checks must execute in the environment steps run in, and the interactive
// shell's env is not the service process's.

export async function runDoctor(deps: ServiceDeps): Promise<CheckReport> {
  const res = await serviceFetch(deps.serviceUrl, "/api/doctor");
  if (!res.ok) {
    throw new JigsError(`doctor failed: HTTP ${res.status} ${await res.text()}`);
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
    throw new JigsError(`doctor found ${failures} problem(s)`);
  }
  return report;
}
