import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { locateFactoryRoot } from "../config/factory-root.ts";
import { JigsError } from "../errors.ts";
import {
  type ExecFile,
  type ExecOutput,
  execOutput,
  nodeExecFile,
} from "../exec.ts";
import { SERVICE_ENTRY } from "./service-lifecycle.ts";

// Compiles a factory repo's own pipelines into its own service bundle. Both
// halves of the work belong to the factory, not to this CLI: the generated
// entry comes from the @salimhamed/jigs the factory installed, and the
// compiler is the nitro the factory installed.

export type Prepare = (factoryRoot: string) => unknown;

export interface BuildDeps {
  cwd: string;
  out: (line: string) => void;
  execFile?: ExecFile;
  prepare?: Prepare;
}

export async function buildFactoryService(deps: BuildDeps): Promise<void> {
  const factoryRoot = locateFactoryRoot(deps.cwd);

  const prepare = deps.prepare ?? (await loadPrepare(factoryRoot));
  await prepare(factoryRoot);

  // The factory's OWN nitro, never this repo's: the copies of the SDK that
  // compile the pipelines and that run them have to be the same copy, or the
  // step ids in the manifest are not the ones the service registers.
  const nitro = path.join(factoryRoot, "node_modules", ".bin", "nitro");
  if (!existsSync(nitro)) {
    throw new JigsError(
      `no nitro in ${factoryRoot}`,
      `install this factory's dependencies first: pnpm install in ${factoryRoot}`,
    );
  }

  const execFile = deps.execFile ?? nodeExecFile;
  try {
    echo(await execFile(nitro, ["build"], { cwd: factoryRoot }), deps.out);
  } catch (err) {
    echo(err as Partial<ExecOutput>, deps.out);
    throw new JigsError(
      `nitro build failed in ${factoryRoot}`,
      "the output above is nitro's",
    );
  }
  deps.out(`built ${path.join(factoryRoot, SERVICE_ENTRY)}`);
}

function echo(result: Partial<ExecOutput>, out: (line: string) => void): void {
  for (const line of execOutput(result).split("\n")) {
    if (line !== "") out(line);
  }
}

/**
 * The generated entry comes from the factory's own @salimhamed/jigs, reached
 * through two deliberate indirections:
 *
 * - dynamically, because `dist/cli.js` is a bundled artifact: a static import
 *   would inline this repo's copy of `prepare` into the CLI;
 * - resolved from the factory root, so the copy of the SDK that compiles the
 *   pipelines is the copy the built service will run.
 */
async function loadPrepare(factoryRoot: string): Promise<Prepare> {
  const resolveFromFactory = createRequire(
    path.join(factoryRoot, "package.json"),
  );
  let entry: string;
  try {
    entry = resolveFromFactory.resolve("@salimhamed/jigs/build");
  } catch {
    throw new JigsError(
      `@salimhamed/jigs is not installed in ${factoryRoot}`,
      `run pnpm install in ${factoryRoot}`,
    );
  }
  const module = (await import(pathToFileURL(entry).href)) as {
    prepare: Prepare;
  };
  return module.prepare;
}
