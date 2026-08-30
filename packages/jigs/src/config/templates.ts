import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.ts";

// Every template file is stored as `<destination name>.tmpl` so nothing in
// there is a live file of this repo — an example pipeline named `.ts` would be
// compiled into @jigs/service's own service bundle.
export const TEMPLATE_SUFFIX = ".tmpl";

const TEMPLATES_FROM_ROOT = path.join("packages", "service", "templates");

// `jigs init` runs before the factory has installed anything, so
// @jigs/service cannot be resolved as a dependency — the templates are found
// on disk from this module instead.
export function locateTemplates(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, TEMPLATES_FROM_ROOT);
    if (existsSync(candidate)) return candidate;
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
