// The only check that can see a broken @salimhamed/jigs packaging, and the
// only one that compiles both the bare scaffold and the optional ship recipe.
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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const cli = path.join(repo, "dist", "cli.js");
const jigsPackage = path.join(repo, "package.json");
const JIGS = "@salimhamed/jigs";
const FAKE_VERSION = "9.9.9-e2e";

const HEADER = `# Workflow and step ids emitted by the named scaffold (bare or ship recipe).
# Recorded by: node e2e/check-step-ids.mjs --record
#
# These addresses come from the factory's named workflow and step functions.
# Renaming a factory file or function deliberately changes its address; merely
# upgrading the jigs library must not. Review intended renames before recording.
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
    execFileSync("pnpm", ["pack", "--out", file], {
      cwd: repo,
      stdio: "inherit",
    });
  packInto(into("jigs"));
  withFakeVersion(() => packInto(into(`jigs-${FAKE_VERSION}`)));
  return { jigs: into("jigs"), bumped: into(`jigs-${FAKE_VERSION}`) };
}

function scaffold(name) {
  if (!existsSync(cli)) {
    fail(
      `no built CLI at ${cli}`,
      "pnpm build first — jigs init runs from the CLI's dist, the way a factory's does",
    );
  }
  factory = path.join(scratch, name);
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

// Every module nitro emitted from the factory's own code: the entry plus the
// `_chunks/` split it puts each workflow module in. `_libs/` and
// `node_modules/` are vendored dependency code, which resolves its own
// specifiers and is none of this check's business.
const VENDORED = new Set(["_libs", "node_modules"]);

function factoryModules() {
  const root = path.join(factory, ".output", "server");
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return VENDORED.has(entry.name) ? [] : walk(full);
      return entry.name.endsWith(".mjs") ? [full] : [];
    });
  return existsSync(root) ? walk(root) : [];
}

const unresolvedSpecifiers = (source) =>
  source.match(/(?:from|import|require)\s*\(?\s*["']#[^"']+["']/g) ?? [];

// The CLI half of a package that is now also the service (ADR 0017). `jigs
// init` runs from `pnpm dlx` on a machine that has installed nothing, and the
// four runtime peers are the factory's to supply, so `dist/cli.js` must reach
// none of the service runtime — nitro, hono, postgres, croner, the
// SDK. Two packages used to make that the package manager's business; one
// package makes it import discipline, and a static import that crosses the
// line is silent: the bundle grows, and `jigs init` starts needing packages
// that are not there yet.
const CLI_IMPORTS = ["commander", "jiti", "ts-morph", "yaml", "zod"];

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
        bare.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
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

// No separate "the wrappers are still there" check: the scaffolded workflow
// imports them, so a missing jigs.ts fails the build below, and a moved
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
  return (
    [...new Set(source.match(/"(?:workflow|step)\/\/[^"]+"/g) ?? [])]
      .map((quoted) => quoted.slice(1, -1))
      // v5's combined host bundle also registers SDK-owned Run methods and
      // builtins. Their package-versioned addresses are the SDK's contract;
      // this assertion owns only the factory-local addresses whose stability
      // jigs' generated-wrapper design promises.
      .filter((id) => /^(?:workflow|step)\/\/\.\/(?!node_modules\/)/.test(id))
      .sort()
  );
}

// The workflow bundle is embedded in the server bundle as a string: it is
// evaluated in a sandbox with no node builtins at all. The wrappers import
// their step-side implementations at module scope, so what keeps those
// builtins out is the directive transform erasing each wrapper body — and its
// imports — from this half. That erasure is silent when it stops working.
function workflowBundle() {
  const lines = readFileSync(bundle(), "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes("workflowEntrypoint(`"));
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const trimmed = line.trim();
    // v4 ended the call after the bundle string. The v5 combined handler
    // follows that string with entrypoint options in the same call.
    return trimmed === "`);" || trimmed.startsWith("`, {");
  });
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
  const bumped = original.replace(`"version": "${version}"`, `"version": "${FAKE_VERSION}"`);
  // A bump that silently failed to land would make this whole assertion
  // vacuous: two identical builds, ids "unchanged", nothing tested.
  if (bumped === original) {
    fail(
      `could not rewrite ${JIGS}'s version (${version}) for the bumped pack`,
      "the version field in package.json no longer matches this replace — retarget it",
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
// about the World. The boot runs on the stub in e2e-world.mjs beside this
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
// The nudge line is in here because the startup sweep is what reconciles a
// delivery lost while the service was down: if it stops running, nothing else
// in this repo notices.
const BOOT_MARKERS = ["Listening on:", "[service] dashboard:", "[nudge] pull requests:"];
const BOOT_WORLD = path.join(here, "e2e-world.mjs");
// A top-level import that cannot resolve exits the process; one behind a
// plugin's dynamic import is caught by nitro and only costs the dashboard, so
// the message is what identifies it either way.
const BOOT_UNRESOLVED = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/;

const RUNTIME_PORT = 18992;
const RUNTIME_DASHBOARD_PORT = 18993;
const RUNTIME_TIMEOUT_MS = 90_000;
const LONG_STEP_MS = Number(process.env.JIGS_E2E_LONG_STEP_MS ?? "25");

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
        exitMs: terminatedAt === undefined ? undefined : Date.now() - terminatedAt,
      });
    };
    const terminate = () => {
      terminatedAt = Date.now();
      clearTimeout(timer);
      timer = setTimeout(
        () => settle(`it did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`),
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
        settle(`it exited (code ${code}, signal ${signal}) before it was ready`);
      } else if (code === 0) {
        settle(null);
      } else {
        settle(`it exited with code ${code} (signal ${signal}) after SIGTERM, not 0`);
      }
    });
  });
}

