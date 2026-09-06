import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { CliError } from "../errors.ts";
import {
  type ExecFile,
  execOrExplain,
  execOutput,
  nodeExecFile,
} from "../exec.ts";
import { type Step, StepFailed, stepRunner } from "./step-runner.ts";
import {
  type UpDeps,
  type UpOptions,
  type UpResult,
  type UpStepName,
  upFactory,
} from "./up.ts";

// Moves a factory to a newer jigs: bump the published package, then every step
// of `jigs up` (the install, rebuild and restart are the upgrade's), then the
// factory's own typecheck. The typecheck comes last because it runs over the
// entry the build generated, and because it is the only step that can see what
// a release asks of the factory's own code: a wrapper in steps/jigs.ts for
// each step the release added.

export const JIGS_PACKAGE = "@salimhamed/jigs";

// What a factory scaffolded before jigs was published depends on: the
// checkout's packages, by their pre-publish names, linked by path.
const CHECKOUT_PACKAGES = ["jigs", "@jigs/service"];

// The second published package, until jigs became one. A factory still
// listing it cannot be upgraded into place: every import it holds names a
// package no release has.
const RETIRED_PACKAGE = "@salimhamed/jigs-service";

export type UpgradeStepName = "packages" | "bump" | "typecheck";

export type UpgradeStep = Step<UpgradeStepName | UpStepName>;

export interface UpgradeResult {
  ok: boolean;
  steps: UpgradeStep[];
  factoryRoot?: string;
  before?: string;
  after?: string;
  up?: UpResult;
}

export type UpgradeDeps = UpDeps;

export interface UpgradeOptions extends Pick<UpOptions, "force" | "doctor"> {
  to?: string;
}

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export async function upgradeFactory(
  deps: UpgradeDeps,
  options: UpgradeOptions = {},
): Promise<UpgradeResult> {
  if (options.to !== undefined && !VERSION.test(options.to)) {
    throw new CliError(
      `--to takes an exact version, got ${options.to}`,
      "e.g. --to 0.3.0",
    );
  }
  const execFile = deps.execFile ?? nodeExecFile;
  const runner = stepRunner<UpgradeStepName | UpStepName>(deps.out);
  const result: UpgradeResult = { ok: false, steps: runner.steps };

  try {
    const { factoryRoot, before } = await runner.run("packages", (note) => {
      const factoryRoot = locateFactoryRoot(deps.cwd);
      const before = publishedVersion(factoryRoot);
      note(`jigs ${before}`);
      return { factoryRoot, before };
    });
    result.factoryRoot = factoryRoot;
    result.before = before;

    const after = await runner.run("bump", async (note) => {
      await bump(execFile, factoryRoot, options.to, deps.out);
      const after = publishedVersion(factoryRoot);
      note(
        before === after
          ? `jigs ${after} (unchanged)`
          : `jigs ${before} → ${after}`,
      );
      return after;
    });
    result.after = after;

    const up = await upFactory(
      { ...deps, cwd: factoryRoot, execFile },
      { force: options.force, doctor: options.doctor },
    );
    result.up = up;
    runner.steps.push(...up.steps);
    if (!up.ok) return result;

    if (readManifest(factoryRoot).scripts?.typecheck === undefined) {
      runner.skip("typecheck", "no typecheck script in package.json");
    } else {
      await runner.run("typecheck", () =>
        typecheck(execFile, factoryRoot, deps.out),
      );
    }

    deps.out(`${path.basename(factoryRoot)} runs jigs ${after}`);
    result.ok = true;
    return result;
  } catch (err) {
    if (err instanceof StepFailed) return result;
    throw err;
  }
}

