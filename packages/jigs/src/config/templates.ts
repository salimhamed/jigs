import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.ts";

// Every template file is stored as `<destination name>.tmpl` so nothing in
// there is a live file of this repo — an example pipeline named `.ts` would be
// compiled into @jigs/service's own service bundle.
export const TEMPLATE_SUFFIX = ".tmpl";

const TEMPLATES_FROM_ROOT = path.join("packages", "service", "templates");

// The root is the directory holding the factory templates.
export function locateRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(dir, TEMPLATES_FROM_ROOT))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliError(
        `could not find the factory templates (${TEMPLATES_FROM_ROOT})`,
        `jigs must run from a jigs checkout to scaffold a factory`,
      );
    }
    dir = parent;
  }
}

// `jigs init` runs before the factory has installed anything, so
// @jigs/service cannot be resolved as a dependency — the templates are found
// on disk from this module instead.
export function locateTemplates(): string {
  return path.join(locateRepoRoot(), TEMPLATES_FROM_ROOT);
}
