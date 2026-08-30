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
// So: build the fixture factory the way a real factory builds, read the ids
// back out of the bundle, and diff them against the recorded list.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(
  here,
  "fixture-factory",
  ".output",
  "server",
  "index.mjs",
);
const expectedFile = path.join(here, "fixture-factory", "expected-ids.txt");

const HEADER = `# The workflow and step ids \`jigs build\` emits for this fixture factory.
# Recorded by: node e2e/check-step-ids.mjs --record
#
# Every line is a memoization key in the World. A change here is a change in
# every factory's durable run state, so a diff is a finding, not a chore.
`;

let source;
try {
  source = readFileSync(bundle, "utf8");
} catch {
  fail(`no bundle at ${bundle}`, "build the fixture factory first: jigs build");
}

const ids = [...new Set(source.match(/"(?:workflow|step)\/\/[^"]+"/g) ?? [])]
  .map((quoted) => quoted.slice(1, -1))
  .sort();

if (process.argv[2] === "--record") {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(expectedFile, `${HEADER}${ids.join("\n")}\n`);
  console.log(`recorded ${ids.length} id(s) in ${expectedFile}`);
  process.exit(0);
}

const expected = readFileSync(expectedFile, "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"));

const missing = expected.filter((id) => !ids.includes(id));
const unexpected = ids.filter((id) => !expected.includes(id));

if (missing.length > 0 || unexpected.length > 0) {
  for (const id of missing) console.error(`- ${id}`);
  for (const id of unexpected) console.error(`+ ${id}`);
  fail(
    `the emitted step ids are not the recorded ones (${missing.length} missing, ${unexpected.length} unexpected)`,
    "if the change is intended, re-record with: node e2e/check-step-ids.mjs --record",
  );
}

console.log(`${ids.length} step/workflow id(s) match ${expectedFile}`);

function fail(message, hint) {
  console.error(`step-id check failed: ${message}`);
  console.error(hint);
  process.exit(1);
}
