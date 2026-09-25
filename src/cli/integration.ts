import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../errors.ts";
import { locateTemplates } from "./templates.ts";

/** The files `jigs generate` owns, relative to the factory root. */
export const GENERATED_FILES = ["jigs/steps.ts", "jigs/routines.ts"] as const;

// Written by releases before the generated directory; its wrappers would
// register a second copy of every step.
const RETIRED_FILE = "jigs.ts";

function generatedSource(file: string): string {
  return readFileSync(path.join(locateTemplates(), `${file}.tmpl`), "utf8");
}

/** Refresh only the generated files; custom factory code lives elsewhere. */
export function generateFactoryIntegration(factoryRoot: string): string[] {
  mkdirSync(path.join(factoryRoot, "jigs"), { recursive: true });
  return GENERATED_FILES.map((file) => {
    const target = path.join(factoryRoot, file);
    writeFileSync(target, generatedSource(file));
    return target;
  });
}

/** A build never rewrites committed source. */
export function checkFactoryIntegration(factoryRoot: string): void {
  if (existsSync(path.join(factoryRoot, RETIRED_FILE))) {
    throw new JigsError(
      `${RETIRED_FILE} is no longer generated; its steps now live in jigs/steps.ts`,
      `delete ${RETIRED_FILE}, run pnpm exec jigs generate, and import from #jigs/steps and #jigs/routines`,
    );
  }
  const stale = GENERATED_FILES.filter((file) => {
    const target = path.join(factoryRoot, file);
    return !existsSync(target) || readFileSync(target, "utf8") !== generatedSource(file);
  });
  if (stale.length > 0) {
    throw new JigsError(
      `jigs/ is missing or differs from the installed jigs: ${stale.join(", ")}`,
      "run pnpm exec jigs generate, then review and commit jigs/; keep custom steps beside the workflow that uses them",
    );
  }
}