async function ready() {
  try {
    const res = await fetch(`http://127.0.0.1:${BOOT_PORT}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!res.ok) return false;
    const health = await res.json();
    if (health.ready !== true || !health.workflows.includes("ship")) return false;
    // The deferred module must have resolved into the compiled service's
    // registration, including its input schema; readiness alone cannot prove it.
    const inputs = await fetch(`http://127.0.0.1:${BOOT_PORT}/api/workflows/ship/inputs`, {
      signal: AbortSignal.timeout(1_000),
    });
    return inputs.ok;
  } catch {
    return false;
  }
}

function installRuntimeFixture() {
  const workflow = path.join(factory, "workflows", "runtime-e2e.ts");
  writeFileSync(
    workflow,
    `import { appendFileSync, readFileSync } from "node:fs";
import type { WorkflowEntry, WorkflowInputs } from "@salimhamed/jigs";
import { defineHook, sleep } from "workflow";
import { z } from "zod";

export const runtimeE2eInputs = z.object({
  delayMs: z.number().int().nonnegative(),
  marker: z.string(),
  token: z.string(),
});

const restartHook = defineHook<void>();

async function recordedStep(marker: string, name: string, delayMs = 0): Promise<string> {
  "use step";
  appendFileSync(marker, \`start \${name}\\n\`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  appendFileSync(marker, \`end \${name}\\n\`);
  return name;
}

async function markerLines(marker: string): Promise<string[]> {
  "use step";
  return readFileSync(marker, "utf8").trim().split("\\n");
}

export async function runtimeE2eWorkflow(
  inputs: WorkflowInputs<typeof runtimeE2eInputs>,
) {
  "use workflow";
  const sequential = await recordedStep(inputs.marker, "long", inputs.delayMs);
  await sleep("1s");
  const parallel = await Promise.all([
    recordedStep(inputs.marker, "parallel-a"),
    recordedStep(inputs.marker, "parallel-b"),
  ]);
  const hook = restartHook.create({ token: inputs.token });
  await hook;
  const resumed = await recordedStep(inputs.marker, "resumed");
  return { sequential, parallel: parallel.sort(), resumed, lines: await markerLines(inputs.marker) };
}

export default {
  workflow: runtimeE2eWorkflow,
  inputs: runtimeE2eInputs,
} satisfies WorkflowEntry<typeof runtimeE2eInputs>;
`,
  );
  const config = path.join(factory, "jigs.config.ts");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "workflows: {",
      'workflows: {\n    runtimeE2e: () => import("./workflows/runtime-e2e.ts"),',
    ),
  );
}

