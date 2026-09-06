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

// Moves a factory to a newer jigs: bump both published packages, then every
// step of `jigs up` (the install, rebuild and restart are the upgrade's), then
// the factory's own typecheck. The typecheck comes last because it runs over
// the entry the build generated, and because it is the only step that can see
// what a release asks of the factory's own code: a wrapper in steps/jigs.ts
// for each step the release added.

export const JIGS_PACKAGES = [
  "@salimhamed/jigs",
  "@salimhamed/jigs-service",
] as const;

// What a factory scaffolded before jigs was published depends on: the
// checkout's packages, by their pre-publish names, linked by path.
const CHECKOUT_PACKAGES = ["jigs", "@jigs/service"];

export type UpgradeStepName = "packages" | "bump" | "typecheck";

export type UpgradeStep = Step<UpgradeStepName | UpStepName>;

export type Versions = Record<(typeof JIGS_PACKAGES)[number], string>;

export interface UpgradeResult {
  ok: boolean;
  steps: UpgradeStep[];
  factoryRoot?: string;
  before?: Versions;
  after?: Versions;
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
      "e.g. --to 0.2.0 — both packages release together, so one version pins both",
    );
  }
  const execFile = deps.execFile ?? nodeExecFile;
  const runner = stepRunner<UpgradeStepName | UpStepName>(deps.out);
  const result: UpgradeResult = { ok: false, steps: runner.steps };

  try {
    const { factoryRoot, before } = await runner.run("packages", (note) => {
      const factoryRoot = locateFactoryRoot(deps.cwd);
      const before = publishedVersions(factoryRoot);
      note(describeVersions(before));
      return { factoryRoot, before };
    });
    result.factoryRoot = factoryRoot;
    result.before = before;

    const after = await runner.run("bump", async (note) => {
      await bump(execFile, factoryRoot, options.to, deps.out);
      const after = publishedVersions(factoryRoot);
      note(describeBump(before, after));
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

    deps.out(
      `${path.basename(factoryRoot)} runs jigs ${after["@salimhamed/jigs"]}`,
    );
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
// two published names would simply be added beside the linked ones, and the
// factory would compile against one jigs and run another.
function publishedVersions(factoryRoot: string): Versions {
  const manifest = readManifest(factoryRoot);
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };
  const fromCheckout = Object.entries(declared)
    .filter(
      ([name, spec]) =>
        CHECKOUT_PACKAGES.includes(name) || spec.startsWith("link:"),
    )
    .map(([name, spec]) => `${name}: ${spec}`);
  if (fromCheckout.length > 0) {
    throw new CliError(
      `this factory installs jigs from a checkout (${fromCheckout.join(", ")})`,
      `switch it to the published packages first — ${JIGS_PACKAGES.join(" and ")} from GitHub Packages, pinned to one version — then jigs upgrade`,
    );
  }
  const missing = JIGS_PACKAGES.filter((name) => declared[name] === undefined);
  if (missing.length > 0) {
    throw new CliError(
      `${missing.join(" and ")} not in this factory's package.json`,
      `a factory depends on both ${JIGS_PACKAGES.join(" and ")}, pinned to one version`,
    );
  }
  return {
    "@salimhamed/jigs": declared["@salimhamed/jigs"] as string,
    "@salimhamed/jigs-service": declared["@salimhamed/jigs-service"] as string,
  };
}

const short = (name: string) => name.slice("@salimhamed/".length);

function describeVersions(versions: Versions): string {
  return JIGS_PACKAGES.map((name) => `${short(name)} ${versions[name]}`).join(
    ", ",
  );
}

function describeBump(before: Versions, after: Versions): string {
  return JIGS_PACKAGES.map((name) =>
    before[name] === after[name]
      ? `${short(name)} ${after[name]} (unchanged)`
      : `${short(name)} ${before[name]} → ${after[name]}`,
  ).join(", ");
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
      ? ["update", "--latest", ...JIGS_PACKAGES]
      : ["update", ...JIGS_PACKAGES.map((name) => `${name}@${to}`)];
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
      if (/ERR_PNPM_FETCH_40[13]|E40[13]\b/.test(output)) {
        return new CliError(
          "GitHub Packages refused the request",
          "~/.npmrc needs a token with read:packages for the @salimhamed scope",
        );
      }
      if (
        /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH_404|E404\b/.test(output)
      ) {
        return new CliError(
          `no such release of ${JIGS_PACKAGES.join(" and ")}${to === undefined ? "" : ` at ${to}`}`,
          "both packages release together — pick a version both have",
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
