import type { CheckOutcome, CheckReport } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import { hintLines, indent, note, tone } from "../output.ts";
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
  if (report.checks.length === 0) deps.out("nothing to check");
  for (const line of report.checks.flatMap(checkLines)) deps.out(line);
  const failures = report.checks.filter((check) => !check.ok).length;
  if (failures > 0) {
    throw new JigsError(`doctor found ${failures} problem(s)`);
  }
  return report;
}

/** One check as doctor and preflight print it: its outcome, then any detail or repair beneath. */
export function checkLines(check: CheckOutcome): string[] {
  if (!check.ok) {
    return [`${tone("FAIL")} ${check.label}: ${check.reason}`, ...indent(hintLines(check.repair))];
  }
  const [first, ...rest] = check.detail?.split("\n") ?? [];
  return [
    `${tone("ok")}   ${check.label}${first === undefined ? "" : note(`: ${first}`)}`,
    ...indent(rest.map((line) => note(line))),
  ];
}