function readManifest(factoryRoot: string): Manifest {
  const file = path.join(factoryRoot, "package.json");
  if (!existsSync(file)) {
    throw new CliError(
      `no package.json in ${factoryRoot}`,
      "scaffold one: jigs init",
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

// Refuses a factory still wired to a checkout before pnpm can touch it: the
// published name would simply be added beside the linked one, and the factory
// would compile against one jigs and run another. And refuses one still
// listing the retired second package, which pnpm cannot resolve at any
// version — that factory needs its imports rewritten first, once, by hand.
function publishedVersion(factoryRoot: string): string {
  const manifest = readManifest(factoryRoot);
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };
  const fromCheckout = Object.entries(declared)
    .filter(
      ([name, spec]) =>
        CHECKOUT_PACKAGES.includes(name) ||
        (name === JIGS_PACKAGE && spec.startsWith("link:")),
    )
    .map(([name, spec]) => `${name}: ${spec}`);
  if (fromCheckout.length > 0) {
    throw new CliError(
      `this factory installs jigs from a checkout (${fromCheckout.join(", ")})`,
      `switch it to the published package first — ${JIGS_PACKAGE} from GitHub Packages, pinned to a version — then jigs upgrade`,
    );
  }
  if (declared[RETIRED_PACKAGE] !== undefined) {
    throw new CliError(
      `this factory still depends on ${RETIRED_PACKAGE}, which no longer releases`,
      `jigs is one package now, and the move is a one-time edit no upgrade can make for you: drop the ${RETIRED_PACKAGE} line from package.json, rewrite every import of ${RETIRED_PACKAGE}/X to ${JIGS_PACKAGE}/X, then jigs upgrade`,
    );
  }
  const version = declared[JIGS_PACKAGE];
  if (version === undefined) {
    throw new CliError(
      `${JIGS_PACKAGE} not in this factory's package.json`,
      "a factory depends on it by version — scaffold one with jigs init to see the shape",
    );
  }
  return version;
}

// `pnpm update` keeps the pin style package.json already has, so a factory
// pinned exactly stays pinned exactly; `--latest` is what lets it leave the
// range. An undeclared name is silently a no-op for pnpm, which is why the
// manifest was checked first.
async function bump(
  execFile: ExecFile,
  factoryRoot: string,
  to: string | undefined,
  out: (line: string) => void,
): Promise<void> {
  const args =
    to === undefined
      ? ["update", "--latest", JIGS_PACKAGE]
      : ["update", `${JIGS_PACKAGE}@${to}`];
  await execOrExplain(execFile, "pnpm", args, { cwd: factoryRoot }, out, {
    missing: new CliError(
      "pnpm is not on PATH",
      "install pnpm: https://pnpm.io/installation",
    ),
    failed: (err) => {
      const output = execOutput(err);
      if (/ERR_PNPM_PEER_DEP_ISSUES/.test(output)) {
        return new CliError(
          "the new jigs peers on a runtime version this factory does not install",
          "the factory supplies @workflow/web, @workflow/world-postgres, workflow and zod — move each to the version pnpm names above, then jigs upgrade again",
        );
      }
      if (/registry\.npmjs\.org\/@salimhamed%2F/.test(output)) {
        return new CliError(
          "the @salimhamed scope is not routed to GitHub Packages, so pnpm asked npmjs.org",
          "add @salimhamed:registry=https://npm.pkg.github.com to this factory's .npmrc or ~/.npmrc",
        );
      }
      // GitHub Packages answers 404, not 401, for a private package the token
      // cannot see; a version that does not exist is NO_MATCHING_VERSION.
      if (/ERR_PNPM_FETCH_40[134]|E40[134]\b/.test(output)) {
        return new CliError(
          "GitHub Packages refused the request",
          "~/.npmrc needs //npm.pkg.github.com/:_authToken=<classic PAT with read:packages, and repo while the jigs repo is private>",
        );
      }
      if (/ERR_PNPM_NO_MATCHING_VERSION/.test(output)) {
        return new CliError(
          `no such release of ${JIGS_PACKAGE}${to === undefined ? "" : ` at ${to}`}`,
          "pick a version the registry has",
        );
      }
      return new CliError(
        `pnpm update failed in ${factoryRoot}`,
        "the output above is pnpm's",
      );
    },
  });
}

async function typecheck(
  execFile: ExecFile,
  factoryRoot: string,
  out: (line: string) => void,
): Promise<void> {
  await execOrExplain(
    execFile,
    "pnpm",
    ["run", "typecheck"],
    { cwd: factoryRoot },
    out,
    {
      missing: new CliError(
        "pnpm is not on PATH",
        "install pnpm: https://pnpm.io/installation",
      ),
      failed: () =>
        new CliError(
          `typecheck failed in ${factoryRoot}`,
          "a release that adds a step needs its wrapper in steps/jigs.ts — an error on a jig's deps object names the one missing",
        ),
    },
  );
}
