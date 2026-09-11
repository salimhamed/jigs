// The only check that can see a broken @salimhamed/jigs packaging, and the
// only one that compiles the factory `jigs init` scaffolds.
//
// No jigs package carries a directive, so every durable step id is derived at
// compile time from the factory-local path of the file that declares it — and
// those ids are the memoization keys in the World. Every way of breaking that
// is silent: a closed discovery gate emits a bundle with no steps in it, a
// wrapper that loses its directive drops out of the manifest and runs
// unmemoized, a wrapper file that moves or is renamed takes a new id with it.
// None of it throws — the build is clean and the ids are simply wrong, in
// somebody else's repo, against runs already in flight.
//
// So: run `jigs init` into an empty directory outside this repo, exactly as a
// new factory would, install the package from the tarball `pnpm pack`
// emits — what a registry install unpacks, files list and rewritten
// workspace ranges included — and build it the way a real factory builds,
// twice: first with @salimhamed/jigs packed at a fake version, then as
// committed, so the tree is left holding a build of the real one. Read the
// ids back out of each bundle and diff both against the recorded list,
// because "the ids do not move when the library is versioned" is the property
// this whole shape was bought for, and it is the one nothing else can
// observe. The scaffold being what is built means the template is what is
// tested: the wrappers every factory starts from, and the ids test that ships
// beside them.
//
// Then start the bundle once: the SDK loads the World and the dashboard by
// name from the factory's node_modules, so they are peers a factory has to
// install itself, and nothing says otherwise until the built service starts
// in someone else's repo.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const cli = path.join(repo, "packages", "jigs", "dist", "cli.js");
const expectedFile = path.join(here, "expected-ids.txt");
const jigsPackage = path.join(repo, "packages", "jigs", "package.json");
const JIGS = "@salimhamed/jigs";
const FAKE_VERSION = "9.9.9-e2e";

const HEADER = `# The workflow and step ids \`jigs build\` emits for the factory \`jigs init\`
# scaffolds. Recorded by: node e2e/check-step-ids.mjs --record
#
# Every line is a memoization key in the World. A change here is a change in
# every factory's durable run state, so a diff is a finding, not a chore. The
# one line a rename may legitimately move is the workflow id, which carries
# the starter pipeline's file name. 0.5.0 renamed three wrappers and split a
# fourth, which is why this list moved once and why a diff here is a finding.
`;

// Outside this repo on purpose: Nitro takes the furthest pnpm-workspace.yaml
// above the build root as the workspace root and the compiler derives step
// ids relative to it, so a factory inside the jigs checkout would record ids
// no real factory ever emits. The temp dir is its own workspace root, the way
// a factory repo is.
let factory;
let scratch;
let tarballs;

// The tarball stands in for the registry, so this check needs no token. pnpm
// records a file: tarball by its integrity, which changes with any source
// change, so the scaffold installs without a lockfile rather than against a
// committed one.
function pack() {
  const dir = path.join(scratch, "tarballs");
  mkdirSync(dir);
  const into = (name) => path.join(dir, `${name}.tgz`);
  const packInto = (file) =>
    execFileSync("pnpm", ["--filter", JIGS, "pack", "--out", file], {
      cwd: repo,
      stdio: "inherit",
    });
  packInto(into("jigs"));
  withFakeVersion(() => packInto(into(`jigs-${FAKE_VERSION}`)));
  return { jigs: into("jigs"), bumped: into(`jigs-${FAKE_VERSION}`) };
}

function scaffold() {
  if (!existsSync(cli)) {
    fail(
      `no built CLI at ${cli}`,
      "pnpm build first — jigs init runs from the CLI's dist, the way a factory's does",
    );
  }
  scratch = mkdtempSync(path.join(tmpdir(), "jigs-e2e-"));
  tarballs = pack();
  factory = path.join(scratch, "factory");
  mkdirSync(factory);
  execFileSync(process.execPath, [cli, "init"], {
    cwd: factory,
    stdio: "inherit",
  });
}

