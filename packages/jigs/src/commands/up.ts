import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  type ResolvedService,
  resolveService,
} from "../config/factory-config.ts";
import { locateFactoryRoot } from "../config/locate-factory.ts";
import { CliError } from "../errors.ts";
import {
  type ExecError,
  type ExecFile,
  type ExecOptions,
  execOutput,
  nodeExecFile,
} from "../exec.ts";
import { stringEnv } from "../harnesses/env.ts";
import {
  buildFactoryService,
  listRunsInFlight,
  type Prepare,
} from "./build.ts";
import { runDoctor } from "./doctor.ts";
import {
  builtBundleHash,
  liveServicePid,
  restartService,
  runningBundleHash,
  type ServiceLifecycleDeps,
  type ServiceProcesses,
  serviceLogs,
  startService,
} from "./service-lifecycle.ts";

// Takes a factory from any state to a running service: the commands a human
// used to type after `jigs init`, run in order. Each step is idempotent, so a
// second `up` on an unchanged factory copies, installs, migrates and restarts
// nothing. What `init` bought by printing the commands instead of running
// them — a failure the human can see and name — is kept by giving every step
// its own line and stopping at the first one that fails.

export type UpStepName =
  | "locate"
  | "env"
  | "install"
  | "compose"
  | "bootstrap"
  | "build"
  | "service"
  | "ready"
  | "doctor";

export interface UpStep {
  name: UpStepName;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  detail?: string;
  repair?: string;
}

export type ServiceOutcome = "started" | "restarted" | "unchanged";

export interface UpResult {
  ok: boolean;
  steps: UpStep[];
  factoryRoot?: string;
  serviceUrl?: string;
  dashboardUrl?: string;
  service?: ServiceOutcome;
}

export interface UpDeps {
  cwd: string;
  out: (line: string) => void;
  execFile?: ExecFile;
  processes?: ServiceProcesses;
  prepare?: Prepare;
  confirm?: (question: string) => Promise<boolean>;
  readyTimeoutMs?: number;
  pollMs?: number;
}

export interface UpOptions {
  restart?: boolean;
  force?: boolean;
  doctor?: boolean;
}

// Read by the suspension primitives; empty slots are the expected state of a
// freshly copied .env, so they are reported, not refused.
const CREDENTIAL_SLOTS = ["LINEAR_API_KEY", "GITHUB_TOKEN"];
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const FACTORY_CODE = "jigs.config.ts";

class StepFailed extends Error {}

type Note = (detail: string) => void;

interface Runner {
  steps: UpStep[];
  run<T>(name: UpStepName, fn: (note: Note) => Promise<T> | T): Promise<T>;
  skip(name: UpStepName, detail: string): void;
}

