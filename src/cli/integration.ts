import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../errors.ts";
import { locateTemplates } from "./templates.ts";

function integrationSource(): string {
  return readFileSync(path.join(locateTemplates(), "jigs.ts.tmpl"), "utf8");
}

/** Refresh only the generated integration; custom factory code lives elsewhere. */
export function generateFactoryIntegration(factoryRoot: string): string {
  const file = path.join(factoryRoot, "jigs.ts");
  writeFileSync(file, integrationSource());
  return file;
}

/** A build never rewrites committed source. */
export function checkFactoryIntegration(factoryRoot: string): void {
  const file = path.join(factoryRoot, "jigs.ts");
  if (!existsSync(file) || readFileSync(file, "utf8") !== integrationSource()) {
    throw new JigsError(
      "jigs.ts is missing or differs from the installed jigs integration",
      "run pnpm exec jigs generate, then review and commit jigs.ts; keep custom code in steps/ or blocks/",
    );
  }
}
