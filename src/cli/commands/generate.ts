import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";

export async function generateIntegration(deps: {
  cwd: string;
  out: (line: string) => void;
}): Promise<void> {
  const root = locateFactoryRoot(deps.cwd);
  const resolve = createRequire(path.join(root, "package.json"));
  let entry: string;
  try {
    entry = resolve.resolve("@salimhamed/jigs/build");
  } catch {
    throw new JigsError(`@salimhamed/jigs is not installed in ${root}`, "run pnpm install first");
  }
  const { generateFactoryIntegration } = await import(pathToFileURL(entry).href);
  generateFactoryIntegration(root);
  deps.out("generated jigs.ts — review and commit this file");
}