function runtimeEnv(postgresUrl) {
  return {
    ...process.env,
    PORT: String(RUNTIME_PORT),
    JIGS_DASHBOARD_PORT: String(RUNTIME_DASHBOARD_PORT),
    WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${RUNTIME_PORT}`,
    WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN: "1",
    WORKFLOW_POSTGRES_URL: postgresUrl,
    WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
  };
}

async function startRuntimeService(postgresUrl) {
  const child = spawn(process.execPath, [bundle()], {
    cwd: factory,
    env: runtimeEnv(postgresUrl),
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  await until(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`runtime service exited before readiness\n${output}`);
      }
      try {
        const [health, dashboard] = await Promise.all([
          fetch(`http://127.0.0.1:${RUNTIME_PORT}/health`, {
            signal: AbortSignal.timeout(1_000),
          }),
          fetch(`http://127.0.0.1:${RUNTIME_DASHBOARD_PORT}/`, {
            signal: AbortSignal.timeout(1_000),
          }),
        ]);
        return health.ok && (await health.json()).ready === true && dashboard.ok;
      } catch {
        return false;
      }
    },
    "runtime service and dashboard did not become ready",
    RUNTIME_TIMEOUT_MS,
  );
  return { child, output: () => output };
}

async function stopRuntimeService(service) {
  const closed = new Promise((resolve) =>
    service.child.once("close", (code, signal) => resolve({ code, signal })),
  );
  service.child.kill("SIGTERM");
  const outcome = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), SHUTDOWN_TIMEOUT_MS)),
  ]);
  if ("timeout" in outcome) {
    service.child.kill("SIGKILL");
    throw new Error(`runtime service did not stop cleanly\n${service.output()}`);
  }
  if (outcome.code !== 0) {
    throw new Error(
      `runtime service exited with code ${outcome.code} (signal ${outcome.signal})\n${service.output()}`,
    );
  }
}

