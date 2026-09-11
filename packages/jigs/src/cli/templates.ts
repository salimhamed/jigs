import { existsSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "../config/package-root.ts";
import { JigsError } from "../errors.ts";

// Every template file is stored as `<destination name>.tmpl` so nothing in
// there is a live file of this repo — an example pipeline named `.ts` would be
// compiled into a factory's own service bundle.
export const TEMPLATE_SUFFIX = ".tmpl";

export { packageRoot };

// `jigs init` runs before the factory has installed anything, so the templates
// ship inside the package the CLI is reached from.
export function locateTemplates(): string {
  const templates = path.join(packageRoot(), "templates");
  if (!existsSync(templates)) {
    throw new JigsError(
      `could not find the factory templates (${templates})`,
      "the installed jigs package is missing its templates/ directory",
    );
  }
  return templates;
}
