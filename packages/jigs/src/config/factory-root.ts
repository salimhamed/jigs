import { existsSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../errors.ts";
import { FACTORY_CONFIG_FILE } from "./factory-config.ts";

export function locateFactoryRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(dir, FACTORY_CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new JigsError(
        `not inside a factory repo (no ${FACTORY_CONFIG_FILE} found from ${cwd} upward)`,
        `cd into your factory repo, or create one: git init && touch ${FACTORY_CONFIG_FILE}`,
      );
    }
    dir = parent;
  }
}

// What the running service means by "the factory": the CLI passes an explicit
// cwd, but the service is started by a supervisor from anywhere, so the
// override is how it is told which factory it answers for.
export function factoryRoot(): string {
  const override = process.env.JIGS_FACTORY_ROOT;
  if (override !== undefined && override !== "") return override;
  return locateFactoryRoot(process.cwd());
}
