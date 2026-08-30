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
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const factory = path.join(here, "fixture-factory");
const bundle = path.join(factory, ".output", "server", "index.mjs");
const expectedFile = path.join(factory, "expected-ids.txt");
const scaffold = path.join(
  here,
  "..",
  "packages",
  "service",
  "templates",
  "steps",
  "jigs.ts.tmpl",
);
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

// The fixture's wrappers are not a hand-written approximation of the scaffold:
// they are the scaffold, so what CI compiles is what `jigs init` writes. Run
// last, after the id diff, so a wrapper file that moved reports as the ids it
// took with it rather than as a missing file.
function checkScaffoldMatches() {
  let wrappers;
  try {
    wrappers = readFileSync(path.join(factory, "steps", "jigs.ts"), "utf8");
  } catch {
    fail(
      "the fixture factory has no steps/jigs.ts",
      "the scaffold's path is half of every step id — restore the file rather than renaming it",
    );
  }
  if (wrappers !== readFileSync(scaffold, "utf8")) {
    fail(
      "the fixture's steps/jigs.ts has drifted from the jigs init scaffold",
      `copy it back: cp ${path.relative(process.cwd(), scaffold)} e2e/fixture-factory/steps/jigs.ts`,
    );
  }
}

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
  writeFileSync(
    servicePackage,
    original.replace('"version": "0.0.0"', `"version": "${FAKE_VERSION}"`),
  );
  try {
    return run();
  } finally {
    writeFileSync(servicePackage, original);
  }
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

checkScaffoldMatches();

console.log(
  `\n${ids.length} step/workflow id(s) match ${expectedFile}, and are unchanged with @jigs/service at ${FAKE_VERSION}`,
);

function fail(message, hint) {
  console.error(`step-id check failed: ${message}`);
  console.error(hint);
  process.exit(1);
}