// The scaffold pins the package to the CLI's version; here that pin becomes
// the tarball packed from this tree, which can be the one packed at the fake
// version instead.
function installFromTarball(tarball) {
  const manifestPath = path.join(factory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.dependencies[JIGS] === undefined) {
    fail(
      `the scaffolded package.json does not depend on ${JIGS}`,
      "the package.json template no longer lists it — this check rewrites that entry to a tarball",
    );
  }
  manifest.dependencies[JIGS] = `file:${tarball}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run("pnpm", ["install", "--no-frozen-lockfile"]);
}

const bundle = () => path.join(factory, ".output", "server", "index.mjs");

// The CLI half of a package that is now also the service (ADR 0017). `jigs
// init` runs from `pnpm dlx` on a machine that has installed nothing, and the
// four runtime peers are the factory's to supply, so `dist/cli.js` must reach
// none of the service runtime — nitro, hono, postgres, croner, undici, the
// SDK. Two packages used to make that the package manager's business; one
// package makes it import discipline, and a static import that crosses the
// line is silent: the bundle grows, and `jigs init` starts needing packages
// that are not there yet.
const CLI_IMPORTS = ["commander", "yaml", "zod"];

function cliBundleImports() {
  const seen = new Set();
  const bare = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(
      /(?:from|import)\s*["']([^"']+)["']/g,
    )) {
      if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec));
      else if (!spec.startsWith("node:")) {
        bare.add(
          spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0],
        );
      }
    }
  };
  visit(cli);
  return [...bare].sort();
}

function checkCliBundle() {
  const imports = cliBundleImports();
  const crossings = imports.filter((name) => !CLI_IMPORTS.includes(name));
  if (crossings.length > 0) {
    for (const name of crossings) console.error(`  ${name}`);
    fail(
      `${path.relative(repo, cli)} imports ${crossings.length} package(s) outside the CLI's own set (${CLI_IMPORTS.join(", ")})`,
      "a CLI path now reaches the service half — make the crossing a dynamic import resolved from the factory, the way build.ts does, or add the package here if the CLI genuinely owns it",
    );
  }
  console.log(`dist/cli.js imports ${imports.join(", ")}`);
}

function run(file, args) {
  execFileSync(file, args, { cwd: factory, stdio: "inherit" });
}

// No separate "the wrappers are still there" check: the scaffolded pipeline
// imports them, so a missing steps/jigs.ts fails the build below, and a moved
// one reports as the ids it took with it in the diff.
function build() {
  run(path.join(factory, "node_modules", ".bin", "jigs"), ["build"]);
}