async function runtimeScenario(postgresUrl) {
  installRuntimeFixture();
  build();
  run(path.join(factory, "node_modules", ".bin", "bootstrap"), []);

  const marker = path.join(scratch, "runtime-step-markers.txt");
  const token = `runtime-e2e-${crypto.randomUUID()}`;
  let service = await startRuntimeService(postgresUrl);
  try {
    const started = await fetch(`http://127.0.0.1:${RUNTIME_PORT}/api/workflows/runtimeE2e/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: { delayMs: LONG_STEP_MS, marker, token } }),
    });
    if (started.status !== 201) {
      throw new Error(`runtime workflow start returned ${started.status}: ${await started.text()}`);
    }
    const { runId } = await started.json();
    await until(
      async () => {
        const run = await runtimeRun(runId);
        if (run.status === "failed" || run.status === "cancelled") {
          throw new Error(`runtime workflow ${runId} became ${run.status}: ${JSON.stringify(run)}`);
        }
        return run.suspensions.length > 0;
      },
      `runtime workflow ${runId} never parked on its hook`,
      RUNTIME_TIMEOUT_MS + LONG_STEP_MS,
    );

    await stopRuntimeService(service);
    service = await startRuntimeService(postgresUrl);

    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { resumeHook } from "workflow/api"; import { getWorld } from "workflow/runtime"; await resumeHook(process.argv[1], undefined); await (await getWorld()).close?.();',
        token,
      ],
      { cwd: factory, env: runtimeEnv(postgresUrl), stdio: "inherit" },
    );

    let terminal;
    await until(
      async () => {
        terminal = await runtimeRun(runId);
        return terminal.status === "completed";
      },
      `runtime workflow ${runId} did not complete after restart`,
      RUNTIME_TIMEOUT_MS,
    );
    const expectedLines = [
      "start long",
      "end long",
      "start parallel-a",
      "end parallel-a",
      "start parallel-b",
      "end parallel-b",
      "start resumed",
      "end resumed",
    ];
    const actualLines = [...terminal.returnValue.lines].sort();
    if (JSON.stringify(actualLines) !== JSON.stringify([...expectedLines].sort())) {
      throw new Error(
        `step marker mismatch (duplicate or missing execution): ${JSON.stringify(terminal.returnValue.lines)}`,
      );
    }
    if (
      terminal.returnValue.sequential !== "long" ||
      terminal.returnValue.resumed !== "resumed" ||
      JSON.stringify(terminal.returnValue.parallel) !== JSON.stringify(["parallel-a", "parallel-b"])
    ) {
      throw new Error(`unexpected runtime return value: ${JSON.stringify(terminal.returnValue)}`);
    }
    console.log(
      `run ${runId} completed after ${LONG_STEP_MS}ms step, durable sleep, parallel steps, restart, and hook resume; dashboard answered`,
    );
  } finally {
    if (service.child.exitCode === null && service.child.signalCode === null) {
      await stopRuntimeService(service);
    }
  }
}

async function runtimeRun(runId) {
  const response = await fetch(`http://127.0.0.1:${RUNTIME_PORT}/api/runs/${runId}`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok)
    throw new Error(`run lookup returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function until(check, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(message);
}

function reportDiff(expected, actual) {
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  for (const id of missing) console.error(`- ${id}`);
  for (const id of unexpected) console.error(`+ ${id}`);
  return { missing, unexpected };
}

async function checkScaffold(name) {
  const expectedFile = path.join(here, `expected-ids.${name}.txt`);
  console.log(`\n=== scaffold: ${name}`);
  scaffold(name);
  // Formatting generated code must not trigger the build's exact-content drift check.
  const generated = readFileSync(path.join(factory, "jigs.ts"), "utf8");
  const formatted = execFileSync(
    path.join(repo, "node_modules", ".bin", "biome"),
    ["check", "--write", "--stdin-file-path=jigs.ts"],
    { cwd: repo, input: generated, encoding: "utf8" },
  );
  if (formatted !== generated) {
    fail("generated jigs.ts changes under Biome", "format templates/jigs.ts.tmpl as TypeScript");
  }
  // Exercise recipe discovery and copying from the installed tarball, including
  // the documented manual registration step. Both versions use these same files.
  installFromTarball(tarballs.bumped);
  if (name === "ship") {
    run(path.join(factory, "node_modules", ".bin", "jigs"), ["recipe", "add", "ship"]);
    const config = path.join(factory, "jigs.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "workflows: {",
        'workflows: {\n    ship: () => import("./workflows/ship.ts"),',
      ),
    );
  }

  // Bumped first so the tree is left holding a build of the real version.
  console.log(`\n=== build 1/2: ${JIGS} at ${FAKE_VERSION}`);
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

  // The other half of the same property: workflow-side code cannot read the
  // environment either. Reported with line context because, unlike a `"node:fs"`
  // specifier, a bare `process.env` says nothing about which module it came from.
  const envReads = workflowBundle()
    .split("\n")
    .filter((line) => line.includes("process.env"));
  if (envReads.length > 0) {
    for (const line of envReads.slice(0, 5)) console.error(`  ${line.trim()}`);
    fail(
      `the workflow bundle reads process.env in ${envReads.length} place(s)`,
      "workflow-side code cannot read the environment — the read belongs in a step, or a step-side module crossed into a block",
    );
  }

  // The scaffold imports through its package.json `imports` map, so this build
  // is where the map is resolved by everything that has to resolve it: tsc, the
  // workflows pass' esbuild, nitro's bundler, and vitest below. A specifier that
  // survives into the emitted output was never resolved — the module it names is
  // gone, and the failure only surfaces when the code path runs in production.
  // The entry alone is not the output: nitro splits the factory's own modules
  // into `_chunks/`, and `_chunks/ship.mjs` is where the compiled workflow — and
  // every `#jigs` import site in it — actually lands.
  const scan = (files) => files.flatMap((file) => unresolvedSpecifiers(readFileSync(file, "utf8")));

  const emitted = factoryModules();

  // A clean scan means nothing until the scan is shown to catch what it is
  // looking for, in the place it was widened to look: a specifier planted in a
  // chunk must come back, or every clean result below is vacuous. The plant is
  // the one case that has to re-walk, because the sample is a file the walk
  // above could not have seen.
  const chunks = emitted.filter((file) => path.dirname(file).endsWith("_chunks"));
  if (chunks.length === 0) {
    fail(
      "no `_chunks/` module among the emitted ones to scan",
      "the split moved or is gone, and this scan would be reading the entry alone again — which is the hole it was widened to close",
    );
  }
  const sample = path.join(path.dirname(chunks[0]), "__scan-sample.mjs");
  writeFileSync(sample, 'import { deliverChange } from "#jigs";\n');
  const caught = scan(factoryModules()).some((specifier) => specifier.includes("#jigs"));
  rmSync(sample);
  if (!caught) {
    fail(
      "the unresolved-specifier scan missed a planted specifier in an emitted chunk",
      "the scan is not reading what it claims to read — fix it before trusting a clean run",
    );
  }

  const unresolved = [...new Set(scan(emitted))];
  if (unresolved.length > 0) {
    for (const specifier of unresolved) console.error(`  ${specifier}`);
    fail(
      `the emitted output carries ${unresolved.length} unresolved root-anchored specifier(s) across ${emitted.length} module(s)`,
      "the factory's package.json `imports` map no longer covers them, or the bundler stopped reading it — a conditional target the workflows pass cannot match does exactly this",
    );
  }

  if (process.argv[2] === "--record") {
    writeFileSync(expectedFile, `${HEADER}${ids.join("\n")}\n`);
    console.log(`recorded ${ids.length} id(s) in ${expectedFile}`);
  } else {
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

  // Exercise policy lookup with a real compiler-stamped workflow export. Source
  // unit tests cannot prove that the compiled module retains workflowId.
  if (name === "ship") {
    console.log("\n=== release: compiled workflow policy overrides the factory default");
    run(process.execPath, [
      "--input-type=module",
      "--eval",
      `
  import assert from "node:assert/strict";
  import entry from "./.output/server/_chunks/ship.mjs";
  import { resolveReleasePolicy } from "@salimhamed/jigs/steps/runtime";
  const workflowName = "workflow//./workflows/ship//shipWorkflow";
  assert.equal(entry.workflow.workflowId, workflowName);
  entry.release = { onSuccess: "keep", onFailure: "release" };
  const policy = await resolveReleasePolicy(
    { workflowRunId: "run_policy_check", workflowName },
    { workflows: { differentConfigKey: async () => ({ default: entry }) } },
  );
  assert.deepEqual(policy, entry.release);
`,
    ]);
  }

  // The scaffold's own checks, run the way a new factory runs them on day one:
  // the typecheck covers the generated entry, the workflow, and the blocks and
  // prompts scaffolded beside them, and the scaffolded tests cover the shape of
  // every id the same build emitted (the exact list is this file's business,
  // above) and what the workflow body hands delivery. Both read the scaffold
  // through its `imports` map, so this is also where tsc and vitest are held to
  // resolving it.
  console.log("\n=== scaffold: typecheck, then the scaffolded tests");
  run("pnpm", ["typecheck"]);
  run("pnpm", ["test"]);

  console.log(
    `\n${name}: ${ids.length} step/workflow id(s) match ${expectedFile}, and are unchanged with ${JIGS} at ${FAKE_VERSION}`,
  );
}

scratch = mkdtempSync(path.join(tmpdir(), "jigs-e2e-"));
tarballs = pack();
checkCliBundle();
for (const name of ["bare", "ship"]) await checkScaffold(name);

// Boot the recipe scaffold once: it registers hello and ship, exercising the
// optional recipe's deferred registration as well as all runtime peers.
const postgresUrl = process.env.WORKFLOW_POSTGRES_URL;
if (postgresUrl === undefined || postgresUrl === "") {
  console.log(
    "\nboot check skipped: WORKFLOW_POSTGRES_URL unset (CI runs it against a service container)",
  );
} else {
  console.log("\n=== cancel: pending and exhausted queue jobs are deleted in Postgres");
  execFileSync(
    "pnpm",
    ["vitest", "run", "--config", "vitest.live.config.ts", "src/service/cancel.live.test.ts"],
    { cwd: repo, stdio: "inherit" },
  );
  console.log(
    "\n=== boot: the built bundle resolves every import, becomes ready, and exits on SIGTERM",
  );
  const boot = await bootOutcome(postgresUrl);
  if (boot.problem === null) {
    console.log(`ready after ${boot.readyMs}ms; exited 0 ${boot.exitMs}ms after SIGTERM`);
  } else {
    console.error(boot.output);
    fail(
      `the built service did not start and stop cleanly: ${boot.problem}`,
      `if the output above names a package it cannot find, the factory loads it by name at run time: it belongs in ${JIGS}'s peerDependencies and the factory package.json template`,
    );
  }
  console.log(
    `\n=== runtime: real Postgres steps, sleep, parallel work, restart recovery, hook resume, and dashboard (${LONG_STEP_MS}ms long step)`,
  );
  await runtimeScenario(postgresUrl);
}

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
