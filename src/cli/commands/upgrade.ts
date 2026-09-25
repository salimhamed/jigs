import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument, Scalar } from "yaml";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import { type ExecFile, execOrExplain, execOutput, nodeExecFile } from "../exec.ts";
import { type Step, StepFailed, stepRunner } from "./step-runner.ts";
import type { UpOptions } from "./up.ts";

// Install the release, then run everything after the install under the newly
// installed CLI: this process holds the old release's integration template
// and build checks, which reject the jigs/ files the new release generated.

export const JIGS_PACKAGE = "@jigs-ai/jigs";

// What a factory scaffolded before jigs was published depends on: the
// checkout's packages, by their pre-publish names, linked by path.
const CHECKOUT_PACKAGES = ["jigs", "@jigs/service"];

// Names earlier releases were published under. A factory still listing one
// cannot be upgraded into place: every import it holds names a package no
// release has.
const RETIRED_PACKAGES = ["@salimhamed/jigs", "@salimhamed/jigs-service"];

export type UpgradeStepName = "packages" | "bump" | "generate" | "up" | "typecheck";

export type UpgradeStep = Step<UpgradeStepName>;

export interface UpgradeResult {
  ok: boolean;
  steps: UpgradeStep[];
  factoryRoot?: string;
  before?: string;
  after?: string;
}

export interface UpgradeDeps {
  cwd: string;
  out: (line: string) => void;
  execFile?: ExecFile;
}

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
    throw new JigsError(
      `--to-version takes an exact version, got ${options.to}`,
      "e.g. --to-version 0.3.0",
    );
  }
  const execFile = deps.execFile ?? nodeExecFile;
  const runner = stepRunner<UpgradeStepName>(deps.out);
  const result: UpgradeResult = { ok: false, steps: runner.steps };

  try {
    const { factoryRoot, before } = await runner.run("packages", (note) => {
      const factoryRoot = locateFactoryRoot(deps.cwd);
      const before = publishedVersion(factoryRoot);
      const normalized = normalizeReleaseAgeExclude(factoryRoot);
      note(normalized ? `jigs ${before}; normalized minimumReleaseAgeExclude` : `jigs ${before}`);
      return { factoryRoot, before };
    });
    result.factoryRoot = factoryRoot;
    result.before = before;

    const after = await runner.run("bump", async (note) => {
      await bump(execFile, factoryRoot, options.to, deps.out);
      const after = publishedVersion(factoryRoot);
      note(before === after ? `jigs ${after} (unchanged)` : `jigs ${before} → ${after}`);
      return after;
    });
    result.after = after;

    await runner.run("generate", () => generate(execFile, factoryRoot, deps.out));
    await runner.run("up", () => up(execFile, factoryRoot, options, deps.out));

    if (readManifest(factoryRoot).scripts?.typecheck === undefined) {
      runner.skip("typecheck", "no typecheck script in package.json");
    } else {
      await runner.run("typecheck", () => typecheck(execFile, factoryRoot, deps.out));
    }

    deps.out(`${path.basename(factoryRoot)} runs jigs ${after}`);
    result.ok = true;
    return result;
  } catch (err) {
    if (err instanceof StepFailed) return result;
    throw err;
  }
}

function normalizeReleaseAgeExclude(factoryRoot: string): boolean {
  const file = path.join(factoryRoot, "pnpm-workspace.yaml");
  const source = existsSync(file) ? readFileSync(file, "utf8") : "";
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new JigsError(
      `could not parse ${file}: ${document.errors[0]?.message}`,
      "fix pnpm-workspace.yaml, then run pnpm exec jigs upgrade again",
    );
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new JigsError(
      `${file} must contain a YAML mapping`,
      "make pnpm-workspace.yaml a top-level mapping, then run pnpm exec jigs upgrade again",
    );
  }
  const workspace = document.toJS() as { minimumReleaseAgeExclude?: unknown } | null;
  const existing = workspace?.minimumReleaseAgeExclude;
  if (existing != null && !Array.isArray(existing)) {
    throw new JigsError(
      `minimumReleaseAgeExclude in ${file} is not a list`,
      "make minimumReleaseAgeExclude a YAML list, then run pnpm exec jigs upgrade again",
    );
  }
  const jigsEntries = Array.isArray(existing)
    ? existing.filter(
        (entry) =>
          typeof entry === "string" &&
          (entry === JIGS_PACKAGE || entry.startsWith(`${JIGS_PACKAGE}@`)),
      )
    : [];
  if (jigsEntries.length === 1 && jigsEntries[0] === JIGS_PACKAGE) return false;
  const exclusions = document.get("minimumReleaseAgeExclude", true);
  if (exclusions === undefined || (isScalar(exclusions) && exclusions.value === null)) {
    const created = document.createNode<unknown[]>([]);
    if (isSeq(created)) created.add(quotedJigsPackage());
    document.set("minimumReleaseAgeExclude", created);
  } else if (isSeq(exclusions)) {
    let foundJigs = false;
    for (let index = 0; index < exclusions.items.length; ) {
      const item = exclusions.items[index];
      if (
        isScalar(item) &&
        typeof item.value === "string" &&
        (item.value === JIGS_PACKAGE || item.value.startsWith(`${JIGS_PACKAGE}@`))
      ) {
        if (foundJigs) {
          exclusions.items.splice(index, 1);
          continue;
        }
        item.value = JIGS_PACKAGE;
        item.type = Scalar.QUOTE_SINGLE;
        foundJigs = true;
      }
      index += 1;
    }
    if (!foundJigs) exclusions.add(quotedJigsPackage());
  }
  writeFileSync(file, String(document));
  return true;
}

