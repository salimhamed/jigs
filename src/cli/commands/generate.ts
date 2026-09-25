import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";

// What releases before the generated jigs/ directory wrote into a factory.
// `jigs upgrade` runs this command under the new release, so the move happens
// here rather than in the upgrading CLI, which is still the old one.
const RETIRED_FILE = "jigs.ts";
const RETIRED_IMPORTS = ["#jigs", "#blocks/*", "#steps/*"];
const IMPORTS: Record<string, string> = { "#jigs/*": "./jigs/*.ts" };

export async function generateIntegration(deps: {
  cwd: string;
  out: (line: string) => void;
}): Promise<void> {
  const root = locateFactoryRoot(deps.cwd);
  const resolve = createRequire(path.join(root, "package.json"));
  let entry: string;
  try {
    entry = resolve.resolve("@jigs-ai/jigs/build");
  } catch {
    throw new JigsError(`@jigs-ai/jigs is not installed in ${root}`, "run pnpm install first");
  }
  const { generateFactoryIntegration } = await import(pathToFileURL(entry).href);
  generateFactoryIntegration(root);
  deps.out("generated jigs/steps.ts and jigs/routines.ts — review and commit them");
  migrateRetiredLayout(root, deps.out);
}

/** Remove what an earlier release generated and point the imports map at jigs/. */
export function migrateRetiredLayout(root: string, out: (line: string) => void): void {
  const retired = path.join(root, RETIRED_FILE);
  if (existsSync(retired)) {
    rmSync(retired);
    out(`deleted ${RETIRED_FILE}; its steps now live in jigs/steps.ts`);
  }

  const manifestFile = path.join(root, "package.json");
  const source = readFileSync(manifestFile, "utf8");
  const manifest = JSON.parse(source) as { imports?: Record<string, string> };
  const imports = { ...manifest.imports };
  const removed = RETIRED_IMPORTS.filter((key) => Object.hasOwn(imports, key));
  for (const key of removed) delete imports[key];
  const added = Object.keys(IMPORTS).filter((key) => !Object.hasOwn(imports, key));
  for (const key of added) imports[key] = IMPORTS[key] as string;
  if (removed.length === 0 && added.length === 0) return;
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, imports }, null, 2)}\n`);
  for (const key of removed) out(`removed ${key} from package.json imports`);
  for (const key of added) out(`added ${key} → ${IMPORTS[key]} to package.json imports`);
}
