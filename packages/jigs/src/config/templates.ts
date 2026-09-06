import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.ts";

// Every template file is stored as `<destination name>.tmpl` so nothing in
// there is a live file of this repo — an example pipeline named `.ts` would be
// compiled into a factory's own service bundle.
export const TEMPLATE_SUFFIX = ".tmpl";

// Walked up from this module rather than fixed relative to it, so the same
// code holds from src/ under vitest and from whichever dist/ chunk the
// bundler put it in.
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new CliError(
        "could not find the jigs package root",
        "jigs is installed in a way that lost its package.json",
      );
    }
    dir = parent;
  }
  return dir;
}

// `jigs init` runs before the factory has installed anything, so the templates
// ship inside the package the CLI is reached from.
export function locateTemplates(): string {
  const templates = path.join(packageRoot(), "templates");
  if (!existsSync(templates)) {
    throw new CliError(
      `could not find the factory templates (${templates})`,
      "the installed jigs package is missing its templates/ directory",
    );
  }
  return templates;
}