function emittedIds() {
  let source;
  try {
    source = readFileSync(bundle(), "utf8");
  } catch {
    fail(`no bundle at ${bundle()}`, "the build above did not produce one");
  }
  return [...new Set(source.match(/"(?:workflow|step)\/\/[^"]+"/g) ?? [])]
    .map((quoted) => quoted.slice(1, -1))
    .sort();
}

// The workflow bundle is embedded in the server bundle as a string: it is
// evaluated in a sandbox with no node builtins at all. The wrappers import
// their step-side implementations at module scope, so what keeps those
// builtins out is the directive transform erasing each wrapper body — and its
// imports — from this half. That erasure is silent when it stops working.
function workflowBundle() {
  const lines = readFileSync(bundle(), "utf8").split("\n");
  const start = lines.findIndex((line) =>
    line.includes("workflowEntrypoint(`"),
  );
  const end = lines.indexOf("`);", start);
  if (start === -1 || end === -1) {
    fail(
      "could not find the workflow bundle in the emitted server bundle",
      "the SDK's entrypoint shape changed — this check needs updating",
    );
  }
  return lines.slice(start, end).join("\n");
}

function withFakeVersion(packJigs) {
  const original = readFileSync(jigsPackage, "utf8");
  const { version } = JSON.parse(original);
  const bumped = original.replace(
    `"version": "${version}"`,
    `"version": "${FAKE_VERSION}"`,
  );
  // A bump that silently failed to land would make this whole assertion
  // vacuous: two identical builds, ids "unchanged", nothing tested.
  if (bumped === original) {
    fail(
      `could not rewrite ${JIGS}'s version (${version}) for the bumped pack`,
      "the version field in packages/jigs/package.json no longer matches this replace — retarget it",
    );
  }
  writeFileSync(jigsPackage, bumped);
  try {
    return packJigs();
  } finally {
    writeFileSync(jigsPackage, original);
  }
}

// jigs' own dependencies resolve from its own node_modules, but its peers do
// not: the SDK requires the World by name from the factory's node_modules,
// and the dashboard plugin resolves @workflow/web from cwd. A
// peer missing from the factory's package.json is invisible until the built
// bundle starts, in someone else's repo, with ERR_MODULE_NOT_FOUND naming the
// package. Booting it once here is the only place this repo can see it, so
// this check is about module resolution and the service coming up — not
// about the World. The boot runs on the stub in e2e-world.cjs beside this
// file: it starts, it closes, it touches no database, and the service reaches
// `ready` on it the way it does on Postgres. (The SDK's filesystem World
// cannot stand in: from a bundle its start rejects, and a World that fails to
// start exits the service.)
//
// The service refuses to start without a WORKFLOW_POSTGRES_URL, though: the
// worktree registry gate creates its tables there before the World starts. So
// the boot runs only when the runner's environment carries one — CI's
// step-ids job brings a Postgres service container for it — and says so and
// skips when it does not. The registry needs no bootstrap: its ensure is a
// CREATE TABLE IF NOT EXISTS, so an empty database will do.
//
// Then the exit. Nothing under the service ends the process on SIGTERM —
// nitro wires no close hook, srvx only closes its listener, and
// graphile-worker drains and re-raises to nobody — so the service has to,
// and only a built bundle receiving the signal can show that it does. Once
// /health reports ready the child gets SIGTERM and must leave on its own,
// with code 0, inside the time `jigs service stop` gives it before SIGKILL.
// What this proves: imports, both listeners, readiness, the clean exit. What
// it does not: the graphile path, which the shutdown live test covers.
const BOOT_PORT = 18990;
const BOOT_DASHBOARD_PORT = 18991;
const BOOT_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 100;
const BOOT_MARKERS = ["Listening on:", "[service] dashboard:"];
const BOOT_WORLD = path.join(here, "e2e-world.cjs");
// A top-level import that cannot resolve exits the process; one behind a
// plugin's dynamic import is caught by nitro and only costs the dashboard, so
// the message is what identifies it either way.
const BOOT_UNRESOLVED = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/;

function bootOutcome(postgresUrl) {
  // The World is the stub whatever the shell says; the URL is the registry's.
  const env = {
    ...process.env,
    PORT: String(BOOT_PORT),
    JIGS_DASHBOARD_PORT: String(BOOT_DASHBOARD_PORT),
    WORKFLOW_TARGET_WORLD: BOOT_WORLD,
    WORKFLOW_POSTGRES_URL: postgresUrl,
  };
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [bundle()], { cwd: factory, env });
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let listening = false;
    let terminatedAt;
    let readyMs;
    let timer;
    const settle = (problem) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A child that left on its own is what passes; anything else still
      // holds the ports.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolve({
        output,
        problem,
        readyMs,
        exitMs:
          terminatedAt === undefined ? undefined : Date.now() - terminatedAt,
      });
    };
    const terminate = () => {
      terminatedAt = Date.now();
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          settle(`it did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`),
        SHUTDOWN_TIMEOUT_MS,
      );
      child.kill("SIGTERM");
    };
    // Listening is not ready: nitro answers /health before the plugins that
    // start the World have run, and the exit under test is the one that
    // closes a started World.
    const terminateOnceReady = async () => {
      while (!settled) {
        if (await ready()) {
          readyMs = Date.now() - spawnedAt;
          terminate();
          return;
        }
        await new Promise((r) => setTimeout(r, READY_POLL_MS));
      }
    };
    const read = (chunk) => {
      output += chunk;
      if (BOOT_UNRESOLVED.test(output)) settle("it could not resolve a module");
      else if (!listening && BOOT_MARKERS.every((m) => output.includes(m))) {
        listening = true;
        void terminateOnceReady();
      }
    };
    timer = setTimeout(
      () => settle(`it did not become ready within ${BOOT_TIMEOUT_MS}ms`),
      BOOT_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8").on("data", read);
    child.stderr.setEncoding("utf8").on("data", read);
    // `close`, not `exit`: the last lines of output arrive after `exit`.
    child.on("close", (code, signal) => {
      if (terminatedAt === undefined) {
        settle(
          `it exited (code ${code}, signal ${signal}) before it was ready`,
        );
      } else if (code === 0) {
        settle(null);
      } else {
        settle(
          `it exited with code ${code} (signal ${signal}) after SIGTERM, not 0`,
        );
      }
    });
  });
}

