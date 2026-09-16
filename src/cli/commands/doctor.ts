import type { CheckReport } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import { type ServiceDeps, serviceFetch } from "./service-client.ts";
import { type SystemdUserManager, systemdUserManager } from "./systemd-user.ts";

// An HTTP client of the service, deliberately not a local run of the catalog:
// the checks must execute in the environment steps run in, and the interactive
// shell's env is not the service process's.

export async function runDoctor(
  deps: ServiceDeps & { systemd?: SystemdUserManager },
): Promise<CheckReport> {
  const systemd = deps.systemd ?? systemdUserManager;
  const available = systemd.available();
  const linger = available ? systemd.linger() : undefined;
  if (!available) {
    deps.out(
      "WARN service supervision: systemd-run --user is unavailable; the service is unsupervised and dies on logout",
    );
  } else if (linger === false) {
    deps.out("WARN systemd linger is off; the service may die when the last login session ends");
    deps.out("  → loginctl enable-linger $USER");
  } else if (linger === undefined) {
    deps.out("WARN systemd linger state could not be determined with loginctl");
  } else {
    deps.out("ok   systemd user service supervision");
  }
  const res = await serviceFetch(deps.serviceUrl, "/api/doctor");
  if (!res.ok) {
    throw new JigsError(`doctor failed: HTTP ${res.status} ${await res.text()}`);
  }
  const report = (await res.json()) as CheckReport;

  let failures = 0;
  for (const check of report.checks) {
    if (check.ok) {
      deps.out(`ok   ${check.label}${check.detail === undefined ? "" : `: ${check.detail}`}`);
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
