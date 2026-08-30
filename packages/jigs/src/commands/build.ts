import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { missingWrappers, STEPS_FILE } from "../config/steps-scaffold.ts";
import { locateTemplates, TEMPLATE_SUFFIX } from "../config/templates.ts";
import { CliError } from "../errors.ts";
import { listRunsForPs } from "./ps.ts";
import { resolveServiceTarget } from "./service.ts";
import { SERVICE_ENTRY } from "./service-lifecycle.ts";

// Compiles a factory repo's own pipelines into its own service bundle. Both
// halves of the work belong to the factory, not to this CLI: the generated
// entry comes from the @jigs/service the factory installed, and the compiler
// is the nitro the factory installed.

// Mirrors TERMINAL_RUN_STATUSES in @jigs/service — the CLI reads run status
// off the wire and has nothing to import it from.
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export type Prepare = (factoryRoot: string) => unknown;

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<ExecOutput>;

export interface BuildDeps {
  cwd: string;
  out: (line: string) => void;
  execFile?: ExecFile;
  prepare?: Prepare;
}

export async function buildFactoryService(deps: BuildDeps): Promise<void> {
  const factoryRoot = locateFactoryRoot(deps.cwd);
  await warnAboutRunsInFlight(factoryRoot, deps.out);
  warnAboutMissingWrappers(factoryRoot, deps.out);

  const prepare = deps.prepare ?? (await loadPrepare(factoryRoot));
  await prepare(factoryRoot);

  // The factory's OWN nitro, never this repo's: the copies of the SDK that
  // compile the pipelines and that run them have to be the same copy, or the
  // step ids in the manifest are not the ones the service registers.
  const nitro = path.join(factoryRoot, "node_modules", ".bin", "nitro");
  if (!existsSync(nitro)) {
    throw new CliError(
      `no nitro in ${factoryRoot}`,
      `install this factory's dependencies first: pnpm install in ${factoryRoot}`,
    );
  }

  const execFile = deps.execFile ?? nodeExecFile;
  try {
    echo(await execFile(nitro, ["build"], { cwd: factoryRoot }), deps.out);
  } catch (err) {
    echo(err as Partial<ExecOutput>, deps.out);
    throw new CliError(
      `nitro build failed in ${factoryRoot}`,
      "the output above is nitro's",
    );
  }
  deps.out(`built ${path.join(factoryRoot, SERVICE_ENTRY)}`);
}

function echo(result: Partial<ExecOutput>, out: (line: string) => void): void {
  for (const line of `${result.stdout ?? ""}${result.stderr ?? ""}`.split(
    "\n",
  )) {
    if (line !== "") out(line);
  }
}

// Rebuilding while a run is parked can orphan it: replay looks the step ids
// up by name, and a pipeline whose shape changed no longer answers to them.
// A warning, not a refusal — only the human knows whether the parked run
// still matters.
async function warnAboutRunsInFlight(
  factoryRoot: string,
  out: (line: string) => void,
): Promise<void> {
  let runs: Awaited<ReturnType<typeof listRunsForPs>>["runs"];
  try {
    // `jigs ps` already knows how to find them; it prints, so it is handed a
    // sink and read for its return value.
    ({ runs } = await listRunsForPs({
      ...resolveServiceTarget(factoryRoot),
      out: () => {},
    }));
  } catch {
    // An unreachable service is the ordinary case for a build — there is
    // nothing running to have runs in flight.
    return;
  }

  const inFlight = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  if (inFlight.length === 0) return;
  out(
    `warning: ${inFlight.length} run(s) still in flight — a rebuild can orphan one whose pipeline changed shape:`,
  );
  for (const run of inFlight) {
    out(`  ${run.runId}  ${run.pipeline}  ${run.status}`);
  }
  out("  jigs ps to look, jigs cancel <run> to release one");
}

// A step jigs exports with no wrapper in this factory is a step no pipeline
// here can call, and nothing else says so: the build is clean, the manifest is
// simply short. A warning rather than a refusal — the factory owns this file,
// and skipping a step it never uses is a legitimate choice.
function warnAboutMissingWrappers(
  factoryRoot: string,
  out: (line: string) => void,
): void {
  const stepsFile = path.join(factoryRoot, STEPS_FILE);
  if (!existsSync(stepsFile)) return;
  let missing: ReturnType<typeof missingWrappers>;
  try {
    missing = missingWrappers(
      readFileSync(
        path.join(locateTemplates(), `${STEPS_FILE}${TEMPLATE_SUFFIX}`),
        "utf8",
      ),
      readFileSync(stepsFile, "utf8"),
    );
  } catch {
    // No jigs checkout to read the scaffold from; the build itself does not
    // need one, so this check simply does not run.
    return;
  }
  if (missing.length === 0) return;
  out(
    `warning: ${STEPS_FILE} has no wrapper for ${missing.length} jigs step(s): ${missing
      .map((wrapper) => wrapper.name)
      .join(", ")}`,
  );
  out(`  jigs init in ${factoryRoot} offers to append them`);
}

/**
 * The generated entry comes from the factory's own @jigs/service, reached
 * through two deliberate indirections:
 *
 * - dynamically, because `dist/cli.js` is a bundled artifact and a static
 *   import would pull nitro and the whole build framework into the CLI;
 * - resolved from the factory root, so the copy of the SDK that compiles the
 *   pipelines is the copy the built service will run.
 */
async function loadPrepare(factoryRoot: string): Promise<Prepare> {
  const resolveFromFactory = createRequire(
    path.join(factoryRoot, "package.json"),
  );
  let entry: string;
  try {
    entry = resolveFromFactory.resolve("@jigs/service/build");
  } catch {
    throw new CliError(
      `@jigs/service is not installed in ${factoryRoot}`,
      `run pnpm install in ${factoryRoot}`,
    );
  }
  const module = (await import(pathToFileURL(entry).href)) as {
    prepare: Prepare;
  };
  return module.prepare;
}

const nodeExecFile: ExecFile = async (file, args, options) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return await promisify(execFile)(file, args, {
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
};