async function ready() {
  try {
    const res = await fetch(`http://127.0.0.1:${BOOT_PORT}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok && (await res.json()).ready === true;
  } catch {
    return false;
  }
}

function reportDiff(expected, actual) {
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  for (const id of missing) console.error(`- ${id}`);
  for (const id of unexpected) console.error(`+ ${id}`);
  return { missing, unexpected };
}

console.log(
  "\n=== scaffold: pack the package, jigs init into an empty directory",
);
scaffold();

console.log("\n=== cli: the bundle a factory installs the service from");
checkCliBundle();

if (process.argv[2] === "--record") {
  installFromTarball(tarballs.jigs);
  build();
  const ids = emittedIds();
  writeFileSync(expectedFile, `${HEADER}${ids.join("\n")}\n`);
  console.log(`recorded ${ids.length} id(s) in ${expectedFile}`);
  cleanup();
  process.exit(0);
}

// Bumped first so the tree is left holding a build of the real version.
console.log(`\n=== build 1/2: ${JIGS} at ${FAKE_VERSION}`);
installFromTarball(tarballs.bumped);
build();
const bumpedIds = emittedIds();

console.log(`\n=== build 2/2: ${JIGS} at its committed version`);
installFromTarball(tarballs.jigs);
build();
const ids = emittedIds();

const leaked = [...new Set(workflowBundle().match(/"node:[a-z/]+"/g) ?? [])];
if (leaked.length > 0) {
  for (const builtin of leaked) console.error(`  ${builtin}`);
  fail(
    `the workflow bundle reaches ${leaked.length} node builtin(s)`,
    "a wrapper's module-scope import survived the directive transform — the step-side module it names is reachable from the workflow half now",
  );
}

// The other half of the same property: pipeline-side code cannot read the
// environment either. Reported with line context because, unlike a `"node:fs"`
// specifier, a bare `process.env` says nothing about which module it came from.
const envReads = workflowBundle()
  .split("\n")
  .filter((line) => line.includes("process.env"));
if (envReads.length > 0) {
  for (const line of envReads.slice(0, 5)) console.error(`  ${line.trim()}`);
  fail(
    `the workflow bundle reads process.env in ${envReads.length} place(s)`,
    "pipeline-side code cannot read the environment — the read belongs in a step, or a step-side module crossed into a block",
  );
}

const expected = readFileSync(expectedFile, "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"));

const drift = reportDiff(expected, ids);
if (drift.missing.length > 0 || drift.unexpected.length > 0) {
  fail(
    `the emitted step ids are not the recorded ones (${drift.missing.length} missing, ${drift.unexpected.length} unexpected)`,
    "if the change is intended, re-record with: node e2e/check-step-ids.mjs --record",
  );
}

const moved = reportDiff(ids, bumpedIds);
if (moved.missing.length > 0 || moved.unexpected.length > 0) {
  // Both sides of a rename, so the count is the larger side, not the sum.
  const count = Math.max(moved.missing.length, moved.unexpected.length);
  fail(
    `versioning ${JIGS} moved ${count} step id(s)`,
    "a directive is back inside the jigs package: its ids carry the package's version, and bumping it orphans every parked run",
  );
}

// The scaffold's own checks, run the way a new factory runs them on day one:
// the typecheck covers the generated entry, the pipeline, and the blocks and
// prompts scaffolded beside them, and the two scaffolded tests cover the shape
// of every id the same build emitted (the exact list is this file's business,
// above) and the sequence the review loop runs.
console.log("\n=== scaffold: typecheck, then the scaffolded tests");
run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);

const postgresUrl = process.env.WORKFLOW_POSTGRES_URL;
if (postgresUrl === undefined || postgresUrl === "") {
  console.log(
    "\nboot check skipped: WORKFLOW_POSTGRES_URL unset (CI runs it against a service container)",
  );
} else {
  console.log(
    "\n=== boot: the built bundle resolves every import, becomes ready, and exits on SIGTERM",
  );
  const boot = await bootOutcome(postgresUrl);
  if (boot.problem === null) {
    console.log(
      `ready after ${boot.readyMs}ms; exited 0 ${boot.exitMs}ms after SIGTERM`,
    );
  } else {
    console.error(boot.output);
    fail(
      `the built service did not start and stop cleanly: ${boot.problem}`,
      `if the output above names a package it cannot find, the factory loads it by name at run time: it belongs in ${JIGS}'s peerDependencies and the factory package.json template`,
    );
  }
}

console.log(
  `\n${ids.length} step/workflow id(s) match ${expectedFile}, and are unchanged with ${JIGS} at ${FAKE_VERSION}`,
);
cleanup();

function cleanup() {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
}

// The scaffold is left in place on failure: what went wrong is in there.
function fail(message, hint) {
  console.error(`step-id check failed: ${message}`);
  console.error(hint);
  if (factory !== undefined) console.error(`the scaffold is at ${factory}`);
  process.exit(1);
}
