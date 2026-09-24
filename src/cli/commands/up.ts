import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type LinearIdentity,
  type ResolvedService,
  readFactoryConfig,
  resolveService,
} from "../../config/factory-config.ts";
import { readFactoryEnv } from "../../config/factory-env.ts";
import { locateFactoryRoot } from "../../config/factory-root.ts";
import { JigsError } from "../../errors.ts";
import { LINEAR_IDENTITY_VARIABLES } from "../../providers/linear-auth.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { stringEnv } from "../../steps/agents/harnesses/env.ts";
import { type ExecFile, execOrExplain, execOutput, nodeExecFile } from "../exec.ts";
import { buildFactoryService, type Prepare } from "./build.ts";
import { dockerCompose } from "./compose.ts";
import { runDoctor } from "./doctor.ts";
import { type RunListRun, showRuns } from "./run-list.ts";
import { resolveServiceUrl } from "./service-client.ts";
import {
  awaitServiceReady,
  builtBundleHash,
  liveServicePid,
  restartService,
  runningBundleHash,
  type ServiceLifecycleDeps,
  type ServiceProcesses,
  serviceLogPath,
  startService,
} from "./service-lifecycle.ts";
import { indent, type Step, StepFailed, stepRunner } from "./step-runner.ts";

// Takes a factory from any state to a running service: the commands a human
// used to type after `jigs init`, run in order. Each step is idempotent, so a
// second `up` on an unchanged factory installs, migrates and restarts
// nothing.

export type UpStepName =
  | "locate"
  | "env"
  | "install"
  | "generate"
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
  generate?: () => Promise<void>;
  migrate?: (url: string) => Promise<void>;
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
const credentialSlots = (linear: LinearIdentity): string[] => [
  ...LINEAR_IDENTITY_VARIABLES[linear.mode],
  "GITHUB_TOKEN",
];

export async function upFactory(deps: UpDeps, options: UpOptions = {}): Promise<UpResult> {
  const execFile = deps.execFile ?? nodeExecFile;
  const runner = stepRunner<UpStepName>(deps.out);
  const result: UpResult = { ok: false, steps: runner.steps };

  try {
    const { factoryRoot, service, linear } = await runner.run("locate", (note) => {
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

    const env = await runner.run("env", () => ensureEnv(factoryRoot));
    reportEmptyCredentials(env, credentialSlots(linear), deps.out);

    await runner.run("install", () =>
      execOrExplain(execFile, "pnpm", ["install"], { cwd: factoryRoot }, deps.out, {
        missing: new JigsError("pnpm is not on PATH", "install pnpm: https://pnpm.io/installation"),
        failed: () =>
          new JigsError(`pnpm install failed in ${factoryRoot}`, "the output above is pnpm's"),
      }),
    );

    if (deps.generate !== undefined) {
      await runner.run("generate", deps.generate);
    }

    await runner.run("compose", () =>
      dockerCompose(execFile, factoryRoot, ["up", "-d", "--wait"], deps.out),
    );

    await runner.run("bootstrap", async () => {
      const url = await bootstrapWorld(execFile, factoryRoot, env, deps.out);
      const migrate =
        deps.migrate ?? (await import("../../steps/workspaces/registry.ts")).migrateRegistry;
      await migrate(url);
    });

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
      const unchanged = builtBundleHash(factoryRoot) === runningBundleHash(lifecycle);
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
            throw new JigsError(err.message, "each failing check above names its own repair");
          }
          throw err;
        }
      });
    }

    printSummary(factoryRoot, service, liveServicePid(lifecycle), deps.out);
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
  linear: LinearIdentity;
} {
  const factoryRoot = locateFactoryRoot(cwd);
  const service = resolveService(factoryRoot);
  return { factoryRoot, service, linear: readFactoryConfig(factoryRoot).linear.identity };
}

