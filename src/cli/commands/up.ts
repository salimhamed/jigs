import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type ResolvedService,
  resolveService,
} from "../../config/factory-config.ts";
import { readFactoryEnv } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { stringEnv } from "../../steps/agent/harnesses/env.ts";
import {
  type ExecFile,
  execOrExplain,
  execOutput,
  nodeExecFile,
} from "../exec.ts";
import { buildFactoryService, type Prepare } from "./build.ts";
import { runDoctor } from "./doctor.ts";
import { type PsRun, showRuns } from "./ps.ts";
import { resolveServiceUrl } from "./service-client.ts";
import {
  awaitServiceReady,
  builtBundleHash,
  liveServicePid,
  restartService,
  runningBundleHash,
  type ServiceLifecycleDeps,
  type ServiceProcesses,
  startService,
} from "./service-lifecycle.ts";
import {
  indent,
  type Note,
  type Step,
  StepFailed,
  stepRunner,
} from "./step-runner.ts";

// Takes a factory from any state to a running service: the commands a human
// used to type after `jigs init`, run in order. Each step is idempotent, so a
// second `up` on an unchanged factory copies, installs, migrates and restarts
// nothing.

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

export type UpStep = Step<UpStepName>;

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
}

export interface UpOptions {
  restart?: boolean;
  force?: boolean;
  doctor?: boolean;
}

// Read by the suspension primitives; empty slots are the expected state of a
// freshly copied .env, so they are reported, not refused.
const CREDENTIAL_SLOTS = ["LINEAR_API_KEY", "GITHUB_TOKEN"];

export async function upFactory(
  deps: UpDeps,
  options: UpOptions = {},
): Promise<UpResult> {
  const execFile = deps.execFile ?? nodeExecFile;
  const runner = stepRunner<UpStepName>(deps.out);
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
      startTimeoutMs: deps.readyTimeoutMs,
    };

    const env = await runner.run("env", (note) => ensureEnv(factoryRoot, note));
    reportEmptyCredentials(env, deps.out);

    await runner.run("install", () =>
      execOrExplain(
        execFile,
        "pnpm",
        ["install"],
        { cwd: factoryRoot },
        deps.out,
        {
          missing: new JigsError(
            "pnpm is not on PATH",
            "install pnpm: https://pnpm.io/installation",
          ),
          failed: () =>
            new JigsError(
              `pnpm install failed in ${factoryRoot}`,
              "the output above is pnpm's",
            ),
        },
      ),
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
    // be owed this time. The spawn and the wait are two steps here, so each
    // gets its own line and its own failure; the wait itself is the
    // lifecycle module's, the one `jigs service start` does.
    result.service = await runner.run("service", async (note) => {
      if (liveServicePid(lifecycle) === undefined) {
        await startService(lifecycle, { awaitReady: false });
        return "started";
      }
      const unchanged =
        builtBundleHash(factoryRoot) === runningBundleHash(lifecycle);
      if (unchanged && options.restart !== true) {
        note("unchanged, not restarted");
        return "unchanged";
      }
      await confirmRestart(factoryRoot, service, deps, options);
      await restartService(lifecycle, { awaitReady: false });
      return "restarted";
    });

    await runner.run("ready", () => awaitServiceReady(lifecycle));

    if (options.doctor === false) {
      runner.skip("doctor", "--no-doctor");
    } else {
      await runner.run("doctor", async () => {
        try {
          await runDoctor({
            serviceUrl: service.serviceUrl,
            out: indent(deps.out),
          });
        } catch (err) {
          if (err instanceof JigsError && err.hint === undefined) {
            throw new JigsError(
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
  return { factoryRoot, service };
}

function ensureEnv(factoryRoot: string, note: Note): Record<string, string> {
  const dotenv = path.join(factoryRoot, ".env");
  if (!existsSync(dotenv)) {
    const example = path.join(factoryRoot, ".env.example");
    if (!existsSync(example)) {
      throw new JigsError(
        `no .env or .env.example in ${factoryRoot}`,
        "scaffold one: jigs init",
      );
    }
    copyFileSync(example, dotenv);
    note("copied .env.example to .env");
  }
  return readFactoryEnv(factoryRoot);
}

function reportEmptyCredentials(
  env: Record<string, string>,
  out: (line: string) => void,
): void {
  const empty = CREDENTIAL_SLOTS.filter((key) => (env[key] ?? "") === "");
  if (empty.length === 0) return;
  out(
    `     ${empty.join(", ")} empty in .env — fill them in before a workflow needs them`,
  );
}

async function composeUp(
  execFile: ExecFile,
  factoryRoot: string,
  out: (line: string) => void,
): Promise<void> {
  if (!existsSync(path.join(factoryRoot, "docker-compose.yml"))) {
    throw new JigsError(
      `no docker-compose.yml in ${factoryRoot}`,
      "scaffold one: jigs init",
    );
  }
  await execOrExplain(
    execFile,
    "docker",
    ["compose", "up", "-d", "--wait"],
    { cwd: factoryRoot },
    out,
    {
      missing: new JigsError(
        "docker is not on PATH",
        "install docker and start its daemon",
      ),
      failed: (err) =>
        /Cannot connect to the Docker daemon/i.test(execOutput(err))
          ? new JigsError("the docker daemon is not running", "start docker")
          : new JigsError(
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
    throw new JigsError(
      "WORKFLOW_POSTGRES_URL is not set in .env",
      "set it to this factory's World — .env.example carries the shape",
    );
  }
  const bin = path.join(factoryRoot, "node_modules", ".bin", "bootstrap");
  if (!existsSync(bin)) {
    throw new JigsError(
      `no bootstrap in ${path.dirname(bin)}`,
      "pnpm install did not install @workflow/world-postgres — add it to this factory's package.json",
    );
  }
  await execOrExplain(
    execFile,
    bin,
    [],
    {
      cwd: factoryRoot,
      env: { ...stringEnv(process.env), ...env, WORKFLOW_POSTGRES_URL: url },
    },
    out,
    {
      missing: new JigsError(`${bin} is not executable`, "pnpm install again"),
      failed: (err) =>
        /ECONNREFUSED/.test(execOutput(err))
          ? new JigsError(
              `bootstrap could not reach the World at ${redactPassword(url)}`,
              `docker-compose.yml publishes ${publishedPostgresPorts(factoryRoot)} — the two have to agree`,
            )
          : new JigsError(
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
    deps.out(`    ${run.runId}  ${run.workflow}  ${run.status}`);
  }
  if (deps.confirm === undefined) {
    throw new JigsError(
      `refusing to restart ${service.slug} over ${inFlight.length} run(s) in flight without confirmation`,
      "re-run with --force, or jigs cancel <run> first",
    );
  }
  const question = `restart ${service.slug} over ${inFlight.length} in-flight run(s)?`;
  if (!(await deps.confirm(question))) {
    throw new JigsError(
      "restart declined — the service still runs the previous bundle",
      "re-run jigs up when the runs finish",
    );
  }
}

// Empty when the service is unreachable: a service nobody can reach is
// holding no run this restart could cut off.
async function listRunsInFlight(factoryRoot: string): Promise<PsRun[]> {
  let runs: PsRun[];
  try {
    // `jigs ps` already knows how to find them; it prints, so it is handed a
    // sink and read for its return value.
    ({ runs } = await showRuns({
      serviceUrl: resolveServiceUrl(factoryRoot),
      out: () => {},
    }));
  } catch {
    return [];
  }
  return runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
}