function stepRunner(out: (line: string) => void): Runner {
  const steps: UpStep[] = [];
  return {
    steps,
    async run(name, fn) {
      const started = Date.now();
      let detail: string | undefined;
      try {
        const value = await fn((text) => {
          detail = text;
        });
        const durationMs = Date.now() - started;
        steps.push({ name, status: "ok", durationMs, detail });
        out(
          `ok   ${name} (${formatDuration(durationMs)})${detail === undefined ? "" : ` — ${detail}`}`,
        );
        return value;
      } catch (err) {
        const durationMs = Date.now() - started;
        const message = err instanceof Error ? err.message : String(err);
        const repair = err instanceof CliError ? err.hint : undefined;
        steps.push({
          name,
          status: "failed",
          durationMs,
          detail: message,
          repair,
        });
        out(`FAIL ${name}: ${message.split("\n")[0]}`);
        if (repair !== undefined) out(`  → ${repair}`);
        throw new StepFailed(message);
      }
    },
    skip(name, detail) {
      steps.push({ name, status: "skipped", durationMs: 0, detail });
      out(`skip ${name} — ${detail}`);
    },
  };
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const indent =
  (out: (line: string) => void) =>
  (line: string): void =>
    out(`  ${line}`);

export async function upFactory(
  deps: UpDeps,
  options: UpOptions = {},
): Promise<UpResult> {
  const execFile = deps.execFile ?? nodeExecFile;
  const runner = stepRunner(deps.out);
  const result: UpResult = { ok: false, steps: runner.steps };

  try {
    const { factoryRoot, service } = await runner.run("locate", (note) => {
      const located = locate(deps.cwd);
      note(located.factoryRoot);
      return located;
    });
    result.factoryRoot = factoryRoot;
    result.serviceUrl = service.serviceUrl;
    result.dashboardUrl = service.dashboardUrl;
    const lifecycle: ServiceLifecycleDeps = {
      cwd: factoryRoot,
      out: indent(deps.out),
      processes: deps.processes,
    };

    const env = await runner.run("env", (note) => ensureEnv(factoryRoot, note));
    reportEmptyCredentials(env, deps.out);

    await runner.run("install", () =>
      exec(execFile, "pnpm", ["install"], { cwd: factoryRoot }, deps.out, {
        missing: new CliError(
          "pnpm is not on PATH",
          "install pnpm: https://pnpm.io/installation",
        ),
        failed: () =>
          new CliError(
            `pnpm install failed in ${factoryRoot}`,
            "the output above is pnpm's",
          ),
      }),
    );

    await runner.run("compose", () =>
      composeUp(execFile, factoryRoot, deps.out),
    );

    await runner.run("bootstrap", () =>
      bootstrapWorld(execFile, factoryRoot, env, deps.out),
    );

    await runner.run("build", () =>
      buildFactoryService({
        cwd: factoryRoot,
        out: indent(deps.out),
        execFile,
        prepare: deps.prepare,
      }),
    );

    // Compared against the bundle the running process started from, not the
    // one on disk before this build: a restart refused last time must still
    // be owed this time.
    result.service = await runner.run("service", async (note) => {
      if (liveServicePid(lifecycle) === undefined) {
        startService(lifecycle);
        return "started";
      }
      const unchanged =
        builtBundleHash(factoryRoot) === runningBundleHash(lifecycle);
      if (unchanged && options.restart !== true) {
        note("unchanged, not restarted");
        return "unchanged";
      }
      await confirmRestart(factoryRoot, service, deps, options);
      await restartService(lifecycle);
      return "restarted";
    });

    await runner.run("ready", () =>
      waitForReady(lifecycle, service, {
        timeoutMs: deps.readyTimeoutMs ?? READY_TIMEOUT_MS,
        pollMs: deps.pollMs ?? READY_POLL_MS,
      }),
    );

    if (options.doctor === false) {
      runner.skip("doctor", "--no-doctor");
    } else {
      await runner.run("doctor", async () => {
        try {
          await runDoctor({
            serviceUrl: service.serviceUrl,
            factoryRoot,
            out: indent(deps.out),
          });
        } catch (err) {
          if (err instanceof CliError && err.hint === undefined) {
            throw new CliError(
              err.message,
              "each failing check above names its own repair",
            );
          }
          throw err;
        }
      });
    }

    deps.out(
      `${service.slug} is up at ${service.serviceUrl} — dashboard ${service.dashboardUrl}`,
    );
    result.ok = true;
    return result;
  } catch (err) {
    if (err instanceof StepFailed) return result;
    throw err;
  }
}

function locate(cwd: string): {
  factoryRoot: string;
  service: ResolvedService;
} {
  const factoryRoot = locateFactoryRoot(cwd);
  const service = resolveService(factoryRoot);
  // The build's failure without it is nitro's, several steps and a pnpm
  // install later; naming the missing file here is cheaper for everyone.
  if (!existsSync(path.join(factoryRoot, FACTORY_CODE))) {
    throw new CliError(
      `no ${FACTORY_CODE} in ${factoryRoot}`,
      "scaffold it: jigs init writes jigs.config.ts, pipelines/ship.ts and steps/jigs.ts, and keeps every file already there",
    );
  }
  return { factoryRoot, service };
}

function ensureEnv(factoryRoot: string, note: Note): Record<string, string> {
  const dotenv = path.join(factoryRoot, ".env");
  if (!existsSync(dotenv)) {
    const example = path.join(factoryRoot, ".env.example");
    if (!existsSync(example)) {
      throw new CliError(
        `no .env or .env.example in ${factoryRoot}`,
        "scaffold one: jigs init",
      );
    }
    copyFileSync(example, dotenv);
    note("copied .env.example to .env");
  }
  return parseEnv(readFileSync(dotenv, "utf8")) as Record<string, string>;
}

function reportEmptyCredentials(
  env: Record<string, string>,
  out: (line: string) => void,
): void {
  const empty = CREDENTIAL_SLOTS.filter((key) => (env[key] ?? "") === "");
  if (empty.length === 0) return;
  out(
    `     ${empty.join(", ")} empty in .env — fill them in before a pipeline needs them`,
  );
}

interface ExecErrors {
  missing: CliError;
  failed: (err: ExecError) => CliError;
}

async function exec(
  execFile: ExecFile,
  file: string,
  args: string[],
  options: ExecOptions,
  out: (line: string) => void,
  errors: ExecErrors,
): Promise<void> {
  try {
    await execFile(file, args, options);
  } catch (err) {
    const failure = err as ExecError;
    if (failure.code === "ENOENT") throw errors.missing;
    for (const line of execOutput(failure).split("\n")) {
      if (line !== "") out(`  ${line}`);
    }
    throw errors.failed(failure);
  }
}

async function composeUp(
  execFile: ExecFile,
  factoryRoot: string,
  out: (line: string) => void,
): Promise<void> {
  if (!existsSync(path.join(factoryRoot, "docker-compose.yml"))) {
    throw new CliError(
      `no docker-compose.yml in ${factoryRoot}`,
      "scaffold one: jigs init",
    );
  }
  await exec(
    execFile,
    "docker",
    ["compose", "up", "-d", "--wait"],
    { cwd: factoryRoot },
    out,
    {
      missing: new CliError(
        "docker is not on PATH",
        "install docker and start its daemon",
      ),
      failed: (err) =>
        /Cannot connect to the Docker daemon/i.test(execOutput(err))
          ? new CliError("the docker daemon is not running", "start docker")
          : new CliError(
              `docker compose up failed in ${factoryRoot}`,
              "the output above is docker compose's",
            ),
    },
  );
}

// The World URL travels in the child's environment explicitly, never left to
// bootstrap's own .env lookup: unset, it silently migrates
// postgres://localhost:5432/world, which is nobody's factory.
async function bootstrapWorld(
  execFile: ExecFile,
  factoryRoot: string,
  env: Record<string, string>,
  out: (line: string) => void,
): Promise<void> {
  const url = env.WORKFLOW_POSTGRES_URL;
  if (url === undefined || url === "") {
    throw new CliError(
      "WORKFLOW_POSTGRES_URL is not set in .env",
      "set it to this factory's World — .env.example carries the shape",
    );
  }
  const bin = path.join(factoryRoot, "node_modules", ".bin", "bootstrap");
  if (!existsSync(bin)) {
    throw new CliError(
      `no bootstrap in ${path.dirname(bin)}`,
      "pnpm install did not install @workflow/world-postgres — add it to this factory's package.json",
    );
  }
  await exec(
    execFile,
    bin,
    [],
    {
      cwd: factoryRoot,
      env: { ...stringEnv(process.env), ...env, WORKFLOW_POSTGRES_URL: url },
    },
    out,
    {
      missing: new CliError(`${bin} is not executable`, "pnpm install again"),
      failed: (err) =>
        /ECONNREFUSED/.test(execOutput(err))
          ? new CliError(
              `bootstrap could not reach the World at ${redactPassword(url)}`,
              `docker-compose.yml publishes ${publishedPostgresPorts(factoryRoot)} — the two have to agree`,
            )
          : new CliError(
              "bootstrap failed",
              "the output above is @workflow/world-postgres's",
            ),
    },
  );
}

function redactPassword(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

function publishedPostgresPorts(factoryRoot: string): string {
  const compose = readFileSync(
    path.join(factoryRoot, "docker-compose.yml"),
    "utf8",
  );
  const ports = [...compose.matchAll(/"?(\d+):5432"?/g)].map((m) => m[1]);
  return ports.length === 0 ? "no port for 5432" : `:${ports.join(", :")}`;
}

// `jigs build` warns about runs in flight and proceeds; the restart is what
// actually cuts one off, so this is where the human is asked.
async function confirmRestart(
  factoryRoot: string,
  service: ResolvedService,
  deps: UpDeps,
  options: UpOptions,
): Promise<void> {
  if (options.force === true) return;
  const inFlight = await listRunsInFlight(factoryRoot);
  if (inFlight.length === 0) return;
  deps.out(`  ${inFlight.length} run(s) in flight — a restart cuts each off:`);
  for (const run of inFlight) {
    deps.out(`    ${run.runId}  ${run.pipeline}  ${run.status}`);
  }
  if (deps.confirm === undefined) {
    throw new CliError(
      `refusing to restart ${service.slug} over ${inFlight.length} run(s) in flight without confirmation`,
      "re-run with --force, or jigs cancel <run> first",
    );
  }
  const question = `restart ${service.slug} over ${inFlight.length} in-flight run(s)?`;
  if (!(await deps.confirm(question))) {
    throw new CliError(
      "restart declined — the service still runs the previous bundle",
      "re-run jigs up when the runs finish",
    );
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// "pid alive" is not "up": the service clones every binding before it
// listens, and one it cannot reach exits the process. So the pid is watched
// alongside the port, and a death is reported with the log that explains it.
async function waitForReady(
  lifecycle: ServiceLifecycleDeps,
  service: ResolvedService,
  timing: { timeoutMs: number; pollMs: number },
): Promise<void> {
  const deadline = Date.now() + timing.timeoutMs;
  while (true) {
    if (await healthy(service.serviceUrl)) return;
    if (liveServicePid(lifecycle) === undefined) {
      try {
        serviceLogs(lifecycle);
      } catch {
        // No log yet: the process died before writing one.
      }
      throw new CliError(
        "the service exited during boot",
        "its last log lines are above; jigs service logs for more",
      );
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        `the service is still booting after ${Math.round(timing.timeoutMs / 1000)}s`,
        "it clones every binding before it listens — jigs service logs to watch",
      );
    }
    await sleep(timing.pollMs);
  }
}

// Bounded so a socket that opens but never answers still lets the deadline
// speak, instead of holding `up` past it with nothing printed.
async function healthy(serviceUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