// Never copied for the operator: a .env is where they decide which
// credentials this factory holds.
function ensureEnv(factoryRoot: string): Record<string, string> {
  if (!existsSync(path.join(factoryRoot, ".env"))) {
    if (!existsSync(path.join(factoryRoot, ".env.example"))) {
      throw new JigsError(
        `no .env or .env.example in ${factoryRoot}`,
        "scaffold one: pnpm exec jigs init",
      );
    }
    throw new JigsError(
      `no .env in ${factoryRoot} — copy .env.example, then fill in what your workflows need`,
      "cp .env.example .env",
    );
  }
  return readFactoryEnv(factoryRoot);
}

function reportEmptyCredentials(
  env: Record<string, string>,
  slots: string[],
  out: (line: string) => void,
): void {
  const empty = slots.filter((key) => (env[key] ?? "") === "");
  if (empty.length === 0) return;
  out(`     ${empty.join(", ")} empty in .env — fill them in before a workflow needs them`);
}

// The World URL travels in the child's environment explicitly, never left to
// bootstrap's own .env lookup: unset, it silently migrates
// postgres://localhost:5432/world, which is nobody's factory.
async function bootstrapWorld(
  execFile: ExecFile,
  factoryRoot: string,
  env: Record<string, string>,
  out: (line: string) => void,
): Promise<string> {
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
          : new JigsError("bootstrap failed", "the output above is @workflow/world-postgres's"),
    },
  );
  return url;
}

// One Postgres container and one Node process, which also serves the
// dashboard on its second port: every running thing and how to stop it.
function printSummary(
  factoryRoot: string,
  service: ResolvedService,
  pid: number | undefined,
  out: (line: string) => void,
): void {
  const project = composeProjectName(factoryRoot);
  const ports = postgresPorts(factoryRoot);
  const rows: Array<[string, string, string]> = [
    [
      "postgres",
      `docker compose${project === undefined ? "" : ` project ${project}`}, ${ports.length === 0 ? "no published port" : `port ${ports.join(", ")}`}`,
      "stop: docker compose down",
    ],
    [
      "service",
      `${service.serviceUrl}  pid ${pid ?? "unknown"}`,
      "stop: pnpm exec jigs service stop",
    ],
    ["", `dashboard ${service.dashboardUrl}`, `logs ${homeRelative(serviceLogPath(service.slug))}`],
  ];
  const width = Math.max(...rows.map(([, what]) => what.length)) + 4;
  out(`${service.slug} is up`);
  for (const [name, what, how] of rows) out(`  ${name.padEnd(11)}${what.padEnd(width)}${how}`);
  out("  stop everything: pnpm exec jigs down");
}

function homeRelative(file: string): string {
  const home = homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

function composeProjectName(factoryRoot: string): string | undefined {
  const compose = readFileSync(path.join(factoryRoot, "docker-compose.yml"), "utf8");
  return compose.match(/^name:\s*["']?([^"'\s#]+)/m)?.[1];
}

function redactPassword(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

function postgresPorts(factoryRoot: string): string[] {
  const compose = readFileSync(path.join(factoryRoot, "docker-compose.yml"), "utf8");
  return [...compose.matchAll(/"?(\d+):5432"?/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

function publishedPostgresPorts(factoryRoot: string): string {
  const ports = postgresPorts(factoryRoot);
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
      "re-run with --force, or pnpm exec jigs cancel <run-id> first",
    );
  }
  const question = `restart ${service.slug} over ${inFlight.length} in-flight run(s)?`;
  if (!(await deps.confirm(question))) {
    throw new JigsError(
      "restart declined — the service still runs the previous bundle",
      "re-run pnpm exec jigs up when the runs finish",
    );
  }
}

// Empty when the service is unreachable: a service nobody can reach is
// holding no run this restart could cut off.
async function listRunsInFlight(factoryRoot: string): Promise<RunListRun[]> {
  let runs: RunListRun[];
  try {
    // `jigs status` already knows how to find them; it prints, so it is handed a
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