function quotedJigsPackage(): Scalar<string> {
  const scalar = new Scalar(JIGS_PACKAGE);
  scalar.type = Scalar.QUOTE_SINGLE;
  return scalar;
}

function readManifest(factoryRoot: string): Manifest {
  const file = path.join(factoryRoot, "package.json");
  if (!existsSync(file)) {
    throw new JigsError(`no package.json in ${factoryRoot}`, "scaffold one: pnpm exec jigs init");
  }
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

// Refuses a factory still wired to a checkout before pnpm can touch it: the
// published name would simply be added beside the linked one, and the factory
// would compile against one jigs and run another. And refuses one still
// listing a retired name, which no release comes under — that factory needs
// its imports rewritten first, once, by hand.
function publishedVersion(factoryRoot: string): string {
  const manifest = readManifest(factoryRoot);
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };
  const fromCheckout = Object.entries(declared)
    .filter(
      ([name, spec]) =>
        CHECKOUT_PACKAGES.includes(name) || (name === JIGS_PACKAGE && spec.startsWith("link:")),
    )
    .map(([name, spec]) => `${name}: ${spec}`);
  if (fromCheckout.length > 0) {
    throw new JigsError(
      `this factory installs jigs from a checkout (${fromCheckout.join(", ")})`,
      `switch it to the published package first — ${JIGS_PACKAGE} from npm, pinned to a version — then pnpm exec jigs upgrade`,
    );
  }
  const retired = RETIRED_PACKAGES.find((name) => declared[name] !== undefined);
  if (retired !== undefined) {
    throw new JigsError(
      `this factory still depends on ${retired}, which no longer releases`,
      `the move is a one-time edit no upgrade can make for you: replace the ${retired} line in package.json with ${JIGS_PACKAGE} at a version, rewrite every import of ${retired}/X to ${JIGS_PACKAGE}/X, drop any @salimhamed:registry line from .npmrc, then pnpm exec jigs upgrade`,
    );
  }
  const version = declared[JIGS_PACKAGE];
  if (version === undefined) {
    throw new JigsError(
      `${JIGS_PACKAGE} not in this factory's package.json`,
      "a factory depends on it by version — scaffold one with pnpm exec jigs init to see the shape",
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
    to === undefined ? ["update", "--latest", JIGS_PACKAGE] : ["update", `${JIGS_PACKAGE}@${to}`];
  await execOrExplain(execFile, "pnpm", args, { cwd: factoryRoot }, out, {
    missing: new JigsError("pnpm is not on PATH", "install pnpm: https://pnpm.io/installation"),
    failed: (err) => {
      const output = execOutput(err);
      if (/ERR_PNPM_PEER_DEP_ISSUES/.test(output)) {
        return new JigsError(
          "the new jigs peers on a runtime version this factory does not install",
          "the factory supplies @workflow/web, @workflow/world-postgres, workflow and zod — move each to the version pnpm names above, then pnpm exec jigs upgrade again",
        );
      }
      if (/ERR_PNPM_NO_MATCHING_VERSION/.test(output)) {
        return new JigsError(
          `no such release of ${JIGS_PACKAGE}${to === undefined ? "" : ` at ${to}`}`,
          "pick a version the registry has",
        );
      }
      return new JigsError(`pnpm update failed in ${factoryRoot}`, "the output above is pnpm's");
    },
  });
}

async function generate(
  execFile: ExecFile,
  factoryRoot: string,
  out: (line: string) => void,
): Promise<void> {
  // The new release's generate also retires jigs.ts and the old imports map;
  // each line it prints names one change, so the operator sees them all.
  const onLine = (line: string) => out(`  ${line}`);
  await execOrExplain(
    execFile,
    "pnpm",
    ["exec", "jigs", "generate"],
    { cwd: factoryRoot, onLine },
    out,
    {
      missing: new JigsError("pnpm is not on PATH", "install pnpm"),
      failed: () =>
        new JigsError("could not refresh jigs/", "run pnpm exec jigs generate in this factory"),
    },
  );
}

// The child owns the terminal so its restart prompt and step lines reach the
// operator directly.
async function up(
  execFile: ExecFile,
  factoryRoot: string,
  options: UpgradeOptions,
  out: (line: string) => void,
): Promise<void> {
  const args = ["exec", "jigs", "up"];
  if (options.force === true) args.push("--force");
  if (options.doctor === false) args.push("--no-doctor");
  await execOrExplain(execFile, "pnpm", args, { cwd: factoryRoot, stdio: "inherit" }, out, {
    missing: new JigsError("pnpm is not on PATH", "install pnpm"),
    failed: () =>
      new JigsError(
        `jigs up failed in ${factoryRoot}`,
        `fix what jigs up reported above, then run pnpm ${args.join(" ")} and pnpm run typecheck in this factory`,
      ),
  });
}

async function typecheck(
  execFile: ExecFile,
  factoryRoot: string,
  out: (line: string) => void,
): Promise<void> {
  await execOrExplain(execFile, "pnpm", ["run", "typecheck"], { cwd: factoryRoot }, out, {
    missing: new JigsError("pnpm is not on PATH", "install pnpm: https://pnpm.io/installation"),
    failed: () =>
      new JigsError(
        `typecheck failed in ${factoryRoot}`,
        "update custom factory code to match the installed jigs API; jigs/ has already been regenerated",
      ),
  });
}
