import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JigsError } from "../errors.ts";

const PACKAGE_NAME = "@salimhamed/jigs";

function packageDirAbove(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
      };
      if (name === PACKAGE_NAME) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// The templates `jigs init` writes and the prompt markdown the agent step
// renders both ship inside this package, so both need its root at run time.
// Walked up from this module rather than fixed relative to it, so the same
// code holds from src/ under vitest and from whichever dist/ chunk the bundler
// put it in. The manifest's name is checked because of the third case: `jigs
// build` inlines this module into the factory's own server bundle, where the
// first package.json above it is Nitro's and the second is the factory's.
export function packageRoot(): string {
  const here = packageDirAbove(path.dirname(fileURLToPath(import.meta.url)));
  if (here !== undefined) return here;
  try {
    const entry = createRequire(import.meta.url).resolve(PACKAGE_NAME);
    const installed = packageDirAbove(path.dirname(entry));
    if (installed !== undefined) return installed;
  } catch {
    // Falls through to the error below, which says more than the resolution
    // failure does.
  }
  throw new JigsError(
    "could not find the jigs package root",
    "jigs is installed in a way that lost its package.json",
  );
}
