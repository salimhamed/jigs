// The only check that can see a broken @jigs/service packaging.
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
// So: build the fixture factory the way a real factory builds, twice — first
// with @jigs/service on a fake version, then as committed, so the tree is left
// holding a build of the real one. Read the ids back out of each bundle and
// diff both against the recorded list, because "the ids do not move when the
// library is versioned" is the property this whole shape was bought for, and
// it is the one nothing else can observe.
//
// Then start the bundle once: the SDK loads the World and the dashboard by
// name from the factory's node_modules, so they are peers a factory has to
// install itself, and nothing says otherwise until the built service starts
// in someone else's repo.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const factory = path.join(here, "fixture-factory");
const bundle = path.join(factory, ".output", "server", "index.mjs");
const expectedFile = path.join(factory, "expected-ids.txt");
const servicePackage = path.join(
  here,
  "..",
  "packages",
  "service",
  "package.json",
);
const FAKE_VERSION = "9.9.9-e2e";

const HEADER = `# The workflow and step ids \`jigs build\` emits for this fixture factory.
# Recorded by: node e2e/check-step-ids.mjs --record
#
# Every line is a memoization key in the World. A change here is a change in
# every factory's durable run state, so a diff is a finding, not a chore.
`;

// No separate "the wrappers are still there" check: the fixture's pipeline
// imports them, so a missing steps/jigs.ts fails the build below, and a moved
// one reports as the ids it took with it in the diff.
function build() {
  execFileSync(path.join(factory, "node_modules", ".bin", "jigs"), ["build"], {
    cwd: factory,
    stdio: "inherit",
  });
}

function emittedIds() {
  let source;
  try {
    source = readFileSync(bundle, "utf8");
  } catch {
    fail(`no bundle at ${bundle}`, "the build above did not produce one");
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
  const lines = readFileSync(bundle, "utf8").split("\n");
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

function withFakeVersion(run) {
  const original = readFileSync(servicePackage, "utf8");
  const { version } = JSON.parse(original);
  const bumped = original.replace(
    `"version": "${version}"`,
    `"version": "${FAKE_VERSION}"`,
  );
  // A bump that silently failed to land would make this whole assertion
  // vacuous: two identical builds, ids "unchanged", nothing tested.
  if (bumped === original) {
    fail(
      `could not rewrite @jigs/service's version (${version}) for the bumped build`,
      "the version field in packages/service/package.json no longer matches this replace — retarget it",
    );
  }
  writeFileSync(servicePackage, bumped);
  try {
    return run();
  } finally {
    writeFileSync(servicePackage, original);
  }
}

// The service's own dependencies resolve from its own node_modules, but its
// peers do not: the SDK requires the World by name from the factory's
// node_modules, and the dashboard plugin resolves @workflow/web from cwd. A
// peer missing from the factory's package.json is invisible until the built
// bundle starts, in someone else's repo, with ERR_MODULE_NOT_FOUND naming the
// package. Booting it once here is the only place this repo can see it, so
// this check is about module resolution and the two listeners coming up — not
// about the World, whose URL below points at nothing on purpose.
const BOOT_PORT = 18990;
const BOOT_DASHBOARD_PORT = 18991;
const BOOT_TIMEOUT_MS = 90_000;
const BOOT_MARKERS = ["Listening on:", "[service] dashboard:"];
// A top-level import that cannot resolve exits the process; one behind a
// plugin's dynamic import is caught by nitro and only costs the dashboard, so
// the message is what identifies it either way.
const BOOT_UNRESOLVED = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/;

function bootOutcome() {
  const child = spawn(process.execPath, [bundle], {
    cwd: factory,
    env: {
      ...process.env,
      PORT: String(BOOT_PORT),
      JIGS_DASHBOARD_PORT: String(BOOT_DASHBOARD_PORT),
      WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
      WORKFLOW_POSTGRES_URL: "postgres://nobody@127.0.0.1:1/nothing",
    },
  });
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    // The kill below makes the process exit, which fires the handler that
    // would settle a second time with a failure.
    const settle = (problem) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ output, problem });
    };
    const read = (chunk) => {
      output += chunk;
      if (BOOT_UNRESOLVED.test(output)) settle("it could not resolve a module");
      else if (BOOT_MARKERS.every((m) => output.includes(m))) settle(null);
    };
    const timer = setTimeout(
      () => settle(`it did not start listening within ${BOOT_TIMEOUT_MS}ms`),
      BOOT_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8").on("data", read);
    child.stderr.setEncoding("utf8").on("data", read);
    child.on("exit", (code, signal) =>
      settle(`it exited (code ${code}, signal ${signal}) before listening`),
    );
  });
}

function reportDiff(expected, actual) {
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  for (const id of missing) console.error(`- ${id}`);
  for (const id of unexpected) console.error(`+ ${id}`);
  return { missing, unexpected };
}

if (process.argv[2] === "--record") {
  build();
  const ids = emittedIds();
  writeFileSync(expectedFile, `${HEADER}${ids.join("\n")}\n`);
  console.log(`recorded ${ids.length} id(s) in ${expectedFile}`);
  process.exit(0);
}

// Bumped first so the tree is left holding a build of the real version.
console.log(`\n=== build 1/2: @jigs/service at ${FAKE_VERSION}`);
const bumpedIds = withFakeVersion(() => {
  build();
  return emittedIds();
});

console.log("\n=== build 2/2: @jigs/service at its committed version");
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
    `versioning @jigs/service moved ${count} step id(s)`,
    "a directive is back inside a jigs package: its ids carry that package's version, and bumping it orphans every parked run",
  );
}

console.log("\n=== boot: the built bundle resolves every import and listens");
const boot = await bootOutcome();
if (boot.problem !== null) {
  console.error(boot.output);
  fail(
    `the built service did not start: ${boot.problem}`,
    "if the output above names a package it cannot find, the factory loads it by name at run time: it belongs in @jigs/service's peerDependencies, the factory package.json template and this fixture's",
  );
}

console.log(
  `\n${ids.length} step/workflow id(s) match ${expectedFile}, and are unchanged with @jigs/service at ${FAKE_VERSION}`,
);

function fail(message, hint) {
  console.error(`step-id check failed: ${message}`);
  console.error(hint);
  process.exit(1);
}
