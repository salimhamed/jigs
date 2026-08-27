import { CliError } from "../errors.ts";

// An HTTP client of the service (ADR 0008), deliberately not a local run of
// the catalog: the checks must execute in the environment steps run in, and
// the interactive shell's env is not the service unit's.

export interface DoctorDeps {
  out: (line: string) => void;
  serviceUrl: string;
}

export interface DoctorOutcome {
  id: string;
  label: string;
  ok: boolean;
  reason?: string;
  repair?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorOutcome[];
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const base = deps.serviceUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/doctor`);
  } catch {
    throw new CliError(
      `could not reach the jigs service at ${base}`,
      "is the jigs service running? pass --service or set JIGS_SERVICE_URL",
    );
  }
  if (!res.ok) {
    throw new CliError(`doctor failed: HTTP ${res.status} ${await res.text()}`);
  }
  const report = (await res.json()) as DoctorReport;

  let failures = 0;
  for (const check of report.checks) {
    if (check.ok) {
      deps.out(`ok   ${check.label}`);
      continue;
    }
    failures += 1;
    deps.out(`FAIL ${check.label}: ${check.reason ?? "failed"}`);
    if (check.repair !== undefined) deps.out(`  → ${check.repair}`);
  }
  if (failures > 0) {
    throw new CliError(`doctor found ${failures} problem(s)`);
  }
  return report;
}
