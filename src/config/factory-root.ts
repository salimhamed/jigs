import { existsSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../errors.ts";
import { FACTORY_CONFIG_FILE } from "../workflow/factory-schema.ts";

export function locateFactoryRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(dir, FACTORY_CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new JigsError(
        `not inside a factory repo (no ${FACTORY_CONFIG_FILE} found from ${cwd} upward)`,
        "cd into your factory repo, or create one: `git init && pnpm exec jigs init`",
      );
    }
    dir = parent;
  }
}
